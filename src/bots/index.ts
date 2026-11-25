/** Baseline decision makers and the common interface used by the simulator and later search bots. */
import {
  CONFIG,
  Good,
  Card,
  Building,
  GOOD_COUNT,
  CARD_COUNT,
  legalActions,
  cloneState,
  apply,
  renown,
  marketPrice,
  nextRandom,
  seedValue,
  shuffle,
  type Board,
  type GameState,
  type Action,
} from '../engine/index.js';
export interface Bot {
  readonly name: string;
  chooseAction(board: Board, state: GameState, player: number): Action;
}
/** Uniform legal-action baseline with a private stream that never changes the game position. */
export class RandomBot implements Bot {
  readonly name = 'random';
  private random: { rng: number };
  constructor(seed: number | string = 0) {
    this.random = { rng: seedValue(seed) };
  }
  /** Choose uniformly from the enumerated actions; this baseline never proposes a trade. */
  chooseAction(board: Board, state: GameState, _player: number): Action {
    const actions = legalActions(board, state);
    if (!actions.length) throw new Error('No decision in a finished game');
    return actions[Math.floor(nextRandom(this.random) * actions.length)];
  }
}
function vertexValue(board: Board, state: GameState, v: number, p: number): number {
  const vertex = board.vertices[v];
  let value = vertex.shrine ? CONFIG.renown.shrine * 3 : 0;
  if (vertex.harbour) value += 2;
  for (const h of vertex.hexes) {
    const hex = board.hexes[h];
    if (hex.good >= 0)
      value +=
        hex.pips *
        (state.hands[p * GOOD_COUNT + hex.good] < CONFIG.costs.steading[hex.good] ? 1.2 : 1);
  }
  return value;
}
function openVertices(board: Board, state: GameState): number[] {
  return board.vertices
    .filter(
      (v) => state.vertexOwner[v.id] < 0 && v.neighbours.every((n) => state.vertexOwner[n] < 0),
    )
    .map((v) => v.id);
}
function trackValues(
  board: Board,
  state: GameState,
  edges: number[],
  p: number,
): Map<number, number> {
  const network = board.vertices.filter(
    (n) => n.edges.some((edge) => state.edgeOwner[edge] === p) || state.vertexOwner[n.id] === p,
  );
  const targets = openVertices(board, state).map((v) => ({
    id: v,
    value: vertexValue(board, state, v, p),
    distance: Math.min(...network.map((n) => board.distances[n.id][v])),
  }));
  return new Map(
    edges.map((e) => {
      let best = -Infinity;
      for (const target of targets) {
        const ends = board.edges[e].vertices;
        const distance = Math.min(
          board.distances[ends[0]][target.id],
          board.distances[ends[1]][target.id],
        );
        if (distance < target.distance) best = Math.max(best, target.value / (distance + 1));
      }
      return [e, best];
    }),
  );
}
function targetCost(board: Board, state: GameState, p: number): readonly number[] {
  const owned = board.vertices.filter((v) => state.vertexOwner[v.id] === p);
  const choices: (readonly number[])[] = [];
  if (owned.some((v) => state.vertexKind[v.id] === Building.Steading))
    choices.push(CONFIG.costs.town);
  if (owned.some((v) => state.vertexKind[v.id] === Building.Town))
    choices.push(CONFIG.costs.citadel);
  if (
    openVertices(board, state).some((v) =>
      board.vertices[v].edges.some((e) => state.edgeOwner[e] === p),
    )
  )
    choices.push(CONFIG.costs.steading);
  if (state.edgeOwner.filter((x) => x === p).length < CONFIG.pieces.track)
    choices.push(CONFIG.costs.track);
  if (state.rowCount) choices.push(CONFIG.costs.card);
  const deficit = (cost: readonly number[]) =>
    cost.reduce((sum, n, g) => sum + Math.max(0, n - state.hands[p * GOOD_COUNT + g]), 0);
  return (
    choices.filter((c) => deficit(c) > 0).sort((a, b) => deficit(a) - deficit(b))[0] ??
    CONFIG.costs.card
  );
}
/** A transparent priority baseline for balance measurements, deliberately without a search tree. */
export class GreedyBot implements Bot {
  readonly name = 'greedy';
  private random: { rng: number };
  constructor(seed: number | string = 0) {
    this.random = { rng: seedValue(seed) };
  }
  /** Prioritize immediate Renown, development, useful market purchases, and then end the turn. */
  chooseAction(board: Board, state: GameState, p: number): Action {
    // All later stable sorts, first-match win scans, and direct choices inherit
    // this private random order, including equally attractive plunder victims.
    const actions = shuffle(this.random, legalActions(board, state));
    if (!actions.length) throw new Error('No decision in a finished game');
    const byType = (type: Action['type']) => actions.filter((a) => a.type === type);
    const best = (items: Action[], score: (a: Action) => number) =>
      items.sort((a, b) => score(b) - score(a))[0];
    if (state.phase === 'setupSteading')
      return best(actions, (a) =>
        a.type === 'placeSteading' ? vertexValue(board, state, a.v, p) : 0,
      );
    if (state.phase === 'setupTrack' || state.phase === 'surveyors') {
      const tracks = actions.filter((a) => a.type === 'placeTrack' || a.type === 'freeTrack');
      const scores = trackValues(
        board,
        state,
        tracks.map((a) => ('e' in a ? a.e : 0)),
        p,
      );
      return tracks.length ? best(tracks, (a) => ('e' in a ? scores.get(a.e)! : 0)) : actions[0];
    }
    if (state.phase === 'discard')
      return best(actions, (a) =>
        a.type === 'discard'
          ? state.hands[p * GOOD_COUNT + a.good] -
            CONFIG.costs.town[a.good] -
            CONFIG.costs.steading[a.good]
          : 0,
      );
    if (state.phase === 'moveWarband')
      return best(actions, (a) =>
        a.type === 'moveWarband'
          ? board.hexes[a.hex].vertices.reduce((score, v) => {
              const owner = state.vertexOwner[v];
              return (
                score +
                (owner < 0 || state.vertexKind[v] === Building.Citadel
                  ? 0
                  : owner === p
                    ? -board.hexes[a.hex].pips * 2
                    : board.hexes[a.hex].pips + renown(board, state, owner) / CONFIG.renown.target)
              );
            }, 0)
          : 0,
      );
    if (state.phase === 'plunder') {
      const cost = targetCost(board, state, p);
      return best(actions, (a) =>
        a.type === 'plunder'
          ? 1 + Math.max(0, cost[a.good] - state.hands[p * GOOD_COUNT + a.good])
          : 0,
      );
    }
    if (state.phase === 'tradeResponse')
      return {
        type: 'respondTrade',
        accept:
          state.tradeGet.reduce((sum, n) => sum + n, 0) <=
          state.tradeGive.reduce((sum, n) => sum + n, 0),
      };
    if (state.phase !== 'main') return actions[0];
    const wins = actions.filter(
      (a) =>
        a.type === 'upgrade' ||
        a.type === 'buildSteading' ||
        a.type === 'buyCard' ||
        a.type === 'muster' ||
        (a.type === 'playCard' && a.card === Card.Raid),
    );
    for (const a of wins) {
      const copy = cloneState(state);
      apply(board, copy, a);
      if (copy.winnerId === p) return a;
    }
    const upgrade = byType('upgrade')[0];
    if (upgrade) return upgrade;
    const steading = best(byType('buildSteading'), (a) =>
      a.type === 'buildSteading' ? vertexValue(board, state, a.v, p) : 0,
    );
    if (steading) return steading;
    const tracks = byType('buildTrack');
    const scores = trackValues(
      board,
      state,
      tracks.map((a) => ('e' in a ? a.e : 0)),
      p,
    );
    const track = best(tracks, (a) => (a.type === 'buildTrack' ? scores.get(a.e)! : 0));
    if (track && track.type === 'buildTrack' && scores.get(track.e)! > -Infinity) return track;
    const buy = best(byType('buyCard'), (a) =>
      a.type === 'buyCard'
        ? state.row[a.slot] === Card.Monument
          ? 10
          : state.row[a.slot] === Card.Caravan
            ? 5
            : 1
        : 0,
    );
    if (buy) return buy;
    const cost = targetCost(board, state, p);
    const plays = byType('playCard');
    const play = best(plays, (a) => {
      if (a.type !== 'playCard') return 0;
      if (a.card === Card.Caravan) {
        const hand = Array.from(state.hands.subarray(p * GOOD_COUNT, (p + 1) * GOOD_COUNT));
        let n = 1;
        for (const good of a.goods) {
          if (hand[good] < cost[good]) n += 4;
          hand[good]++;
        }
        return n;
      }
      if (a.card === Card.Tithe)
        return (
          1 +
          Array.from({ length: state.players }, (_, q) =>
            q === p ? 0 : Math.min(CONFIG.cards.titheGoods, state.hands[q * GOOD_COUNT + a.good]),
          ).reduce((a, b) => a + b, 0)
        );
      return 1;
    });
    if (play) return play;
    const market = best(
      byType('marketBuy').filter(
        (a) =>
          a.type === 'marketBuy' &&
          state.hands[p * GOOD_COUNT + a.get] < cost[a.get] &&
          state.hands[p * GOOD_COUNT + a.pay] - marketPrice(board, state, p, a.get) >= cost[a.pay],
      ),
      (a) => (a.type === 'marketBuy' ? state.hands[p * GOOD_COUNT + a.pay] - cost[a.pay] : 0),
    );
    if (market) return market;
    const muster = byType('muster')[0];
    if (muster && state.musters[p] < CONFIG.warlord.minimum) return muster;
    return { type: 'endTurn' };
  }
}
/** Construct a named baseline with a separate random stream for each simulation player. */
export function createBot(name: string, seed: number | string = 0): Bot {
  if (name === 'random') return new RandomBot(seed);
  if (name === 'greedy') return new GreedyBot(seed);
  throw new Error(`Unknown bot: ${name}`);
}
