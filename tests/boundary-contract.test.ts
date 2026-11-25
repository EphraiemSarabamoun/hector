/** Adversarial rule fixtures pin inclusive boundaries and rejected choices without consulting CONFIG. */
import { describe, expect, it } from 'vitest';
import {
  apply,
  Building,
  Card,
  createState,
  generateBoard,
  isLegal,
  legalActions,
  winner,
  type Action,
  type GameState,
} from '../src/engine/index.js';

const board = generateBoard('boundary-contract');

/** Start from an empty public position so unrelated production and scoring cannot hide a boundary. */
function position(phase: GameState['phase'] = 'main'): GameState {
  const state = createState(board, 'boundary-position', 3);
  state.phase = phase;
  state.active = state.toAct = state.turnIndex = 0;
  state.turn = 1;
  state.turnOrder.set([0, 1, 2]);
  return state;
}

/** Remove affordability as a confounder while exercising placement and quantity validation. */
function rich(state: GameState): void {
  state.hands.fill(20);
}
/** Install just the ownership and building kind needed by a topology or production fixture. */
function building(
  state: GameState,
  v: number,
  player: number,
  kind: Building = Building.Steading,
): void {
  state.vertexOwner[v] = player;
  state.vertexKind[v] = kind;
}
/** Seed a card inventory directly; the six-slot public encoding is independent of rule quantities. */
function ownCard(state: GameState, card: Card, count = 1, player = 0): void {
  state.cards[player * 6 + card] = count;
}
/** Extract one player's five goods for whole-inventory assertions. */
function hand(state: GameState, player: number): number[] {
  return [...state.hands.slice(player * 5, player * 5 + 5)];
}
/** Form a non-overlapping offer so each test can vary a single validation boundary. */
function proposal(give = 1, get = 1, to = 1): Action {
  return { type: 'proposeTrade', to, give: [give, 0, 0, 0, 0], get: [0, get, 0, 0, 0] };
}

describe('input and phase boundaries', () => {
  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects malformed identifier %s across action families',
    (bad) => {
      const cases: [GameState['phase'], Action][] = [
        ['setupSteading', { type: 'placeSteading', v: bad }],
        ['setupTrack', { type: 'placeTrack', e: bad }],
        ['main', { type: 'buildTrack', e: bad }],
        ['main', { type: 'buildSteading', v: bad }],
        ['main', { type: 'upgrade', v: bad }],
        ['main', { type: 'buyCard', slot: bad }],
        ['main', { type: 'marketBuy', pay: bad, get: 1 }],
        ['main', { type: 'marketBuy', pay: 0, get: bad }],
        ['main', proposal(1, 1, bad)],
        ['discard', { type: 'discard', good: bad }],
        ['moveWarband', { type: 'moveWarband', hex: bad }],
        ['surveyors', { type: 'freeTrack', e: bad }],
        ['plunder', { type: 'plunder', victim: bad, good: 0 }],
        ['plunder', { type: 'plunder', victim: 1, good: bad }],
        ['main', { type: 'playCard', card: Card.Tithe, good: bad }],
        ['main', { type: 'playCard', card: Card.Caravan, goods: [0, bad] }],
      ];
      for (const [phase, action] of cases) {
        const state = position(phase);
        rich(state);
        state.lastSteading = 0;
        state.freeTracks = 2;
        state.cards.fill(1);
        building(state, board.hexes[state.warband].vertices[0], 1);
        expect(isLegal(board, state, action), JSON.stringify(action)).toBe(false);
      }
    },
  );

  it('rejects exactly one past each valid identifier range', () => {
    const state = position();
    rich(state);
    state.cards.fill(1);
    // Deliberately bypass the action type at this validator boundary to exercise invalid good IDs.
    const cases = [
      ['setupSteading', { type: 'placeSteading', v: board.vertices.length }],
      ['setupTrack', { type: 'placeTrack', e: board.edges.length }],
      ['main', { type: 'buildSteading', v: board.vertices.length }],
      ['main', { type: 'buildTrack', e: board.edges.length }],
      ['main', { type: 'upgrade', v: board.vertices.length }],
      ['main', { type: 'buyCard', slot: 3 }],
      ['main', { type: 'marketBuy', pay: 5, get: 0 }],
      ['main', { type: 'marketBuy', pay: 0, get: 5 }],
      ['main', proposal(1, 1, 3)],
      ['discard', { type: 'discard', good: 5 }],
      ['moveWarband', { type: 'moveWarband', hex: board.hexes.length }],
      ['plunder', { type: 'plunder', victim: 3, good: 0 }],
      ['plunder', { type: 'plunder', victim: 1, good: 5 }],
      ['main', { type: 'playCard', card: Card.Tithe, good: 5 }],
      ['main', { type: 'playCard', card: Card.Caravan, goods: [0, 5] }],
    ] as unknown as [GameState['phase'], Action][];
    state.lastSteading = 0;
    for (const [phase, action] of cases) {
      state.phase = phase;
      expect(isLegal(board, state, action)).toBe(false);
    }
  });

  it('rejects missing, unknown and terminal actions without changing the position', () => {
    const state = position();
    for (const action of [null, undefined, 1, 'roll', { type: 'unknown' }])
      expect(isLegal(board, state, action as Action)).toBe(false);
    state.phase = 'gameOver';
    expect(isLegal(board, state, { type: 'endTurn' })).toBe(false);
    expect(legalActions(board, state)).toEqual([]);
    expect(() => apply(board, state, { type: 'endTurn' })).toThrow();
  });

  it('permits only a boolean response while a proposal is pending', () => {
    const state = position();
    rich(state);
    apply(board, state, proposal());
    for (const accept of [0, 1, 'true', null, undefined])
      expect(isLegal(board, state, { type: 'respondTrade', accept } as unknown as Action)).toBe(
        false,
      );
    expect(isLegal(board, state, { type: 'endTurn' })).toBe(false);
    expect(isLegal(board, state, { type: 'respondTrade', accept: true })).toBe(true);
    expect(isLegal(board, state, { type: 'respondTrade', accept: false })).toBe(true);
  });
});

describe('piece supply and connectivity boundaries', () => {
  it('setup never reuses an edge occupied by player zero', () => {
    const state = position('setupTrack');
    const edge = board.edges[0];
    state.lastSteading = edge.vertices[0];
    building(state, state.lastSteading, 0);
    const action: Action = { type: 'placeTrack', e: edge.id };
    expect(isLegal(board, state, action)).toBe(true);
    state.edgeOwner[edge.id] = 0;
    expect(isLegal(board, state, action)).toBe(false);
    expect(legalActions(board, state)).not.toContainEqual(action);
  });

  it('the Surveyors validator requires a positive remaining Track allowance', () => {
    const state = position('surveyors');
    const edge = board.edges[0];
    building(state, edge.vertices[0], 0);
    const action: Action = { type: 'freeTrack', e: edge.id };
    state.freeTracks = 0;
    expect(isLegal(board, state, action)).toBe(false);
    state.freeTracks = 1;
    expect(isLegal(board, state, action)).toBe(true);
    apply(board, state, action);
    expect(state.freeTracks).toBe(0);
    expect(state.phase).toBe('main');
    expect(isLegal(board, state, action)).toBe(false);
  });

  it('player zero blocks another house from building through its Steading', () => {
    const state = position();
    rich(state);
    state.active = state.toAct = state.turnIndex = 1;
    const edge = board.edges.find((e) =>
      e.vertices.every((v) => board.vertices[v].edges.length > 1),
    )!;
    const endpoint = edge.vertices[0];
    const incoming = board.vertices[endpoint].edges.find((e) => e !== edge.id)!;
    state.edgeOwner[incoming] = 1;
    const action: Action = { type: 'buildTrack', e: edge.id };
    expect(isLegal(board, state, action)).toBe(true);
    building(state, endpoint, 0);
    expect(isLegal(board, state, action)).toBe(false);
    expect(legalActions(board, state)).not.toContainEqual(action);
    state.vertexOwner[endpoint] = -1;
    state.vertexKind[endpoint] = Building.Empty;
    expect(isLegal(board, state, action)).toBe(true);
    building(state, endpoint, 1);
    expect(isLegal(board, state, action)).toBe(true);
  });

  it.each([
    [Building.Steading, 5],
    [Building.Town, 4],
    [Building.Citadel, 2],
  ] as const)(
    'allows the last available building of kind %s, rejects exhaustion at %s',
    (kind, limit) => {
      const state = position();
      rich(state);
      const candidate = board.vertices[0];
      if (kind === Building.Steading) state.edgeOwner[candidate.edges[0]] = 0;
      else building(state, candidate.id, 0, kind - 1);
      const supplies = board.vertices
        .filter((v) => v.id !== candidate.id && !candidate.neighbours.includes(v.id))
        .slice(0, limit);
      for (const v of supplies.slice(0, limit - 1)) building(state, v.id, 0, kind);
      const action: Action =
        kind === Building.Steading
          ? { type: 'buildSteading', v: candidate.id }
          : { type: 'upgrade', v: candidate.id };
      expect(isLegal(board, state, action)).toBe(true);
      expect(legalActions(board, state)).toContainEqual(action);
      building(state, supplies[limit - 1].id, 0, kind);
      expect(isLegal(board, state, action)).toBe(false);
      expect(legalActions(board, state)).not.toContainEqual(action);
    },
  );

  it.each(['main', 'setupTrack', 'surveyors'] as const)(
    'uses exactly fifteen Track pieces in %s',
    (phase) => {
      const state = position(phase);
      rich(state);
      const edge = board.edges[0];
      building(state, edge.vertices[0], 0);
      state.lastSteading = edge.vertices[0];
      state.freeTracks = 2;
      const otherEdges = board.edges.filter((e) => e.id !== edge.id).slice(0, 15);
      for (const e of otherEdges.slice(0, 14)) state.edgeOwner[e.id] = 0;
      const type =
        phase === 'main' ? 'buildTrack' : phase === 'setupTrack' ? 'placeTrack' : 'freeTrack';
      const action: Action = { type, e: edge.id };
      expect(isLegal(board, state, action)).toBe(true);
      state.edgeOwner[otherEdges[14].id] = 0;
      expect(isLegal(board, state, action)).toBe(false);
      expect(legalActions(board, state)).not.toContainEqual(action);
    },
  );

  it('blocks a continuation at either opponent endpoint but permits own buildings', () => {
    const edge = board.edges.find((e) =>
      e.vertices.every((v) => board.vertices[v].edges.length > 1),
    )!;
    for (const endpoint of edge.vertices) {
      const state = position();
      rich(state);
      const previous = board.vertices[endpoint].edges.find((e) => e !== edge.id)!;
      state.edgeOwner[previous] = 0;
      const action: Action = { type: 'buildTrack', e: edge.id };
      expect(isLegal(board, state, action)).toBe(true);
      building(state, endpoint, 1);
      expect(isLegal(board, state, action)).toBe(false);
      building(state, endpoint, 0);
      expect(isLegal(board, state, action)).toBe(true);
      state.edgeOwner[edge.id] = 1;
      expect(isLegal(board, state, action)).toBe(false);
    }
  });

  it('cannot place a setup Steading when all five are already on the board', () => {
    const state = position('setupSteading');
    const candidate = board.vertices[0];
    const pieces = board.vertices
      .filter((v) => v.id !== 0 && !candidate.neighbours.includes(v.id))
      .slice(0, 5);
    for (const v of pieces.slice(0, 4)) building(state, v.id, 0);
    expect(isLegal(board, state, { type: 'placeSteading', v: 0 })).toBe(true);
    building(state, pieces[4].id, 0);
    expect(isLegal(board, state, { type: 'placeSteading', v: 0 })).toBe(false);
  });
});

describe('plunder and production eligibility', () => {
  it.each([0, 1, 2, 3, 4])('setup collects good ID %s, including Timber at ID zero', (good) => {
    const state = position('setupSteading');
    state.turn = 0;
    const hex = board.hexes.find((h) => h.good === good)!;
    const vertex = board.vertices[hex.vertices[0]];
    const expected = [0, 0, 0, 0, 0];
    for (const neighbour of vertex.hexes) {
      const terrainGood = board.hexes[neighbour].good;
      if (terrainGood >= 0) expected[terrainGood] += 1;
    }
    apply(board, state, { type: 'placeSteading', v: vertex.id });
    expect(hand(state, 0)).toEqual(expected);
    expect(state.hands[good]).toBeGreaterThanOrEqual(1);
  });

  it.each([0, 1, 2, 3, 4])(
    'produces good ID %s for the first player as well as the last',
    (good) => {
      const state = position('roll');
      const hex = board.hexes.find((h) => h.good === good)!;
      building(state, hex.vertices[0], 0);
      building(state, hex.vertices[2], 2, Building.Town);
      apply(board, state, { type: 'roll' }, hex.number);
      expect(state.hands[good]).toBe(1);
      expect(state.hands[10 + good]).toBe(2);
      expect([...state.hands].reduce((a, b) => a + b, 0)).toBe(3);
    },
  );

  it.each([-1, 1, 7.5, 13, Number.NaN])(
    'rejects impossible forced dice total %s before production',
    (total) => {
      const state = position('roll');
      expect(() => apply(board, state, { type: 'roll' }, total)).toThrow(
        'Invalid forced dice total',
      );
      expect(state.phase).toBe('roll');
      expect(state.lastRoll).toBe(0);
      expect([...state.hands]).toEqual(new Array(15).fill(0));
    },
  );

  it.each([2, 12])('accepts the inclusive dice endpoint %s', (total) => {
    const state = position('roll');
    apply(board, state, { type: 'roll' }, { forcedTotal: total });
    expect(state.lastRoll).toBe(total);
    expect(state.phase).toBe('main');
    expect(() => apply(board, state, { type: 'endTurn' }, 2)).toThrow('Invalid forced dice total');
  });

  it.each([Building.Steading, Building.Town, Building.Citadel])(
    'plunders exactly one available good with building %s',
    (kind) => {
      const state = position('plunder');
      building(state, board.hexes[state.warband].vertices[0], 1, kind);
      state.hands[5] = 1;
      const action: Action = { type: 'plunder', victim: 1, good: 0 };
      expect(isLegal(board, state, action)).toBe(kind !== Building.Citadel);
      expect(isLegal(board, state, { type: 'plunder', victim: 1, good: 1 })).toBe(false);
      if (kind !== Building.Citadel) {
        apply(board, state, action);
        expect(hand(state, 0)).toEqual([1, 0, 0, 0, 0]);
        expect(hand(state, 1)).toEqual([0, 0, 0, 0, 0]);
      }
    },
  );

  it('does not allow self, a distant owner, or an empty-handed victim', () => {
    const state = position('plunder');
    const hex = board.hexes[state.warband];
    building(state, hex.vertices[0], 0);
    building(state, board.vertices.find((v) => !hex.vertices.includes(v.id))!.id, 1);
    building(state, hex.vertices[2], 2);
    state.hands[0] = state.hands[5] = 1;
    for (const victim of [0, 1, 2])
      expect(isLegal(board, state, { type: 'plunder', victim, good: 0 })).toBe(false);
    expect(legalActions(board, state)).toEqual([{ type: 'skip' }]);
  });

  it('a Citadel does not shield a second, vulnerable building of the same house', () => {
    const state = position('moveWarband');
    const hex = board.hexes.find((h) => h.id !== state.warband)!;
    building(state, hex.vertices[0], 1, Building.Citadel);
    building(state, hex.vertices[3], 1, Building.Steading);
    state.hands[5] = 1;
    apply(board, state, { type: 'moveWarband', hex: hex.id });
    expect(state.phase).toBe('plunder');
    expect(isLegal(board, state, { type: 'plunder', victim: 1, good: 0 })).toBe(true);
  });

  it('an unowned productive corner creates no goods while the last player ID still produces', () => {
    const state = position('roll');
    const hex = board.hexes.find((h) => h.good >= 0)!;
    building(state, hex.vertices[0], 2);
    apply(board, state, { type: 'roll' }, hex.number);
    expect(hand(state, 0)).toEqual([0, 0, 0, 0, 0]);
    expect(hand(state, 1)).toEqual([0, 0, 0, 0, 0]);
    expect([...state.hands].reduce((a, b) => a + b, 0)).toBe(1);
    expect(state.hands[10 + hex.good]).toBe(1);
  });
});

describe('trade vector and proposal boundaries', () => {
  it.each([
    [
      [-1, 2, 0, 0, 0],
      [0, 0, 1, 0, 0],
    ],
    [
      [0, 0, 1, 0, 0],
      [-1, 2, 0, 0, 0],
    ],
    [
      [1.5, 0, 0, 0, 0],
      [0, 1, 0, 0, 0],
    ],
    [
      [1, 0, 0, 0, 0],
      [0, 1.5, 0, 0, 0],
    ],
  ])(
    'rejects invalid components even when both vector totals lie between one and three: %j / %j',
    (give, get) => {
      const state = position();
      rich(state);
      expect(isLegal(board, state, { type: 'proposeTrade', to: 1, give, get })).toBe(false);
    },
  );

  it.each([0, 1, 3, 4])('validates each side independently at %s goods', (units) => {
    const state = position();
    rich(state);
    expect(isLegal(board, state, proposal(units, 1))).toBe(units === 1 || units === 3);
    expect(isLegal(board, state, proposal(1, units))).toBe(units === 1 || units === 3);
  });

  it('accepts exact inventories but rejects either side when it is one short', () => {
    const state = position();
    state.hands[0] = state.hands[6] = 3;
    expect(isLegal(board, state, proposal(3, 3))).toBe(true);
    state.hands[0] = 2;
    expect(isLegal(board, state, proposal(3, 3))).toBe(false);
    state.hands[0] = 3;
    state.hands[6] = 2;
    expect(isLegal(board, state, proposal(3, 3))).toBe(false);
    expect(isLegal(board, state, proposal(1, 1, 0))).toBe(false);
  });

  it('counts declined proposals and permits the fourth but rejects the fifth', () => {
    const state = position();
    rich(state);
    for (let i = 0; i < 4; i++) {
      expect(isLegal(board, state, proposal())).toBe(true);
      apply(board, state, proposal());
      apply(board, state, { type: 'respondTrade', accept: false });
      expect(state.proposals).toBe(i + 1);
    }
    expect(isLegal(board, state, proposal())).toBe(false);
    expect(hand(state, 0)).toEqual([20, 20, 20, 20, 20]);
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, '1', null, undefined])(
    'rejects malformed quantity %s on either side',
    (value) => {
      const state = position();
      rich(state);
      const action = proposal() as Extract<Action, { type: 'proposeTrade' }>;
      for (const side of ['give', 'get'] as const) {
        const vector = side === 'give' ? [value, 0, 0, 0, 0] : [0, value, 0, 0, 0];
        expect(isLegal(board, state, { ...action, [side]: vector } as Action)).toBe(false);
      }
    },
  );

  it('rejects overlapping goods, non-arrays, sparse and incorrectly sized vectors', () => {
    const state = position();
    rich(state);
    const action = proposal() as Extract<Action, { type: 'proposeTrade' }>;
    expect(isLegal(board, state, { ...action, get: [1, 0, 0, 0, 0] })).toBe(false);
    for (const side of ['give', 'get'] as const)
      for (const vector of [
        [],
        [1, 0, 0, 0],
        [1, 0, 0, 0, 0, 0],
        new Array(5),
        new Uint8Array([1, 0, 0, 0, 0]),
        null,
        {},
      ])
        expect(isLegal(board, state, { ...action, [side]: vector } as Action)).toBe(false);
  });
});

describe('card timing, quantities and title thresholds', () => {
  it.each([Card.Caravan, Card.Surveyors, Card.Tithe, Card.Raid] as const)(
    'requires an old copy and one unused play for card %s',
    (card) => {
      const state = position();
      const action: Action =
        card === Card.Caravan
          ? { type: 'playCard', card, goods: [0, 0] }
          : card === Card.Tithe
            ? { type: 'playCard', card, good: 0 }
            : { type: 'playCard', card };
      expect(isLegal(board, state, action)).toBe(false);
      ownCard(state, card);
      state.freshCards[card] = 1;
      expect(isLegal(board, state, action)).toBe(false);
      ownCard(state, card, 2);
      expect(isLegal(board, state, action)).toBe(true);
      expect(legalActions(board, state)).toContainEqual(action);
      state.played = 1;
      expect(isLegal(board, state, action)).toBe(false);
      expect(legalActions(board, state)).not.toContainEqual(action);
    },
  );

  it.each([Card.Monument, Card.Granary, -1, 6, 0.5])(
    'cannot play permanent or invalid card %s',
    (card) => {
      const state = position();
      state.cards.fill(2);
      expect(isLegal(board, state, { type: 'playCard', card } as Action)).toBe(false);
    },
  );

  it('Caravan takes exactly two valid goods and allows duplicates', () => {
    const state = position();
    ownCard(state, Card.Caravan);
    for (const goods of [
      [],
      [0],
      [0, 1, 2],
      [0, -1],
      [0, 0.5],
      [0, 5],
      null,
      new Uint8Array([0, 1]),
    ])
      expect(
        isLegal(board, state, { type: 'playCard', card: Card.Caravan, goods } as unknown as Action),
      ).toBe(false);
    apply(board, state, { type: 'playCard', card: Card.Caravan, goods: [4, 4] });
    expect(hand(state, 0)).toEqual([0, 0, 0, 0, 2]);
    expect(state.discarded[Card.Caravan]).toBe(1);
    expect(state.played).toBe(1);
  });

  it.each([0, 1, 2, 3])(
    'Tithe takes min(two, available=%s) and leaves the active inventory intact',
    (available) => {
      const state = position();
      ownCard(state, Card.Tithe);
      state.hands[0] = 5;
      state.hands[5] = state.hands[10] = available;
      apply(board, state, { type: 'playCard', card: Card.Tithe, good: 0 });
      const taken = [0, 1, 2, 2][available];
      expect(hand(state, 0)).toEqual([5 + 2 * taken, 0, 0, 0, 0]);
      expect(state.hands[5]).toBe([0, 0, 0, 1][available]);
      expect(state.hands[10]).toBe([0, 0, 0, 1][available]);
    },
  );

  it('permits one paid muster, independent of whether a card was already played', () => {
    const state = position();
    rich(state);
    state.played = 1;
    expect(isLegal(board, state, { type: 'muster' })).toBe(true);
    state.paidMuster = 1;
    expect(isLegal(board, state, { type: 'muster' })).toBe(false);
    expect(legalActions(board, state)).not.toContainEqual({ type: 'muster' });
  });

  it.each([
    [1, -1, 0, -1],
    [2, -1, 0, 0],
    [1, 1, 3, 1],
    [2, 1, 3, 1],
    [3, 1, 3, 0],
  ])(
    'muster title boundary before=%s holder=%s count=%s ends holder=%s',
    (before, holder, holderCount, expected) => {
      const state = position();
      rich(state);
      state.musters[0] = before;
      state.warlord = holder;
      if (holder >= 0) state.musters[holder] = holderCount;
      apply(board, state, { type: 'muster' });
      expect(state.musters[0]).toBe(before + 1);
      expect(state.warlord).toBe(expected);
    },
  );
});

describe('lean-season ordering and victory boundaries', () => {
  it('spoils in a permuted cyclic turn order, retaining each discarder until exactly at storage', () => {
    const state = position('roll');
    state.turnOrder.set([2, 0, 1]);
    state.turnIndex = 2;
    state.active = state.toAct = 1;
    state.hands.set([10, 0, 0, 0, 0, 11, 0, 0, 0, 0, 13, 0, 0, 0, 0]);
    ownCard(state, Card.Granary, 1, 2);
    state.market.set([0, 2, 3, 4, 6]);
    const row = [...state.row];
    apply(board, state, { type: 'roll' }, 7);
    const order: number[] = [];
    for (let i = 0; i < 4; i++) {
      order.push(state.toAct);
      expect(state.phase).toBe('discard');
      expect([...state.market]).toEqual([0, 2, 3, 4, 6]);
      expect([...state.row]).toEqual(row);
      apply(board, state, { type: 'discard', good: 0 });
    }
    expect(order).toEqual([1, 1, 2, 0]);
    expect([state.hands[0], state.hands[5], state.hands[10]]).toEqual([9, 9, 12]);
    expect([...state.market]).toEqual([1, 3, 3, 3, 5]);
    expect(state.phase).toBe('moveWarband');
    expect(state.toAct).toBe(1);
    expect([...state.musters]).toEqual([0, 0, 0]);
    // A completed pass visits all three players; this cursor is preserved in serialized replays.
    expect(state.discardCursor).toBe(3);
  });

  it.each([8, 9, 10])('only inventories above nine spoil: inventory %s', (amount) => {
    const state = position('roll');
    state.hands[0] = amount;
    apply(board, state, { type: 'roll' }, 7);
    expect(state.phase).toBe(amount === 10 ? 'discard' : 'moveWarband');
  });

  it.each([11, 12, 13])(
    'active renown %s checks the twelve threshold without a turn transition',
    (score) => {
      const state = position();
      ownCard(state, Card.Monument, score);
      ownCard(state, Card.Caravan);
      apply(board, state, { type: 'playCard', card: Card.Caravan, goods: [0, 0] });
      expect(winner(board, state)).toBe(score >= 12 ? 0 : null);
      expect(state.phase).toBe(score >= 12 ? 'gameOver' : 'main');
    },
  );

  it('does not award twelve-renown victory during setup, or to a waiting rival', () => {
    const setup = position('setupSteading');
    setup.turn = 0;
    ownCard(setup, Card.Monument, 12);
    apply(board, setup, { type: 'placeSteading', v: 0 });
    expect(winner(board, setup)).toBeNull();
    const state = position();
    ownCard(state, Card.Monument, 12, 2);
    ownCard(state, Card.Caravan);
    apply(board, state, { type: 'playCard', card: Card.Caravan, goods: [0, 0] });
    expect(winner(board, state)).toBeNull();
  });

  it.each([599, 600])('turn %s applies the cap only when ending six hundred', (turn) => {
    const state = position();
    state.turn = turn;
    ownCard(state, Card.Monument, 1, 2);
    apply(board, state, { type: 'endTurn' });
    expect(winner(board, state)).toBe(turn === 600 ? 2 : null);
    expect(state.phase).toBe(turn === 600 ? 'gameOver' : 'roll');
  });
});
