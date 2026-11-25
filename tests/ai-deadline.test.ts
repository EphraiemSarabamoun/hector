/** Fake clocks exercise bounded search cutoffs without timing-sensitive tests or game jobs. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apply,
  Building,
  cloneState,
  createGame,
  DICE_OUTCOMES,
  GOOD_COUNT,
  isLegal,
  legalActions,
  randomizeHidden,
  serializeState,
} from '../src/engine/index.js';
import { planTurn } from '../src/ai/planner.js';
import { searchMCTS } from '../src/ai/mcts.js';
import { choosePlacement, rankedDecisions } from '../src/ai/placement.js';
import { tierByName } from '../src/ai/tiers.js';
import * as value from '../src/ai/value.js';
import type { SearchRequest } from '../src/ai/types.js';

function request(main = true): SearchRequest {
  const { board, state } = createGame('deadline-fixture');
  if (main) {
    state.phase = 'main';
    state.turn = 1;
    state.vertexOwner[0] = state.active;
    state.vertexKind[0] = Building.Steading;
    state.hands.fill(8, state.active * GOOD_COUNT, (state.active + 1) * GOOD_COUNT);
  }
  return {
    board,
    state,
    player: state.toAct,
    seed: 91,
    config: { ...tierByName('Aeneas'), budget: 32, setupBudget: 0, timeLimitMs: 0 },
  };
}
afterEach(() => vi.restoreAllMocks());

describe('optional deadline compatibility', () => {
  it('keeps the public ranked result runtime shape, including its seeded tie field', () => {
    const ranked = rankedDecisions(request(false));
    expect(Object.keys(ranked[0])).toEqual(['action', 'value', 'tie']);
  });
  it('never reads the clock when off and preserves exact results with zero or a nonexpiring inherited deadline', () => {
    for (const [search, main] of [
      [planTurn, true],
      [searchMCTS, true],
      [choosePlacement, false],
      [rankedDecisions, false],
    ] as const) {
      const input = request(main);
      delete input.config.timeLimitMs;
      const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
      const uncapped = search(input);
      const zero = search({ ...input, config: { ...input.config, timeLimitMs: 0 } });
      const offReads = clock.mock.calls.length;
      const inherited = search({
        ...input,
        deadline: 1000,
        config: { ...input.config, timeLimitMs: 2 },
      });
      clock.mockRestore();
      expect(offReads).toBe(0);
      expect(zero).toEqual(uncapped);
      expect(inherited).toEqual(uncapped);
    }
  });
  it('honors an expired enclosing deadline instead of granting a new allowance', () => {
    const input = request();
    const before = serializeState(input.state);
    vi.spyOn(performance, 'now').mockReturnValue(1);
    const result = planTurn({
      ...input,
      deadline: 0,
      config: { ...input.config, timeLimitMs: 3000 },
    });
    expect(result.nodes).toBe(0);
    expect(result.action.type).toBe('endTurn');
    expect(isLegal(input.board, input.state, result.action)).toBe(true);
    expect(serializeState(input.state)).toBe(before);
  });
  it('creates and obeys a local allowance when there is no enclosing deadline', () => {
    const input = request();
    let ticks = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => ticks++);
    const result = planTurn({ ...input, config: { ...input.config, timeLimitMs: 3 } });
    expect(result.nodes).toBe(0);
    expect(result.action.type).toBe('endTurn');
    expect(Number.isFinite(result.value)).toBe(true);
  });
});

describe('planner atomic evaluation cutoff', () => {
  it('finishes all eleven roll outcomes when time expires inside an expectation', () => {
    const input = request();
    input.config.lookahead = true;
    const before = serializeState(input.state),
      root = cloneState(input.state);
    randomizeHidden(root, input.seed);
    apply(input.board, root, { type: 'endTurn' });
    const evaluate = value.evaluate;
    const expected = DICE_OUTCOMES.reduce((sum, outcome) => {
      const after = cloneState(root);
      apply(input.board, after, { type: 'roll' }, outcome.total);
      return (
        sum + outcome.probability * evaluate(input.board, after, input.config.weights)[input.player]
      );
    }, 0);
    let now = 0,
      evaluations = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(value, 'evaluate').mockImplementation((...args) => {
      evaluations++;
      if (evaluations === 2) now = 20;
      return evaluate(...args);
    });
    const result = planTurn({ ...input, deadline: 10 });
    expect(evaluations).toBe(12);
    expect(result.nodes).toBe(0);
    expect(result.action.type).toBe('endTurn');
    expect(result.value).toBeCloseTo(expected, 14);
    expect(result.candidates).toHaveLength(1);
    expect(serializeState(input.state)).toBe(before);
  });
  it('counts a started child and keeps its completed evaluation before stopping', () => {
    const input = request(),
      before = serializeState(input.state),
      evaluate = value.evaluate;
    let now = 0,
      evaluations = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(value, 'evaluate').mockImplementation((...args) => {
      evaluations++;
      if (evaluations === 3) now = 20;
      return evaluate(...args);
    });
    const result = planTurn({ ...input, deadline: 10 });
    expect(evaluations).toBe(3);
    expect(result.nodes).toBe(1);
    expect(Number.isFinite(result.value)).toBe(true);
    expect(isLegal(input.board, input.state, result.action)).toBe(true);
    expect(serializeState(input.state)).toBe(before);
  });
});

describe('placement ranking and forecast cutoff', () => {
  it('returns a sanitized legal fallback without any evaluation when already expired', () => {
    const input = request(false),
      before = serializeState(input.state);
    vi.spyOn(performance, 'now').mockReturnValue(20);
    const evaluated = vi.spyOn(value, 'evaluate');
    const result = choosePlacement({
      ...input,
      deadline: 10,
      config: { ...input.config, setupBudget: 4096 },
    });
    expect(result.nodes).toBe(0);
    expect(evaluated).not.toHaveBeenCalled();
    expect(isLegal(input.board, input.state, result.action)).toBe(true);
    expect(serializeState(input.state)).toBe(before);
  });
  it('publishes only completed ranked successors and keeps the actual evaluation count', () => {
    const input = request(false),
      before = serializeState(input.state),
      evaluate = value.evaluate;
    let now = 0,
      evaluations = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(value, 'evaluate').mockImplementation((...args) => {
      evaluations++;
      if (evaluations === 3) now = 20;
      return evaluate(...args);
    });
    const result = choosePlacement({ ...input, deadline: 10 });
    expect(result.nodes).toBe(3);
    expect(evaluations).toBe(3);
    expect(isLegal(input.board, input.state, result.action)).toBe(true);
    expect(serializeState(input.state)).toBe(before);
  });
  it('counts a partial future setup ranking but never promotes it as a complete continuation', () => {
    const input = request(false),
      before = serializeState(input.state),
      evaluate = value.evaluate;
    const ranked = rankedDecisions(input),
      rootNodes = ranked.length;
    let now = 0,
      evaluations = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(value, 'evaluate').mockImplementation((...args) => {
      evaluations++;
      if (evaluations === rootNodes + 1) now = 20;
      return evaluate(...args);
    });
    const result = choosePlacement({
      ...input,
      deadline: 10,
      config: { ...input.config, setupBudget: 4096 },
    });
    expect(result.nodes).toBe(rootNodes + 1);
    expect(evaluations).toBe(rootNodes + 1);
    expect(result.action).toEqual(ranked[0].action);
    expect(result.value).toBe(ranked[0].value);
    expect(result.won).toBe(false);
    expect(serializeState(input.state)).toBe(before);
  });
});

describe('MCTS root, iteration, and depth cutoff', () => {
  it('does no node work for an expired root, including a forced single-action root', () => {
    const input = request();
    const forced = request();
    forced.state.phase = 'roll';
    vi.spyOn(performance, 'now').mockReturnValue(20);
    for (const root of [input, forced]) {
      const before = serializeState(root.state),
        result = searchMCTS({ ...root, deadline: 10 });
      expect(result.nodes).toBe(0);
      expect(isLegal(root.board, root.state, result.action)).toBe(true);
      expect(serializeState(root.state)).toBe(before);
    }
  });
  it('interrupts root-win probes without adding nodes or a fresh leaf after expiry', () => {
    const input = request(),
      before = serializeState(input.state);
    let ticks = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => ticks++);
    const evaluated = vi.spyOn(value, 'evaluate');
    const result = searchMCTS({ ...input, deadline: 3 });
    expect(result.nodes).toBe(2);
    expect(evaluated).not.toHaveBeenCalled();
    expect(isLegal(input.board, input.state, result.action)).toBe(true);
    expect(serializeState(input.state)).toBe(before);
  });
  it('finishes and backs up one complete leaf, then stops before another iteration', () => {
    const input = request(),
      before = serializeState(input.state),
      evaluate = value.evaluate;
    const probes = legalActions(input.board, input.state).length;
    let now = 0,
      evaluations = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(value, 'evaluate').mockImplementation((...args) => {
      evaluations++;
      now = 20;
      return evaluate(...args);
    });
    const result = searchMCTS({ ...input, deadline: 10 });
    expect(evaluations).toBe(1);
    expect(result.nodes).toBe(probes + 1);
    expect(Number.isFinite(result.value)).toBe(true);
    expect(isLegal(input.board, input.state, result.action)).toBe(true);
    expect(serializeState(input.state)).toBe(before);
  });
  it('stops a deeper traversal at its next depth boundary and still backs up the completed path', () => {
    const input = request(),
      before = serializeState(input.state),
      evaluate = value.evaluate;
    const probes = legalActions(input.board, input.state).length;
    input.config.budget = probes + 10;
    let ticks = 0,
      evaluations = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (ticks++ >= 3 * probes + 3 ? 20 : 0));
    vi.spyOn(value, 'evaluate').mockImplementation((...args) => {
      evaluations++;
      return evaluate(...args);
    });
    const result = searchMCTS({ ...input, deadline: 10 });
    expect(result.nodes).toBe(2 * probes + 1);
    expect(evaluations).toBe(probes + 1);
    expect(isLegal(input.board, input.state, result.action)).toBe(true);
    expect(serializeState(input.state)).toBe(before);
  });
});
