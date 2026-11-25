/** Contract tests for the setup and turn rules, with small public-position fixtures. */
import { describe, expect, it } from 'vitest';
import {
  apply,
  Building,
  Card,
  CARD_COUNT,
  cloneState,
  CONFIG,
  createState,
  generateBoard,
  GOOD_COUNT,
  Good,
  handSize,
  isLegal,
  legalActions,
  marketPrice,
  pieceCount,
  renown,
  storageLimit,
  winner,
  type Action,
  type GameState,
} from '../src/engine/index.js';

const board = generateBoard('rules-contract');
/** Isolate an action rule from setup randomness while keeping the real map topology. */
function position(phase: GameState['phase'] = 'main'): GameState {
  const state = createState(board, 'rules-position');
  state.phase = phase;
  state.turn = 1;
  state.active = 0;
  state.toAct = 0;
  state.turnOrder.set([0, 1, 2]);
  state.turnIndex = 0;
  return state;
}
function goods(state: GameState, player: number, vector: readonly number[]): void {
  state.hands.set(vector, player * GOOD_COUNT);
}
function card(state: GameState, player: number, kind: Card, count = 1): void {
  state.cards[player * CARD_COUNT + kind] = count;
}
function building(state: GameState, v: number, player = 0, kind = Building.Steading): void {
  state.vertexOwner[v] = player;
  state.vertexKind[v] = kind;
}
function rich(state: GameState, player = 0): void {
  goods(state, player, [20, 20, 20, 20, 20]);
}
function hand(state: GameState, player = 0): number[] {
  return Array.from(state.hands.slice(player * GOOD_COUNT, (player + 1) * GOOD_COUNT));
}
function use(state: GameState, action: Action): void {
  expect(isLegal(board, state, action)).toBe(true);
  apply(board, state, action);
}
function moveAway(state: GameState): void {
  use(state, { type: 'moveWarband', hex: board.hexes.find((h) => h.id !== state.warband)!.id });
  if (state.phase === 'plunder') use(state, { type: 'skip' });
}

describe('5 Setup', () => {
  it('5.1 randomizes a complete turn-order permutation deterministically', () => {
    const orders = new Set<string>();
    for (let seed = 0; seed < 20; seed++) {
      const state = createState(board, seed);
      expect([...state.turnOrder].sort()).toEqual([0, 1, 2]);
      expect([...state.turnOrder]).toEqual([...createState(board, seed).turnOrder]);
      orders.add([...state.turnOrder].join(','));
    }
    expect(orders.size).toBeGreaterThan(1);
  });
  it('5.2 shuffles all 24 cards and exposes the oldest three in order', () => {
    const state = createState(board, 1);
    expect(state.rowCount).toBe(3);
    expect(state.deckCount).toBe(21);
    const cards = [...state.row, ...state.deck.slice(0, state.deckCount)];
    expect(CONFIG.cards.counts.map((_, kind) => cards.filter((c) => c === kind).length)).toEqual([
      5, 4, 3, 5, 4, 3,
    ]);
    expect([...state.row, ...state.deck]).not.toEqual([
      ...createState(board, 2).row,
      ...createState(board, 2).deck,
    ]);
  });
  it('5.3 starts every market stock at three', () => {
    expect([...createState(board).market]).toEqual([3, 3, 3, 3, 3]);
  });
  it('5.4 places in forward then reverse order, each Track touching its new Steading', () => {
    const state = createState(board, 14);
    const order = [...state.turnOrder];
    const placed: number[] = [];
    for (let step = 0; step < 6; step++) {
      const player = state.toAct;
      placed.push(player);
      const action = legalActions(board, state)[0];
      use(state, action);
      expect(state.phase).toBe('setupTrack');
      for (const next of legalActions(board, state)) {
        expect(next.type).toBe('placeTrack');
        if (next.type === 'placeTrack')
          expect(board.edges[next.e].vertices).toContain(state.lastSteading);
      }
      const elsewhere = board.edges.find((e) => !e.vertices.includes(state.lastSteading))!;
      expect(isLegal(board, state, { type: 'placeTrack', e: elsewhere.id })).toBe(false);
      use(state, legalActions(board, state)[0]);
    }
    expect(placed).toEqual([...order, ...order.slice().reverse()]);
    for (const player of order) {
      expect(pieceCount(state, player, Building.Steading)).toBe(2);
      expect(pieceCount(state, player, 'track')).toBe(2);
    }
    expect(state.phase).toBe('roll');
    expect(state.active).toBe(order[0]);
    expect(state.toAct).toBe(order[0]);
    expect(state.turn).toBe(1);
  });
  it('5.4 forbids occupied vertices and every adjacent vertex', () => {
    const state = position('setupSteading');
    const v = board.vertices.find((v) => v.neighbours.length > 0)!;
    use(state, { type: 'placeSteading', v: v.id });
    state.phase = 'setupSteading';
    for (const blocked of [v.id, ...v.neighbours])
      expect(isLegal(board, state, { type: 'placeSteading', v: blocked })).toBe(false);
  });
  it('5.5 gives each placed Steading one good from each productive touching hex', () => {
    const state = createState(board, 23);
    for (let step = 0; step < 6; step++) {
      const player = state.toAct;
      const v = legalActions(board, state).find((a) => a.type === 'placeSteading')!;
      if (v.type !== 'placeSteading') throw new Error('setup action missing');
      const expected = hand(state, player);
      for (const h of board.vertices[v.v].hexes)
        if (board.hexes[h].good >= 0) expected[board.hexes[h].good]++;
      use(state, v);
      expect(hand(state, player)).toEqual(expected);
      use(state, legalActions(board, state)[0]);
    }
  });
});

describe('6.1 Roll and lean season', () => {
  it('6.1 permits only the roll before any action', () => {
    const state = position('roll');
    rich(state);
    expect(legalActions(board, state)).toEqual([{ type: 'roll' }]);
    for (const action of [
      { type: 'endTurn' },
      { type: 'muster' },
      { type: 'buyCard', slot: 0 },
    ] as Action[])
      expect(isLegal(board, state, action)).toBe(false);
  });
  it('6.1 produces 1 for Steadings and 2 for Towns/Citadels, for all owners', () => {
    const state = position('roll');
    const hex = board.hexes.find((h) => h.good >= 0)!;
    state.warband = board.initialWarband;
    building(state, hex.vertices[0], 0);
    building(state, hex.vertices[1], 1, Building.Town);
    building(state, hex.vertices[2], 2, Building.Citadel);
    apply(board, state, { type: 'roll' }, hex.number);
    expect(state.hands[hex.good]).toBe(1);
    expect(state.hands[GOOD_COUNT + hex.good]).toBe(2);
    expect(state.hands[2 * GOOD_COUNT + hex.good]).toBe(2);
    expect(state.phase).toBe('main');
  });
  it('6.1 on the Warband hex only Citadels produce', () => {
    const state = position('roll');
    const hex = board.hexes.find((h) => h.good >= 0)!;
    state.warband = hex.id;
    building(state, hex.vertices[0], 0);
    building(state, hex.vertices[1], 1, Building.Town);
    building(state, hex.vertices[2], 2, Building.Citadel);
    apply(board, state, { type: 'roll' }, hex.number);
    expect(state.hands[hex.good]).toBe(0);
    expect(state.hands[GOOD_COUNT + hex.good]).toBe(0);
    expect(state.hands[2 * GOOD_COUNT + hex.good]).toBe(2);
  });
  it('6.1 a 7 produces nothing, discards in active-player turn order before drift/turnover/move', () => {
    const state = position('roll');
    state.active = 1;
    state.toAct = 1;
    state.turnIndex = 1;
    goods(state, 0, [10, 0, 0, 0, 0]);
    goods(state, 1, [11, 0, 0, 0, 0]);
    goods(state, 2, [10, 0, 0, 0, 0]);
    const hex = board.hexes.find((h) => h.good >= 0)!;
    building(state, hex.vertices[0], 0);
    state.market.set([0, 1, 3, 5, 6]);
    const row = [...state.row];
    apply(board, state, { type: 'roll' }, 7);
    expect(state.phase).toBe('discard');
    expect(state.toAct).toBe(1);
    expect(handSize(state, 0)).toBe(10);
    expect([...state.market]).toEqual([0, 1, 3, 5, 6]);
    expect([...state.row]).toEqual(row);
    use(state, { type: 'discard', good: Good.Timber });
    expect(state.toAct).toBe(1);
    use(state, { type: 'discard', good: Good.Timber });
    expect(state.toAct).toBe(2);
    use(state, { type: 'discard', good: Good.Timber });
    expect(state.toAct).toBe(0);
    use(state, { type: 'discard', good: Good.Timber });
    expect([...state.market]).toEqual([1, 2, 3, 4, 5]);
    expect(state.phase).toBe('moveWarband');
    expect(state.toAct).toBe(1);
    expect(state.row[0]).toBe(row[1]);
    expect(state.row[1]).toBe(row[2]);
    expect(state.deck[state.deckCount - 1]).toBe(row[0]);
    expect([...state.musters]).toEqual([0, 0, 0]);
    expect(state.paidMuster).toBe(0);
  });
  it('6.1 storage is nine plus three per Granary, discarding only the excess', () => {
    const state = position('roll');
    card(state, 0, Card.Granary, 2);
    goods(state, 0, [16, 0, 0, 0, 0]);
    goods(state, 1, [9, 0, 0, 0, 0]);
    expect(storageLimit(state, 0)).toBe(15);
    expect(storageLimit(state, 1)).toBe(9);
    apply(board, state, { type: 'roll' }, 7);
    expect(state.toAct).toBe(0);
    expect(isLegal(board, state, { type: 'discard', good: Good.Clay })).toBe(false);
    use(state, { type: 'discard', good: Good.Timber });
    expect(state.phase).toBe('moveWarband');
    expect(handSize(state, 0)).toBe(15);
  });
  it('6.1 refills a short row on turnover and cycles its oldest card when the deck is empty', () => {
    const state = position('roll');
    state.rowCount = 1;
    state.row.set([Card.Tithe, -1, -1]);
    state.deckCount = 1;
    state.deck[0] = Card.Raid;
    apply(board, state, { type: 'roll' }, 7);
    expect(state.rowCount).toBe(2);
    expect([...state.row]).toEqual([Card.Raid, Card.Tithe, -1]);
    expect(state.deckCount).toBe(0);
    state.phase = 'roll';
    apply(board, state, { type: 'roll' }, 7);
    expect([...state.row]).toEqual([Card.Tithe, Card.Raid, -1]);
  });
  it('6.1 requires a different land hex for the free Warband move', () => {
    const state = position('roll');
    apply(board, state, { type: 'roll' }, 7);
    expect(isLegal(board, state, { type: 'moveWarband', hex: state.warband })).toBe(false);
    expect(isLegal(board, state, { type: 'moveWarband', hex: -1 })).toBe(false);
    moveAway(state);
    expect(state.phase).toBe('main');
    expect(state.musters[0]).toBe(0);
  });
});

describe('6.2 Actions and pieces', () => {
  it('6.2 Track costs Timber/Clay and connects from a building or unblocked Track endpoint', () => {
    const state = position();
    rich(state);
    const edge = board.edges[0];
    building(state, edge.vertices[0]);
    const before = hand(state);
    use(state, { type: 'buildTrack', e: edge.id });
    expect(hand(state)).toEqual(before.map((n, g) => n - CONFIG.costs.track[g]));
    expect(state.edgeOwner[edge.id]).toBe(0);
    expect(isLegal(board, state, { type: 'buildTrack', e: edge.id })).toBe(false);
    const continuation = board.vertices[edge.vertices[1]].edges.find((e) => e !== edge.id)!;
    expect(isLegal(board, state, { type: 'buildTrack', e: continuation })).toBe(true);
    building(state, edge.vertices[1], 1);
    expect(isLegal(board, state, { type: 'buildTrack', e: continuation })).toBe(false);
    building(state, edge.vertices[1], 0);
    expect(isLegal(board, state, { type: 'buildTrack', e: continuation })).toBe(true);
  });
  it('6.2 forbids disconnected Tracks and unaffordable builds', () => {
    const state = position();
    rich(state);
    expect(isLegal(board, state, { type: 'buildTrack', e: 0 })).toBe(false);
    building(state, board.edges[0].vertices[0]);
    goods(state, 0, [0, 1, 0, 0, 0]);
    expect(isLegal(board, state, { type: 'buildTrack', e: 0 })).toBe(false);
  });
  it('6.2 Steading requires an own Track, empty vertex, distance and full cost', () => {
    const state = position();
    rich(state);
    const vertex = board.vertices[0];
    const action: Action = { type: 'buildSteading', v: vertex.id };
    expect(isLegal(board, state, action)).toBe(false);
    state.edgeOwner[vertex.edges[0]] = 0;
    building(state, vertex.neighbours[0], 1);
    expect(isLegal(board, state, action)).toBe(false);
    state.vertexOwner[vertex.neighbours[0]] = -1;
    state.vertexKind[vertex.neighbours[0]] = Building.Empty;
    const before = hand(state);
    use(state, action);
    expect(hand(state)).toEqual(before.map((n, g) => n - CONFIG.costs.steading[g]));
    expect(state.vertexKind[vertex.id]).toBe(Building.Steading);
    expect(isLegal(board, state, action)).toBe(false);
  });
  it('6.2 upgrades charge exact costs and return the old piece to supply', () => {
    const state = position();
    rich(state);
    building(state, 0);
    let before = hand(state);
    use(state, { type: 'upgrade', v: 0 });
    expect(hand(state)).toEqual(before.map((n, g) => n - CONFIG.costs.town[g]));
    expect(pieceCount(state, 0, Building.Steading)).toBe(0);
    expect(pieceCount(state, 0, Building.Town)).toBe(1);
    before = hand(state);
    use(state, { type: 'upgrade', v: 0 });
    expect(hand(state)).toEqual(before.map((n, g) => n - CONFIG.costs.citadel[g]));
    expect(pieceCount(state, 0, Building.Town)).toBe(0);
    expect(pieceCount(state, 0, Building.Citadel)).toBe(1);
    expect(isLegal(board, state, { type: 'upgrade', v: 0 })).toBe(false);
    building(state, 1, 1);
    expect(isLegal(board, state, { type: 'upgrade', v: 1 })).toBe(false);
  });
  it.each([Building.Steading, Building.Town, Building.Citadel])(
    '6.2 enforces simultaneous building supply for kind %s',
    (kind) => {
      const state = position();
      rich(state);
      const limit = kind === Building.Steading ? 5 : kind === Building.Town ? 4 : 2;
      const candidate = board.vertices[0];
      if (kind === Building.Steading) state.edgeOwner[candidate.edges[0]] = 0;
      else building(state, candidate.id, 0, kind - 1);
      for (const v of board.vertices
        .filter((v) => v.id !== candidate.id && !candidate.neighbours.includes(v.id))
        .slice(0, limit))
        building(state, v.id, 0, kind);
      expect(
        isLegal(
          board,
          state,
          kind === Building.Steading
            ? { type: 'buildSteading', v: candidate.id }
            : { type: 'upgrade', v: candidate.id },
        ),
      ).toBe(false);
    },
  );
  it('6.2 enforces Track supply and allows one paid Muster alongside a Raid', () => {
    const state = position();
    rich(state);
    state.edgeOwner.fill(-1);
    const e = board.edges[0];
    building(state, e.vertices[0]);
    for (const other of board.edges.filter((x) => x.id !== e.id).slice(0, 15))
      state.edgeOwner[other.id] = 0;
    expect(isLegal(board, state, { type: 'buildTrack', e: e.id })).toBe(false);
    card(state, 0, Card.Raid);
    use(state, { type: 'playCard', card: Card.Raid });
    moveAway(state);
    const before = hand(state);
    use(state, { type: 'muster' });
    expect(hand(state)).toEqual(before.map((n, g) => n - CONFIG.costs.muster[g]));
    moveAway(state);
    expect(state.musters[0]).toBe(2);
    expect(isLegal(board, state, { type: 'muster' })).toBe(false);
  });
  it('6.2 ending a turn advances order and resets all turn limits', () => {
    const state = position();
    state.played = 1;
    state.paidMuster = 1;
    state.proposals = 4;
    use(state, { type: 'endTurn' });
    expect(state.active).toBe(1);
    expect(state.toAct).toBe(1);
    expect(state.phase).toBe('roll');
    expect(state.turn).toBe(2);
    expect([state.played, state.paidMuster, state.proposals]).toEqual([0, 0, 0]);
  });
});

describe('6.3 Warband and Warlord', () => {
  it('6.3 plunders one chosen good from a Steading/Town owner, excluding self and Citadel-only owners', () => {
    const state = position('moveWarband');
    const hex = board.hexes.find((h) => h.id !== state.warband)!;
    building(state, hex.vertices[0], 1, Building.Town);
    building(state, hex.vertices[2], 2, Building.Citadel);
    goods(state, 1, [0, 2, 0, 0, 0]);
    goods(state, 2, [3, 0, 0, 0, 0]);
    use(state, { type: 'moveWarband', hex: hex.id });
    expect(state.phase).toBe('plunder');
    expect(isLegal(board, state, { type: 'plunder', victim: 2, good: Good.Timber })).toBe(false);
    expect(isLegal(board, state, { type: 'plunder', victim: 0, good: Good.Timber })).toBe(false);
    expect(isLegal(board, state, { type: 'plunder', victim: 1, good: Good.Timber })).toBe(false);
    use(state, { type: 'plunder', victim: 1, good: Good.Clay });
    expect(state.hands[Good.Clay]).toBe(1);
    expect(state.hands[GOOD_COUNT + Good.Clay]).toBe(1);
    expect(state.phase).toBe('main');
  });
  it('6.3 plunder is optional, and skips automatically when no eligible victim has goods', () => {
    const state = position('moveWarband');
    const hex = board.hexes.find((h) => h.id !== state.warband)!;
    building(state, hex.vertices[0], 1);
    use(state, { type: 'moveWarband', hex: hex.id });
    expect(state.phase).toBe('main');
    state.phase = 'moveWarband';
    state.warband = board.initialWarband;
    goods(state, 1, [1, 0, 0, 0, 0]);
    use(state, { type: 'moveWarband', hex: hex.id });
    use(state, { type: 'skip' });
    expect(hand(state, 1)).toEqual([1, 0, 0, 0, 0]);
  });
  it('6.3 awards Warlord at three, retains ties and transfers only on a strictly greater count', () => {
    const state = position();
    rich(state);
    state.musters[0] = 1;
    use(state, { type: 'muster' });
    expect(state.warlord).toBe(-1);
    moveAway(state);
    state.paidMuster = 0;
    use(state, { type: 'muster' });
    expect(state.warlord).toBe(0);
    expect(renown(board, state, 0)).toBe(2);
    moveAway(state);
    state.active = 1;
    state.toAct = 1;
    state.musters[1] = 2;
    rich(state, 1);
    state.paidMuster = 0;
    use(state, { type: 'muster' });
    expect(state.warlord).toBe(0);
    moveAway(state);
    state.paidMuster = 0;
    use(state, { type: 'muster' });
    expect(state.warlord).toBe(1);
    expect(renown(board, state, 0)).toBe(0);
    expect(renown(board, state, 1)).toBe(2);
  });
});

describe('6.4 Market', () => {
  it.each([
    [0, 0],
    [1, 4],
    [2, 4],
    [3, 3],
    [4, 3],
    [5, 2],
    [6, 2],
  ])('6.4 stock %s has price %s', (stock, price) => {
    const state = position();
    rich(state);
    state.market[Good.Grain] = stock;
    expect(marketPrice(board, state, 0, Good.Grain)).toBe(price);
    expect(isLegal(board, state, { type: 'marketBuy', pay: Good.Clay, get: Good.Grain })).toBe(
      stock > 0,
    );
  });
  it.each([
    [1, 3],
    [3, 2],
    [5, 2],
  ])('6.4 a harbour lowers stock %s price to %s, floor two', (stock, price) => {
    const state = position();
    building(state, board.vertices.find((v) => v.harbour)!.id);
    state.market[Good.Grain] = stock;
    expect(marketPrice(board, state, 0, Good.Grain)).toBe(price);
    expect(marketPrice(board, state, 1, Good.Grain)).toBe(stock === 1 ? 4 : stock === 3 ? 3 : 2);
  });
  it('6.4 spends one other good, gives exactly one, changes stocks and caps paid stock at six', () => {
    const state = position();
    goods(state, 0, [0, 3, 0, 0, 0]);
    state.market[Good.Clay] = 6;
    expect(isLegal(board, state, { type: 'marketBuy', pay: Good.Clay, get: Good.Clay })).toBe(
      false,
    );
    expect(isLegal(board, state, { type: 'marketBuy', pay: Good.Timber, get: Good.Grain })).toBe(
      false,
    );
    use(state, { type: 'marketBuy', pay: Good.Clay, get: Good.Grain });
    expect(hand(state)).toEqual([0, 0, 1, 0, 0]);
    expect([...state.market]).toEqual([3, 6, 2, 3, 3]);
  });
});

describe('6.5 Player trades', () => {
  const offer = (
    to = 1,
    give: readonly number[] = [1, 0, 0, 0, 0],
    get: readonly number[] = [0, 1, 0, 0, 0],
  ): Action => ({ type: 'proposeTrade', to, give, get });
  it('6.5 gives the named opponent the decision and exchanges goods atomically on acceptance', () => {
    const state = position();
    goods(state, 0, [3, 0, 0, 0, 0]);
    goods(state, 1, [0, 2, 0, 0, 0]);
    expect(legalActions(board, state).some((a) => a.type === 'proposeTrade')).toBe(false);
    use(state, offer(1, [2, 0, 0, 0, 0], [0, 1, 0, 0, 0]));
    expect(state.active).toBe(0);
    expect(state.toAct).toBe(1);
    expect(state.phase).toBe('tradeResponse');
    expect(hand(state)).toEqual([3, 0, 0, 0, 0]);
    expect(legalActions(board, state)).toEqual([
      { type: 'respondTrade', accept: true },
      { type: 'respondTrade', accept: false },
    ]);
    use(state, { type: 'respondTrade', accept: true });
    expect(hand(state)).toEqual([1, 1, 0, 0, 0]);
    expect(hand(state, 1)).toEqual([2, 1, 0, 0, 0]);
    expect(state.toAct).toBe(0);
    expect(state.phase).toBe('main');
    expect(state.tradeTo).toBe(-1);
  });
  it('6.5 declined and accepted proposals both count toward four per turn', () => {
    const state = position();
    rich(state);
    rich(state, 1);
    for (let i = 0; i < 4; i++) {
      use(state, offer());
      use(state, { type: 'respondTrade', accept: i % 2 === 0 });
    }
    expect(state.proposals).toBe(4);
    expect(isLegal(board, state, offer())).toBe(false);
  });
  it('6.5 decline leaves both hands untouched', () => {
    const state = position();
    rich(state);
    rich(state, 1);
    const before = [...state.hands];
    use(state, offer());
    use(state, { type: 'respondTrade', accept: false });
    expect([...state.hands]).toEqual(before);
  });
  it('6.5 rejects self/unknown targets, overlapping goods, invalid vectors and unavailable goods', () => {
    const state = position();
    rich(state);
    rich(state, 1);
    const invalid = [
      offer(0),
      offer(-1),
      offer(3),
      offer(1, [1, 0], [0, 1, 0, 0, 0]),
      offer(1, [0, 0, 0, 0, 0]),
      offer(1, [4, 0, 0, 0, 0]),
      offer(1, [1.5, 0, 0, 0, 0]),
      offer(1, [-1, 1, 0, 0, 0]),
      offer(1, [1, 0, 0, 0, 0], [1, 0, 0, 0, 0]),
      offer(1, [1, 0, 0, 0, 0], [0, 0, 0, 0, 0]),
      offer(1, [1, 0, 0, 0, 0], [0, 4, 0, 0, 0]),
      offer(1, [1, 0, 0, 0, 0], [0, NaN, 0, 0, 0]),
    ];
    for (const action of invalid) expect(isLegal(board, state, action)).toBe(false);
    goods(state, 0, [0, 0, 0, 0, 0]);
    expect(isLegal(board, state, offer())).toBe(false);
    rich(state);
    goods(state, 1, [0, 0, 0, 0, 0]);
    expect(isLegal(board, state, offer())).toBe(false);
  });
});

describe('6.6 Stratagems', () => {
  it('6.6 buys any row slot for the exact cost, preserves other order and draws the top', () => {
    const state = position();
    rich(state);
    const row = [...state.row];
    const top = state.deck[0];
    const count = state.deckCount;
    const before = hand(state);
    use(state, { type: 'buyCard', slot: 1 });
    expect(hand(state)).toEqual(before.map((n, g) => n - CONFIG.costs.card[g]));
    expect(state.cards[row[1]]).toBe(1);
    expect([...state.row]).toEqual([row[0], row[2], top]);
    expect(state.deckCount).toBe(count - 1);
  });
  it('6.6 shrinks the row when the deck is exhausted and forbids buying an empty slot', () => {
    const state = position();
    rich(state);
    state.deckCount = 0;
    for (let count = 3; count > 0; count--) {
      use(state, { type: 'buyCard', slot: 0 });
      expect(state.rowCount).toBe(count - 1);
      expect(isLegal(board, state, { type: 'buyCard', slot: count - 1 })).toBe(false);
    }
    expect(state.rowCount).toBe(0);
  });
  it('6.6 a bought play card is fresh until the next own turn; older copies remain usable', () => {
    const state = position();
    rich(state);
    state.row[0] = Card.Caravan;
    use(state, { type: 'buyCard', slot: 0 });
    const play: Action = {
      type: 'playCard',
      card: Card.Caravan,
      goods: [Good.Timber, Good.Timber],
    };
    expect(isLegal(board, state, play)).toBe(false);
    card(state, 0, Card.Caravan, 2);
    expect(isLegal(board, state, play)).toBe(true);
    card(state, 0, Card.Caravan, 1);
    use(state, { type: 'endTurn' });
    state.phase = 'main';
    use(state, { type: 'endTurn' });
    state.phase = 'main';
    use(state, { type: 'endTurn' });
    state.phase = 'main';
    expect(state.active).toBe(0);
    expect(isLegal(board, state, play)).toBe(true);
  });
  it('6.6 Caravan takes any two bank goods, including two identical goods, then discards', () => {
    const state = position();
    card(state, 0, Card.Caravan);
    expect(
      isLegal(board, state, {
        type: 'playCard',
        card: Card.Caravan,
        goods: Array(2),
      } as unknown as Action),
    ).toBe(false);
    use(state, { type: 'playCard', card: Card.Caravan, goods: [Good.Bronze, Good.Bronze] });
    expect(hand(state)).toEqual([0, 0, 0, 2, 0]);
    expect(state.cards[Card.Caravan]).toBe(0);
    expect(state.discarded[Card.Caravan]).toBe(1);
    card(state, 0, Card.Tithe);
    expect(isLegal(board, state, { type: 'playCard', card: Card.Tithe, good: Good.Bronze })).toBe(
      false,
    );
  });
  it('6.6 Surveyors builds up to two normally connected Tracks without spending goods', () => {
    const state = position();
    card(state, 0, Card.Surveyors);
    building(state, board.edges[0].vertices[0]);
    use(state, { type: 'playCard', card: Card.Surveyors });
    expect(state.phase).toBe('surveyors');
    expect(state.freeTracks).toBe(2);
    expect(isLegal(board, state, { type: 'endTurn' })).toBe(false);
    for (let i = 0; i < 2; i++) {
      const action = legalActions(board, state).find((a) => a.type === 'freeTrack')!;
      use(state, action);
    }
    expect(pieceCount(state, 0, 'track')).toBe(2);
    expect(handSize(state, 0)).toBe(0);
    expect(state.phase).toBe('main');
    expect(state.freeTracks).toBe(0);
  });
  it('6.6 Surveyors can stop at zero or one and obeys opponent blocks and supply', () => {
    for (const n of [0, 1]) {
      const state = position();
      card(state, 0, Card.Surveyors);
      building(state, board.edges[0].vertices[0]);
      use(state, { type: 'playCard', card: Card.Surveyors });
      if (n)
        use(
          state,
          legalActions(board, state).find((a) => a.type === 'freeTrack')!,
        );
      use(state, { type: 'endSurveyors' });
      expect(pieceCount(state, 0, 'track')).toBe(n);
      expect(state.phase).toBe('main');
    }
    const state = position('surveyors');
    state.freeTracks = 2;
    const edge = board.edges[0];
    state.edgeOwner[edge.id] = 0;
    const endpoint = edge.vertices[1];
    building(state, endpoint, 1);
    const next = board.vertices[endpoint].edges.find((e) => e !== edge.id)!;
    expect(isLegal(board, state, { type: 'freeTrack', e: next })).toBe(false);
    state.edgeOwner.fill(0);
    expect(legalActions(board, state)).toEqual([{ type: 'endSurveyors' }]);
  });
  it('6.6 Tithe collects up to two named goods from every opponent and none from self', () => {
    const state = position();
    card(state, 0, Card.Tithe);
    goods(state, 0, [4, 0, 0, 0, 0]);
    goods(state, 1, [1, 5, 0, 0, 0]);
    goods(state, 2, [3, 5, 0, 0, 0]);
    use(state, { type: 'playCard', card: Card.Tithe, good: Good.Timber });
    expect(hand(state)).toEqual([7, 0, 0, 0, 0]);
    expect(hand(state, 1)).toEqual([0, 5, 0, 0, 0]);
    expect(hand(state, 2)).toEqual([1, 5, 0, 0, 0]);
  });
  it('6.6 Raid moves and plunders without payment, counts as a muster and enters discard', () => {
    const state = position();
    card(state, 0, Card.Raid);
    const hex = board.hexes.find((h) => h.id !== state.warband)!;
    building(state, hex.vertices[0], 1);
    goods(state, 1, [0, 0, 1, 0, 0]);
    use(state, { type: 'playCard', card: Card.Raid });
    expect(state.phase).toBe('moveWarband');
    expect(state.musters[0]).toBe(1);
    expect(state.paidMuster).toBe(0);
    expect(handSize(state, 0)).toBe(0);
    use(state, { type: 'moveWarband', hex: hex.id });
    use(state, { type: 'plunder', victim: 1, good: Good.Grain });
    expect(state.hands[Good.Grain]).toBe(1);
    expect(state.discarded[Card.Raid]).toBe(1);
  });
  it('6.6 Monument and Granary apply immediately, remain owned and cannot be played', () => {
    const state = position();
    rich(state);
    state.row.set([Card.Monument, Card.Granary, Card.Tithe]);
    use(state, { type: 'buyCard', slot: 0 });
    expect(renown(board, state, 0)).toBe(1);
    expect(state.freshCards[Card.Monument]).toBe(0);
    use(state, { type: 'buyCard', slot: 0 });
    expect(storageLimit(state, 0)).toBe(12);
    expect(state.cards[Card.Monument]).toBe(1);
    expect(state.cards[Card.Granary]).toBe(1);
    expect(state.freshCards[Card.Granary]).toBe(0);
    expect(
      legalActions(board, state)
        .filter((a) => a.type === 'playCard')
        .every((a) => a.card !== (Card.Monument as Card) && a.card !== (Card.Granary as Card)),
    ).toBe(true);
    expect(
      isLegal(board, state, { type: 'playCard', card: Card.Monument } as unknown as Action),
    ).toBe(false);
    expect(
      isLegal(board, state, { type: 'playCard', card: Card.Granary } as unknown as Action),
    ).toBe(false);
  });
});

describe('6.7 Winning', () => {
  it('6.7 counts buildings, shrine bonuses, Monuments and Warlord from current position', () => {
    const state = position();
    const shrine = board.vertices.find((v) => v.shrine)!;
    const others = board.vertices.filter((v) => !v.shrine).slice(0, 2);
    building(state, shrine.id);
    building(state, others[0].id, 0, Building.Town);
    building(state, others[1].id, 0, Building.Citadel);
    card(state, 0, Card.Monument, 2);
    state.warlord = 0;
    expect(renown(board, state, 0)).toBe(11);
    state.vertexKind[others[0].id] = Building.Citadel;
    expect(renown(board, state, 0)).toBe(12);
  });
  it('6.7 wins instantly when buying a Monument reaches twelve', () => {
    const state = position();
    rich(state);
    card(state, 0, Card.Monument, 11);
    state.row[0] = Card.Monument;
    use(state, { type: 'buyCard', slot: 0 });
    expect(winner(board, state)).toBe(0);
    expect(state.phase).toBe('gameOver');
    expect(legalActions(board, state)).toEqual([]);
  });
  it('6.7 wins instantly when taking Warlord, before the remaining move decision', () => {
    const state = position();
    rich(state);
    card(state, 0, Card.Monument, 10);
    state.musters[0] = 2;
    use(state, { type: 'muster' });
    expect(state.phase).toBe('gameOver');
    expect(winner(board, state)).toBe(0);
  });
  it('6.7 only the active player can win, including during another player discard', () => {
    const state = position('roll');
    card(state, 1, Card.Monument, 12);
    goods(state, 1, [10, 0, 0, 0, 0]);
    apply(board, state, { type: 'roll' }, 7);
    use(state, { type: 'discard', good: Good.Timber });
    expect(winner(board, state)).toBeNull();
    moveAway(state);
    use(state, { type: 'endTurn' });
    expect(winner(board, state)).toBe(1);
    expect(state.phase).toBe('gameOver');
  });
  it('6.7 at the turn cap highest Renown wins regardless of active player', () => {
    const state = position();
    state.turn = 600;
    card(state, 0, Card.Monument, 4);
    card(state, 1, Card.Monument, 5);
    rich(state, 0);
    use(state, { type: 'endTurn' });
    expect(winner(board, state)).toBe(1);
    expect(state.phase).toBe('gameOver');
  });
  it('6.7 turn-cap Renown ties use hand size, then earliest place in randomized order', () => {
    const state = position();
    state.turn = 600;
    card(state, 0, Card.Monument, 4);
    card(state, 1, Card.Monument, 4);
    goods(state, 1, [1, 0, 0, 0, 0]);
    const tied = cloneState(state);
    use(state, { type: 'endTurn' });
    expect(winner(board, state)).toBe(1);
    tied.hands.fill(0);
    tied.turnOrder.set([1, 2, 0]);
    use(tied, { type: 'endTurn' });
    expect(winner(board, tied)).toBe(1);
  });
});
