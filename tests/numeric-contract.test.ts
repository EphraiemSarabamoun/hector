/** Literal contracts copied from RULES v1, independent of the engine's tunable values. */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  apply,
  Building,
  Card,
  CONFIG,
  createState,
  DICE_OUTCOMES,
  generateBoard,
  isLegal,
  marketPrice,
  pieceCount,
  renown,
  storageLimit,
  winner,
  type Action,
  type Board,
  type GameState,
} from '../src/engine/index.js';

// This table is an independent transcription, including zero-cost goods. Never derive it from CONFIG.
const RULE_NUMBERS = {
  players: { min: 2, max: 4, default: 3 },
  map: {
    radius: 3,
    land: 22,
    productivePerTerrain: 4,
    barrens: 2,
    neighbourWeight: 2,
    minNeighbours: 2,
    maxSameTerrainNeighbours: 1,
    attempts: 200,
    shrines: 3,
    shrineDistance: 5,
    shrineHexes: 2,
    harbours: 4,
    harbourDistance: 4,
    harbourShrineDistance: 2,
    coastalHexes: 3,
    tokens: [2, 3, 3, 4, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 10, 11, 11, 12],
    hotTokens: [6, 8],
    minPips: 10,
    maxPips: 16,
  },
  pieces: { track: 15, steading: 5, town: 4, citadel: 2 },
  goods: ['Timber', 'Clay', 'Grain', 'Bronze', 'Horses'],
  terrain: ['Forest', 'Clay Hills', 'Fields', 'Mines', 'Pasture', 'Barrens'],
  costs: {
    track: [1, 1, 0, 0, 0],
    steading: [1, 1, 1, 0, 1],
    town: [0, 0, 2, 2, 1],
    citadel: [1, 2, 0, 3, 0],
    card: [0, 0, 1, 1, 1],
    muster: [0, 0, 0, 1, 1],
  },
  renown: { steading: 1, town: 2, citadel: 3, shrine: 1, monument: 1, warlord: 2, target: 12 },
  setup: { rounds: 2, production: 1 },
  dice: { sides: 6, count: 2, lean: 7 },
  production: { steading: 1, town: 2, citadel: 2 },
  storage: { base: 9, granary: 3 },
  market: {
    initial: 3,
    max: 6,
    lowStock: 2,
    midStock: 4,
    lowPrice: 4,
    midPrice: 3,
    highPrice: 2,
    harbourDiscount: 1,
    minPrice: 2,
    drift: 1,
  },
  trade: { minUnits: 1, maxUnits: 3, maxProposals: 4 },
  cards: {
    row: 3,
    counts: [5, 4, 3, 5, 4, 3],
    caravanGoods: 2,
    surveyorTracks: 2,
    titheGoods: 2,
    playsPerTurn: 1,
  },
  warlord: { minimum: 3 },
  muster: { paidPerTurn: 1, plunderGoods: 1 },
  turnCap: 600,
} as const;

describe('literal RULES v1 numbers', () => {
  it.each(Object.entries(RULE_NUMBERS))('pins every numeric rule in %s', (section, expected) => {
    expect(CONFIG[section as keyof typeof CONFIG]).toEqual(expected);
  });
  it('pins the complete rule schema so new numbers cannot escape the contract', () => {
    expect(Object.keys(CONFIG).sort()).toEqual(Object.keys(RULE_NUMBERS).sort());
  });
});

let board: Board;

/** Start a public position with empty pieces and hands, isolating one action from setup. */
function position(): GameState {
  const state = createState(board, 'literal-position');
  state.phase = 'main';
  state.turn = 1;
  state.active = 0;
  state.toAct = 0;
  state.turnIndex = 0;
  state.turnOrder.set([0, 1, 2]);
  return state;
}

/** Place a single owned building; fixtures deliberately control pieces without buying them first. */
function place(state: GameState, vertex: number, kind = Building.Steading): void {
  state.vertexOwner[vertex] = 0;
  state.vertexKind[vertex] = kind;
}

/** Read exactly the five active-player goods, including goods whose literal build cost is zero. */
function hand(state: GameState): number[] {
  return [...state.hands.slice(0, 5)];
}

/** Supply just the placement prerequisite for the requested cost, with no unrelated economic help. */
function purchaseFixture(kind: keyof typeof RULE_NUMBERS.costs): {
  state: GameState;
  action: Action;
} {
  const state = position();
  switch (kind) {
    case 'track':
      place(state, board.edges[0].vertices[0]);
      return { state, action: { type: 'buildTrack', e: 0 } };
    case 'steading':
      state.edgeOwner[board.vertices[0].edges[0]] = 0;
      return { state, action: { type: 'buildSteading', v: 0 } };
    case 'town':
      place(state, 0);
      return { state, action: { type: 'upgrade', v: 0 } };
    case 'citadel':
      place(state, 0, Building.Town);
      return { state, action: { type: 'upgrade', v: 0 } };
    case 'card':
      return { state, action: { type: 'buyCard', slot: 0 } };
    case 'muster':
      return { state, action: { type: 'muster' } };
  }
}

describe('literal numeric behavior fixtures', () => {
  beforeAll(() => {
    board = generateBoard('literal-rule-contract');
  });

  describe('3 exact build costs', () => {
    for (const [kind, cost] of Object.entries(RULE_NUMBERS.costs)) {
      const name = kind as keyof typeof RULE_NUMBERS.costs;
      it(`${kind}: the exact literal vector is legal and consumes the whole hand`, () => {
        const { state, action } = purchaseFixture(name);
        state.hands.set(cost);
        expect(isLegal(board, state, action)).toBe(true);
        apply(board, state, action);
        expect(hand(state)).toEqual([0, 0, 0, 0, 0]);
      });
      for (let good = 0; good < 5; good++) {
        if (cost[good] === 0) continue;
        it(`${kind}: one short of required good ${good} is illegal`, () => {
          const { state, action } = purchaseFixture(name);
          state.hands.set(cost);
          state.hands[good]--;
          expect(isLegal(board, state, action)).toBe(false);
          expect(() => apply(board, state, action)).toThrow();
        });
      }
    }
  });

  it('2 generates the literal land, terrain, token, pip and landmark constraints on one map', () => {
    expect(board.hexes).toHaveLength(22);
    expect(
      [0, 1, 2, 3, 4, 5].map((t) => board.hexes.filter((h) => h.terrain === t).length),
    ).toEqual([4, 4, 4, 4, 4, 2]);
    expect(
      board.hexes
        .filter((h) => h.good >= 0)
        .map((h) => h.number)
        .sort((a, b) => a - b),
    ).toEqual([2, 3, 3, 4, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 10, 11, 11, 12]);
    const pips: Record<number, number> = {
      0: 0,
      2: 1,
      3: 2,
      4: 3,
      5: 4,
      6: 5,
      8: 5,
      9: 4,
      10: 3,
      11: 2,
      12: 1,
    };
    for (const hex of board.hexes) {
      expect(
        Math.max(Math.abs(hex.q), Math.abs(hex.r), Math.abs(hex.q + hex.r)),
      ).toBeLessThanOrEqual(3);
      expect(hex.neighbours.length).toBeGreaterThanOrEqual(2);
      expect(hex.pips).toBe(pips[hex.number]);
      expect(
        hex.neighbours.filter((n) => board.hexes[n].terrain === hex.terrain).length,
      ).toBeLessThanOrEqual(1);
      for (const n of hex.neighbours) {
        const next = board.hexes[n];
        if (hex.good < 0 || next.good < 0) continue;
        expect(next.number).not.toBe(hex.number);
        expect([6, 8].includes(hex.number) && [6, 8].includes(next.number)).toBe(false);
      }
    }
    for (const good of [0, 1, 2, 3, 4]) {
      const total = board.hexes.filter((h) => h.good === good).reduce((sum, h) => sum + h.pips, 0);
      expect(total).toBeGreaterThanOrEqual(10);
      expect(total).toBeLessThanOrEqual(16);
    }
    const shrines = board.vertices.filter((v) => v.shrine);
    const harbours = board.vertices.filter((v) => v.harbour);
    expect(shrines).toHaveLength(3);
    expect(harbours).toHaveLength(4);
    for (const vertex of board.vertices) expect(vertex.coastal).toBe(vertex.hexes.length < 3);
    for (const shrine of shrines) {
      expect(shrine.coastal).toBe(true);
      expect(shrine.hexes).toHaveLength(2);
      for (const other of shrines)
        if (other !== shrine)
          expect(board.distances[shrine.id][other.id]).toBeGreaterThanOrEqual(5);
    }
    for (const harbour of harbours) {
      expect(harbour.coastal).toBe(true);
      for (const other of harbours)
        if (other !== harbour)
          expect(board.distances[harbour.id][other.id]).toBeGreaterThanOrEqual(4);
      for (const shrine of shrines)
        expect(board.distances[harbour.id][shrine.id]).toBeGreaterThanOrEqual(2);
    }
    expect(board.hexes[board.initialWarband].terrain).toBe(5);
  });

  it.each([
    ['track', 15, Building.Empty],
    ['steading', 5, Building.Steading],
    ['town', 4, Building.Town],
    ['citadel', 2, Building.Citadel],
  ] as const)(
    '3 permits the last %s, then refuses another at the literal limit %s',
    (kind, limit, buildingKind) => {
      const { state, action } = purchaseFixture(kind);
      state.hands.set([20, 20, 20, 20, 20]);
      if (kind === 'track') {
        for (const edge of board.edges.filter((e) => e.id !== 0).slice(0, limit - 1))
          state.edgeOwner[edge.id] = 0;
      } else {
        const target = board.vertices[0];
        const others = board.vertices.filter(
          (v) => v.id !== 0 && !target.neighbours.includes(v.id),
        );
        for (const vertex of others.slice(0, limit - 1)) place(state, vertex.id, buildingKind);
      }
      expect(pieceCount(state, 0, kind === 'track' ? 'track' : buildingKind)).toBe(limit - 1);
      expect(isLegal(board, state, action)).toBe(true);
      if (kind === 'track') {
        const edge = board.edges.find((e) => e.id !== 0 && state.edgeOwner[e.id] < 0)!;
        state.edgeOwner[edge.id] = 0;
      } else {
        const vertex = board.vertices.find(
          (v) =>
            v.id !== 0 &&
            state.vertexOwner[v.id] < 0 &&
            !board.vertices[0].neighbours.includes(v.id),
        )!;
        place(state, vertex.id, buildingKind);
      }
      expect(pieceCount(state, 0, kind === 'track' ? 'track' : buildingKind)).toBe(limit);
      expect(isLegal(board, state, action)).toBe(false);
    },
  );

  it.each([
    [Building.Steading, 1],
    [Building.Town, 2],
    [Building.Citadel, 3],
  ])('4 building kind %s has exactly %s Renown and a shrine adds one', (kind, value) => {
    const state = position();
    const plain = board.vertices.find((v) => !v.shrine)!;
    place(state, plain.id, kind);
    expect(renown(board, state, 0)).toBe(value);
    state.vertexOwner[plain.id] = -1;
    place(state, board.vertices.find((v) => v.shrine)!.id, kind);
    expect(renown(board, state, 0)).toBe(value + 1);
  });

  it('4 Monument adds one, Warlord adds two, and 6.7 wins at twelve rather than eleven', () => {
    const state = position();
    state.cards[Card.Monument] = 1;
    expect(renown(board, state, 0)).toBe(1);
    state.warlord = 0;
    expect(renown(board, state, 0)).toBe(3);
    state.warlord = -1;
    state.cards[Card.Monument] = 11;
    state.phase = 'roll';
    apply(board, state, { type: 'roll' }, 2);
    expect(winner(board, state)).toBeNull();
    state.cards[Card.Monument] = 12;
    state.phase = 'roll';
    apply(board, state, { type: 'roll' }, 2);
    expect(winner(board, state)).toBe(0);
  });

  it('5 starts with three players, three stocks, three face-up cards, and the literal 24-card deck', () => {
    const state = createState(board, 'literal-deck');
    expect(state.players).toBe(3);
    expect([...state.market]).toEqual([3, 3, 3, 3, 3]);
    expect(state.rowCount).toBe(3);
    expect(state.deckCount).toBe(21);
    const cards = [...state.row, ...state.deck.slice(0, state.deckCount)];
    expect(cards).toHaveLength(24);
    expect([0, 1, 2, 3, 4, 5].map((kind) => cards.filter((c) => c === kind).length)).toEqual([
      5, 4, 3, 5, 4, 3,
    ]);
    expect(createState(board, 0, 2).players).toBe(2);
    expect(createState(board, 0, 4).players).toBe(4);
    expect(() => createState(board, 0, 1)).toThrow();
    expect(() => createState(board, 0, 5)).toThrow();
  });

  it('6.1 uses the eleven literal two-dice outcomes and storage nine plus three per Granary', () => {
    expect(DICE_OUTCOMES.map((o) => o.total)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(DICE_OUTCOMES.map((o) => o.probability * 36)).toEqual([1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1]);
    const state = position();
    expect(storageLimit(state, 0)).toBe(9);
    state.cards[Card.Granary] = 1;
    expect(storageLimit(state, 0)).toBe(12);
    state.cards[Card.Granary] = 2;
    expect(storageLimit(state, 0)).toBe(15);
  });

  it.each([
    [0, 0, 0],
    [1, 4, 3],
    [2, 4, 3],
    [3, 3, 2],
    [4, 3, 2],
    [5, 2, 2],
    [6, 2, 2],
  ])('6.4 stock %s costs %s, or %s with a harbour', (stock, ordinary, discounted) => {
    const state = position();
    state.hands.set([20, 0, 0, 0, 0]);
    state.market[1] = stock;
    expect(marketPrice(board, state, 0, 1)).toBe(ordinary);
    expect(isLegal(board, state, { type: 'marketBuy', pay: 0, get: 1 })).toBe(stock !== 0);
    place(state, board.vertices.find((v) => v.harbour)!.id);
    expect(marketPrice(board, state, 0, 1)).toBe(discounted);
    expect(isLegal(board, state, { type: 'marketBuy', pay: 0, get: 1 })).toBe(stock !== 0);
  });

  it.each([5, 6])(
    '6.4 adds one paid stock at %s with a hard cap of six and removes one wanted stock',
    (paidStock) => {
      const state = position();
      state.hands.set([3, 0, 0, 0, 0]);
      state.market[0] = paidStock;
      apply(board, state, { type: 'marketBuy', pay: 0, get: 1 });
      expect(hand(state)).toEqual([0, 1, 0, 0, 0]);
      expect([...state.market]).toEqual([6, 2, 3, 3, 3]);
    },
  );
});
