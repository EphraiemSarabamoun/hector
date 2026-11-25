/** Exact and symmetry checks for public-position features and the shared-player model. */
import { describe, expect, it } from 'vitest';
import {
  allFeatures,
  expectedProduction,
  features,
  FEATURE_NAMES,
  withHandFeatures,
} from '../src/ai/features.js';
import { evaluate, FITTED_WEIGHTS, probabilitiesFromFeatures, W0 } from '../src/ai/value.js';
import {
  Building,
  Card,
  CARD_COUNT,
  cloneState,
  createState,
  generateBoard,
  GOOD_COUNT,
  type Board,
  type GameState,
} from '../src/engine/index.js';

const board = generateBoard('ai-feature-contract');
function stateFor(map: Board = board): GameState {
  const state = createState(map, 'feature-position');
  state.phase = 'main';
  state.turn = 1;
  state.active = 0;
  state.toAct = 0;
  state.turnOrder.set([0, 1, 2]);
  return state;
}
function entry(
  state: GameState,
  name: (typeof FEATURE_NAMES)[number],
  player = 0,
  map: Board = board,
): number {
  return features(map, state, player)[FEATURE_NAMES.indexOf(name)];
}
function put(state: GameState, v: number, player: number, kind = Building.Steading): void {
  state.vertexOwner[v] = player;
  state.vertexKind[v] = kind;
}
/** A short edge graph makes exact path lengths and rival blocking transparent. */
function corridor(): Board {
  const count = 9;
  return {
    seed: 'corridor',
    initialWarband: 0,
    generation: board.generation,
    hexes: [
      {
        id: 0,
        q: 0,
        r: 0,
        terrain: 5,
        good: -1,
        number: 0,
        pips: 0,
        vertices: [0, 1, 2, 3, 4, 5],
        neighbours: [],
      },
    ],
    vertices: Array.from({ length: count }, (_, id) => ({
      id,
      hexes: id < 6 ? [0] : [],
      neighbours: [id - 1, id + 1].filter((n) => n >= 0 && n < count),
      edges: [id - 1, id].filter((e) => e >= 0 && e < count - 1),
      coastal: true,
      shrine: id === 6,
      harbour: false,
      x: id,
      y: 0,
    })),
    edges: Array.from({ length: count - 1 }, (_, id) => ({
      id,
      vertices: [id, id + 1] as const,
      neighbours: [id - 1, id + 1].filter((e) => e >= 0 && e < count - 1),
    })),
    distances: Array.from({ length: count }, (_, a) =>
      Array.from({ length: count }, (_, b) => Math.abs(a - b)),
    ),
  };
}

describe('public-position features', () => {
  it('refreshes only hand features exactly across market, harbour, storage and player variations', () => {
    const harbour = board.vertices.find((v) => v.harbour)!.id;
    for (const held of [false, true])
      for (const granaries of [0, 2])
        for (let stock = 0; stock <= 4; stock++) {
          const state = stateFor();
          state.market.fill(stock);
          if (held) put(state, harbour, 0);
          for (let player = 0; player < state.players; player++) {
            state.cards[player * CARD_COUNT + Card.Granary] = granaries;
            const source = Object.freeze(features(board, state, player));
            for (let sample = 0; sample < 8; sample++) {
              const hand = Object.freeze(
                Array.from({ length: GOOD_COUNT }, (_, g) => (sample * 3 + g * 2 + player) % 10),
              );
              const changed = cloneState(state);
              changed.hands.set(hand, player * GOOD_COUNT);
              expect(withHandFeatures(source, state, player, hand)).toEqual(
                features(board, changed, player),
              );
            }
          }
        }
  });
  it('has a fixed 49-entry schema and exact natural-unit empty-position values', () => {
    const state = stateFor();
    expect(FEATURE_NAMES).toHaveLength(49);
    expect(new Set(FEATURE_NAMES).size).toBe(49);
    expect(features(board, state, 0)).toEqual([
      0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 4, 5, 6, 3, 2, 0, 0, 16, 0, 0, 15,
      5, 4, 2, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0,
    ]);
    expect(allFeatures(board, state)).toEqual([0, 1, 2].map((p) => features(board, state, p)));
  });
  it('computes expected production from pips, building yield and Citadel-only blockade immunity', () => {
    const state = stateFor();
    const hex = board.hexes.find((h) => h.good >= 0)!;
    put(state, hex.vertices[0], 0);
    put(state, hex.vertices[1], 1, Building.Town);
    put(state, hex.vertices[2], 2, Building.Citadel);
    function expected(player: number): number[] {
      const result = [0, 0, 0, 0, 0];
      for (const h of board.hexes)
        if (h.good >= 0)
          for (const v of h.vertices) {
            if (
              state.vertexOwner[v] !== player ||
              (h.id === state.warband && state.vertexKind[v] !== Building.Citadel)
            )
              continue;
            result[h.good] += (h.pips / 36) * (state.vertexKind[v] === Building.Steading ? 1 : 2);
          }
      return result;
    }
    for (const p of [0, 1, 2]) expect(expectedProduction(board, state, p)).toEqual(expected(p));
    const before = [0, 1, 2].map((p) => expectedProduction(board, state, p));
    state.warband = hex.id;
    for (const p of [0, 1, 2]) {
      const actual = expectedProduction(board, state, p);
      expect(actual).toEqual(expected(p));
      expect(before[p][hex.good] - actual[hex.good]).toBeCloseTo(
        p === 0 ? hex.pips / 36 : p === 1 ? (2 * hex.pips) / 36 : 0,
      );
      expect(entry(state, 'warbandOnOwnHex', p)).toBe(1);
    }
  });
  it('summarizes production total, diversity and minimum over all five goods', () => {
    const state = stateFor();
    for (const hex of board.hexes.filter((h) => h.good >= 0)) put(state, hex.vertices[0], 0);
    const production = expectedProduction(board, state, 0);
    expect(entry(state, 'productionTotal')).toBeCloseTo(production.reduce((a, b) => a + b, 0));
    expect(entry(state, 'productionDiversity')).toBe(production.filter((n) => n > 0).length);
    expect(entry(state, 'productionMinimum')).toBe(Math.min(...production));
  });
  it('counts hands and Granary storage excess exactly', () => {
    const state = stateFor();
    state.hands.set([1, 2, 3, 4, 5]);
    state.cards[Card.Granary] = 1;
    const f = features(board, state, 0);
    expect(f.slice(11, 18)).toEqual([1, 2, 3, 4, 5, 15, 3]);
  });
  it('uses the best affordable direct-market route and its harbour discount', () => {
    const state = stateFor();
    state.hands[0] = 9;
    expect(entry(state, 'deficitTown')).toBe(2);
    put(state, board.vertices.find((v) => v.harbour)!.id, 0);
    expect(entry(state, 'deficitTown')).toBe(1);
  });
  it('does not combine different payment goods for a single purchase or buy unavailable stock', () => {
    const state = stateFor();
    state.hands.set([2, 2, 0, 0, 0]);
    expect(entry(state, 'deficitTown')).toBe(5);
    state.hands.set([8, 0, 0, 0, 0]);
    state.market.set([3, 3, 1, 0, 0]);
    expect(entry(state, 'deficitTown')).toBe(4);
  });
  it('preserves build-reserved goods rather than pretending they can also pay for deficits', () => {
    const state = stateFor();
    state.hands.set([1, 1, 0, 0, 1]);
    expect(entry(state, 'deficitSteading')).toBe(1);
    state.hands.set([1, 1, 1, 0, 1]);
    expect(entry(state, 'deficitSteading')).toBe(0);
  });
  it('finds exact new-Track distances, immediate open sites and the nearest free shrine', () => {
    const map = corridor(),
      state = stateFor(map);
    put(state, 0, 0);
    expect(entry(state, 'tracksToOpenSite', 0, map)).toBe(2);
    expect(entry(state, 'tracksToFreeShrine', 0, map)).toBe(6);
    expect(entry(state, 'reachableSteadingSites', 0, map)).toBe(0);
    state.edgeOwner[0] = 0;
    state.edgeOwner[1] = 0;
    expect(entry(state, 'tracksToOpenSite', 0, map)).toBe(0);
    expect(entry(state, 'tracksToFreeShrine', 0, map)).toBe(4);
    expect(entry(state, 'reachableSteadingSites', 0, map)).toBe(1);
    put(state, 3, 1);
    expect(entry(state, 'tracksToOpenSite', 0, map)).toBe(16);
    expect(entry(state, 'tracksToFreeShrine', 0, map)).toBe(16);
    expect(entry(state, 'reachableSteadingSites', 0, map)).toBe(0);
  });
  it('rival Tracks block paths and upgrades return piece supply', () => {
    const map = corridor(),
      state = stateFor(map);
    put(state, 0, 0);
    state.edgeOwner[1] = 1;
    expect(entry(state, 'tracksToFreeShrine', 0, map)).toBe(16);
    state.edgeOwner[1] = 0;
    state.vertexKind[0] = Building.Town;
    expect(entry(state, 'steadingsLeft', 0, map)).toBe(5);
    expect(entry(state, 'townsLeft', 0, map)).toBe(3);
    expect(entry(state, 'townUpgrades', 0, map)).toBe(1);
  });
  it('reports the best immediately connected site pips', () => {
    const state = stateFor();
    const v = board.vertices.find((v) => v.hexes.length > 1)!;
    state.edgeOwner[v.edges[0]] = 0;
    const endpoints = board.edges[v.edges[0]].vertices;
    const pips = Math.max(
      ...endpoints.map((id) =>
        board.vertices[id].hexes.reduce((n, h) => n + board.hexes[h].pips, 0),
      ),
    );
    expect(entry(state, 'bestReachableSitePips')).toBe(pips);
    expect(entry(state, 'reachableSteadingSites')).toBe(2);
  });
  it('tracks shrines, harbour, mature play cards and permanent cards', () => {
    const state = stateFor();
    put(state, board.vertices.find((v) => v.shrine)!.id, 0);
    put(state, board.vertices.find((v) => v.harbour)!.id, 0, Building.Town);
    state.cards.set([2, 3, 1, 4, 2, 1]);
    state.freshCards.set([1, 1, 1, 0, 0, 0]);
    expect(entry(state, 'harbourHeld')).toBe(1);
    expect(entry(state, 'shrinesHeld')).toBe(1);
    expect(features(board, state, 0).slice(36, 42)).toEqual([1, 2, 0, 4, 2, 1]);
    expect(entry(state, 'renown')).toBe(6);
  });
  it('reports winning distance, own turn, strongest rival and Warlord lead without ID tie bias', () => {
    const state = stateFor();
    state.cards[Card.Monument] = 8;
    state.cards[CARD_COUNT + Card.Monument] = 9;
    state.cards[2 * CARD_COUNT + Card.Monument] = 7;
    state.musters.set([4, 3, 2]);
    state.warlord = 0;
    expect(entry(state, 'renown')).toBe(10);
    expect(entry(state, 'distanceToWin')).toBe(2);
    expect(entry(state, 'withinTwoOfWinning')).toBe(1);
    expect(entry(state, 'musters')).toBe(4);
    expect(entry(state, 'warlordHeld')).toBe(1);
    expect(entry(state, 'musterLead')).toBe(1);
    expect(entry(state, 'activePlayer')).toBe(1);
    expect(entry(state, 'strongestOpponentRenown')).toBe(9);
    expect(entry(state, 'renownLead')).toBe(1);
  });
  it('never reads hidden deck order or advances the RNG', () => {
    const state = stateFor(),
      other = cloneState(state);
    other.deck.reverse();
    other.rng = 1;
    const before = state.rng;
    expect(allFeatures(board, state)).toEqual(allFeatures(board, other));
    expect(evaluate(board, state)).toEqual(evaluate(board, other));
    expect(state.rng).toBe(before);
  });
});

describe('shared-player softmax value', () => {
  it('has finite baseline and fitted coefficients matching the feature schema', () => {
    expect(W0).toHaveLength(FEATURE_NAMES.length);
    expect(W0.every(Number.isFinite)).toBe(true);
    expect(FITTED_WEIGHTS).toHaveLength(FEATURE_NAMES.length);
    expect(FITTED_WEIGHTS.every(Number.isFinite)).toBe(true);
  });
  it('computes stable probabilities for readonly rows and large logits', () => {
    expect(probabilitiesFromFeatures([[10000], [10000], [10000]] as const, [1])).toEqual([
      1 / 3,
      1 / 3,
      1 / 3,
    ]);
    const actual = probabilitiesFromFeatures([[0], [1], [2]], [1]);
    expect(actual.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(actual[2] / actual[1]).toBeCloseTo(Math.E);
    expect(actual[1] / actual[0]).toBeCloseTo(Math.E);
    expect(probabilitiesFromFeatures([], W0)).toEqual([]);
    expect(() => probabilitiesFromFeatures([[1]], W0)).toThrow('lengths');
  });
  it('returns exact terminal one-hot results even when the losing player has more Renown', () => {
    const state = stateFor();
    state.phase = 'gameOver';
    state.winnerId = 1;
    state.cards[Card.Monument] = 20;
    expect(evaluate(board, state)).toEqual([0, 1, 0]);
  });
  it('permuting all player IDs permutes features and value outputs exactly', () => {
    const state = stateFor();
    put(state, 0, 0);
    put(state, 4, 1, Building.Town);
    put(state, 8, 2, Building.Citadel);
    state.hands.set([1, 2, 3, 4, 5, 4, 3, 2, 1, 0, 3, 1, 4, 1, 5]);
    state.musters.set([2, 4, 1]);
    state.warlord = 1;
    state.active = 2;
    state.toAct = 2;
    state.cards[Card.Caravan] = 2;
    state.freshCards[Card.Caravan] = 1;
    state.cards[CARD_COUNT + Card.Monument] = 1;
    state.edgeOwner[0] = 0;
    state.edgeOwner[3] = 1;
    state.edgeOwner[7] = 2;
    const permutation = [2, 0, 1],
      permuted = cloneState(state);
    for (const key of ['vertexOwner', 'edgeOwner'] as const)
      for (let i = 0; i < state[key].length; i++)
        if (state[key][i] >= 0) permuted[key][i] = permutation[state[key][i]];
    for (const key of ['hands', 'cards', 'freshCards'] as const) {
      const width = key === 'hands' ? GOOD_COUNT : CARD_COUNT;
      for (let p = 0; p < state.players; p++)
        for (let i = 0; i < width; i++)
          permuted[key][permutation[p] * width + i] = state[key][p * width + i];
    }
    for (let p = 0; p < state.players; p++) {
      permuted.musters[permutation[p]] = state.musters[p];
      permuted.turnOrder[p] = permutation[state.turnOrder[p]];
    }
    permuted.warlord = permutation[state.warlord];
    permuted.active = permutation[state.active];
    permuted.toAct = permutation[state.toAct];
    const original = allFeatures(board, state),
      changed = allFeatures(board, permuted);
    const originalValue = evaluate(board, state),
      changedValue = evaluate(board, permuted);
    for (let p = 0; p < state.players; p++) {
      expect(changed[permutation[p]]).toEqual(original[p]);
      expect(changedValue[permutation[p]]).toBeCloseTo(originalValue[p], 14);
    }
  });
});
