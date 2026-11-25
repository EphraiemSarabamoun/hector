/** Opt-in setup forecasts share the public value model and obey a strict successor budget. */
import { describe, it, expect, vi } from 'vitest';
import {
  createGame,
  apply,
  cloneState,
  legalActions,
  isLegal,
  serializeState,
} from '../src/engine/index.js';
import { choosePlacement, rankedDecisions, validatedSetupBudget } from '../src/ai/placement.js';
import { createAIBot } from '../src/ai/index.js';
import { W0 } from '../src/ai/value.js';
import * as valueModel from '../src/ai/value.js';
import type { SearchConfig } from '../src/ai/types.js';
const config: SearchConfig = {
  engine: 'planner',
  budget: 10,
  weights: W0,
  noise: 0,
  randomMove: 0,
  eps: 0.001,
  delta: 0.01,
  openingTopK: 1,
  lookahead: false,
};

describe('public setup forecast', () => {
  it('keeps existing immediate policy when omitted or zero', () => {
    const { board, state } = createGame('setup-default');
    const request = { board, state, player: state.toAct, seed: 81, config };
    expect(choosePlacement({ ...request, config: { ...config, setupBudget: 0 } })).toEqual(
      choosePlacement(request),
    );
    expect(createAIBot('Aeneas', 2).config.setupBudget ?? 0).toBe(0);
  });
  it.each([-1, NaN, Infinity, 0.5])(
    'rejects invalid setup budget %s at both direct API boundaries',
    (setupBudget) => {
      const { board, state } = createGame('setup-invalid-budget');
      expect(() =>
        choosePlacement({
          board,
          state,
          player: state.toAct,
          seed: 9,
          config: { ...config, setupBudget },
        }),
      ).toThrow('Setup budget must be a nonnegative safe integer');
      expect(() => createAIBot('Aeneas', 9, { setupBudget })).toThrow(
        'Setup budget must be a nonnegative safe integer',
      );
    },
  );
  it('validates missing, zero, and positive integer budgets through the same helper', () => {
    expect(validatedSetupBudget({})).toBe(0);
    expect(validatedSetupBudget({ setupBudget: 0 })).toBe(0);
    expect(validatedSetupBudget({ setupBudget: 512 })).toBe(512);
  });
  it('does not report a setup win when softmax saturates to one', () => {
    const { board, state } = createGame('setup-saturated-value');
    const weights = W0.map(() => 0);
    weights[0] = 1000;
    const before = serializeState(state);
    const result = choosePlacement({
      board,
      state,
      player: state.toAct,
      seed: 19,
      config: { ...config, weights },
    });
    expect(result.value).toBe(1);
    expect(result.won).toBe(false);
    const successor = cloneState(state);
    apply(board, successor, result.action);
    expect(successor.winnerId).toBe(-1);
    expect(serializeState(state)).toBe(before);
  });
  it('counts every evaluation and stays within small and large budgets in both setup phases', () => {
    const { board, state } = createGame('setup-budget');
    for (const phase of ['setupSteading', 'setupTrack']) {
      if (phase === 'setupTrack')
        apply(
          board,
          state,
          choosePlacement({ board, state, player: state.toAct, seed: 15, config }).action,
        );
      expect(state.phase).toBe(phase);
      const before = serializeState(state);
      for (const setupBudget of [1, 64, 512, 1024, 4096]) {
        const spy = vi.spyOn(valueModel, 'evaluate');
        try {
          const result = choosePlacement({
            board,
            state,
            player: state.toAct,
            seed: 98,
            config: { ...config, setupBudget },
          });
          expect(result.nodes).toBe(spy.mock.calls.length);
          expect(result.nodes).toBeLessThanOrEqual(setupBudget);
          expect(result.nodes).toBeGreaterThan(0);
          expect(isLegal(board, state, result.action)).toBe(true);
          expect(serializeState(state)).toBe(before);
        } finally {
          spy.mockRestore();
        }
      }
    }
  });
  it('falls back to immediate root rank when no continuation fits the remaining budget', () => {
    const { board, state } = createGame('setup-fallback');
    const request = { board, state, player: state.toAct, seed: 44, config };
    const ranked = rankedDecisions(request);
    const result = choosePlacement({
      ...request,
      config: { ...config, setupBudget: legalActions(board, state).length },
    });
    expect(result.action).toEqual(ranked[0].action);
    expect(result.value).toBe(ranked[0].value);
    expect(result.nodes).toBe(ranked.length);
  });
  it('samples tiny-budget roots with a seeded shuffle rather than a fixed vertex prefix', () => {
    const { board, state } = createGame('setup-tiny-sampling');
    const choices = new Set<string>();
    for (let seed = 0; seed < 12; seed++) {
      const request = {
        board,
        state,
        player: state.toAct,
        seed,
        config: { ...config, setupBudget: 1 },
      };
      const result = choosePlacement(request);
      expect(choosePlacement(request)).toEqual(result);
      choices.add(JSON.stringify(result.action));
    }
    expect(choices.size).toBeGreaterThan(1);
  });
  it('is deterministic and invariant to unseen deck order or dice stream', () => {
    const { board, state } = createGame('setup-hidden-order');
    const altered = cloneState(state);
    altered.deck.subarray(0, altered.deckCount).reverse();
    altered.rng ^= 0x12345678;
    const request = {
      board,
      state,
      player: state.toAct,
      seed: 123,
      config: { ...config, setupBudget: 4096 },
    };
    const before = serializeState(altered);
    expect(choosePlacement(request)).toEqual(choosePlacement({ ...request, state: altered }));
    expect(choosePlacement(request)).toEqual(choosePlacement(request));
    expect(serializeState(altered)).toBe(before);
  });
  it('can choose a different opening after forecasting the remaining public setup', () => {
    let changed = false;
    for (let seed = 0; seed < 8 && !changed; seed++) {
      const { board, state } = createGame(`setup-forecast-${seed}`);
      const request = { board, state, player: state.toAct, seed: 24, config };
      const immediate = choosePlacement(request),
        forecast = choosePlacement({ ...request, config: { ...config, setupBudget: 8192 } });
      expect(forecast.nodes).toBeLessThanOrEqual(8192);
      expect(isLegal(board, state, forecast.action)).toBe(true);
      changed = JSON.stringify(immediate.action) !== JSON.stringify(forecast.action);
    }
    expect(changed).toBe(true);
  });
});
