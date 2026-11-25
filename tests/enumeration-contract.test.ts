/** Enumerated decisions and the validator must agree for the same public position. */
import { describe, expect, it } from 'vitest';
import {
  apply,
  Building,
  Card,
  cloneState,
  createGame,
  isLegal,
  legalActions,
  type Action,
  type GameState,
} from '../src/engine/index.js';

const { board } = createGame('enumeration-contract');
/** Include every distinct finite action effect; trade offers are validated separately. */
function candidates(): Action[] {
  const actions: Action[] = [
    { type: 'roll' },
    { type: 'skip' },
    { type: 'endTurn' },
    { type: 'endSurveyors' },
    { type: 'muster' },
    { type: 'respondTrade', accept: true },
    { type: 'respondTrade', accept: false },
    { type: 'playCard', card: Card.Surveyors },
    { type: 'playCard', card: Card.Raid },
  ];
  for (const v of board.vertices)
    actions.push(
      { type: 'placeSteading', v: v.id },
      { type: 'buildSteading', v: v.id },
      { type: 'upgrade', v: v.id },
    );
  for (const e of board.edges)
    actions.push(
      { type: 'placeTrack', e: e.id },
      { type: 'buildTrack', e: e.id },
      { type: 'freeTrack', e: e.id },
    );
  for (const h of board.hexes) actions.push({ type: 'moveWarband', hex: h.id });
  for (let good = 0; good < 5; good++) {
    actions.push({ type: 'discard', good }, { type: 'playCard', card: Card.Tithe, good });
    for (let victim = 0; victim < 3; victim++) actions.push({ type: 'plunder', victim, good });
    for (let other = 0; other < 5; other++) {
      actions.push({ type: 'marketBuy', pay: good, get: other });
      if (other >= good)
        actions.push({ type: 'playCard', card: Card.Caravan, goods: [good, other] });
    }
  }
  for (let slot = 0; slot < 3; slot++) actions.push({ type: 'buyCard', slot });
  return actions;
}
const universe = candidates();
const canonical = (actions: Action[]) => actions.map((a) => JSON.stringify(a)).sort();
/** A funded fixture exposes all main-action choices without a simulation sweep. */
function position(phase: GameState['phase']): GameState {
  const { state } = createGame('enumeration-contract');
  state.phase = phase;
  state.active = state.toAct = 0;
  state.turn = 1;
  state.turnIndex = [...state.turnOrder].indexOf(0);
  state.hands.fill(20);
  state.cards.fill(1);
  state.lastSteading = board.hexes[0].vertices[0];
  state.vertexOwner[state.lastSteading] = 0;
  state.vertexKind[state.lastSteading] = Building.Steading;
  const opposite = board.vertices.find((v) => board.distances[v.id][state.lastSteading] >= 4)!;
  state.vertexOwner[opposite.id] = 1;
  state.vertexKind[opposite.id] = Building.Town;
  state.edgeOwner[board.vertices[state.lastSteading].edges[0]] = 0;
  state.freeTracks = 2;
  return state;
}

describe('finite legal-action enumeration', () => {
  it.each<GameState['phase']>([
    'setupSteading',
    'setupTrack',
    'roll',
    'discard',
    'moveWarband',
    'plunder',
    'main',
    'surveyors',
    'tradeResponse',
    'gameOver',
  ])('lists exactly the validator-approved decisions in %s', (phase) => {
    const state = position(phase);
    const expected = universe.filter((a) => isLegal(board, state, a));
    expect(canonical(legalActions(board, state))).toEqual(canonical(expected));
  });
  it('lists all and only payable main choices at exact empty-hand boundaries', () => {
    const state = position('main');
    for (const vector of [
      [0, 0, 0, 0, 0],
      [1, 1, 0, 0, 0],
      [0, 0, 1, 1, 1],
    ]) {
      state.hands.fill(0);
      state.hands.set(vector);
      expect(canonical(legalActions(board, state))).toEqual(
        canonical(universe.filter((a) => isLegal(board, state, a))),
      );
    }
  });
  it('rejects a decision after a winner without changing the serialized position', () => {
    const state = position('gameOver');
    state.winnerId = 0;
    const saved = cloneState(state);
    expect(() => apply(board, state, { type: 'endTurn' })).toThrow();
    expect(state).toEqual(saved);
  });
});

describe('forced chance inputs', () => {
  it.each([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])(
    'rolls exactly %s with either supported encoding without advancing RNG',
    (total) => {
      for (const option of [total, { forcedTotal: total }]) {
        const state = position('roll');
        const rng = state.rng;
        apply(board, state, { type: 'roll' }, option);
        expect(state.lastRoll).toBe(total);
        expect(state.rng).toBe(rng);
      }
    },
  );
  it.each([1, 13, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid forced total %s without mutation',
    (total) => {
      const state = position('roll');
      const saved = cloneState(state);
      expect(() => apply(board, state, { type: 'roll' }, total)).toThrow();
      expect(state).toEqual(saved);
    },
  );
  it('rejects a forced total on an otherwise legal non-roll decision', () => {
    const state = position('main');
    const saved = cloneState(state);
    expect(() => apply(board, state, { type: 'endTurn' }, 7)).toThrow();
    expect(state).toEqual(saved);
  });
});

it('enumerates held plunder goods while omitting empty goods and Citadel-only victims', () => {
  const state = position('plunder');
  state.vertexOwner.fill(-1);
  state.vertexKind.fill(0);
  state.hands.fill(0);
  const hex = board.hexes[state.warband];
  state.vertexOwner[hex.vertices[0]] = 1;
  state.vertexKind[hex.vertices[0]] = Building.Town;
  state.vertexOwner[hex.vertices[3]] = 2;
  state.vertexKind[hex.vertices[3]] = Building.Citadel;
  state.hands.set([1, 0, 0, 2, 0], 5);
  state.hands.set([0, 1, 0, 0, 0], 10);
  expect(legalActions(board, state)).toEqual([
    { type: 'plunder', victim: 1, good: 0 },
    { type: 'plunder', victim: 1, good: 3 },
    { type: 'skip' },
  ]);
});
