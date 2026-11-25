/** Browser-only clock caps must be explicit and must leave deterministic experiments clock-free. */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGame,
  apply,
  deserializeState,
  isLegal,
  serializeState,
} from '../src/engine/index.js';
import { createAIBot, tierByName } from '../src/ai/index.js';
import { validatedTimeLimit, withDecisionDeadline } from '../src/ai/time.js';
import { makeBot, resolvedTierConfig } from '../tools/ai-common.js';
import type { SearchConfig } from '../src/ai/types.js';
afterEach(() => vi.restoreAllMocks());

describe('browser timing boundary', () => {
  it('keeps browser metadata separate from the arena runtime configuration', () => {
    expect(tierByName('Hector').browserTimeLimitMs).toBe(3000);
    expect(createAIBot('Hector', 1).config.timeLimitMs).toBeUndefined();
    expect(createAIBot('Hector', 1, { timeLimitMs: 3000 }).config.timeLimitMs).toBe(3000);
    for (const name of ['Hector', 'Trader']) {
      const entrant = { name, overrides: { timeLimitMs: 3000 } };
      expect(resolvedTierConfig(entrant)?.timeLimitMs).toBe(0);
      const bot = makeBot(entrant, 1, () => tierByName('Hector')) as { config?: SearchConfig };
      expect(bot.config?.timeLimitMs).toBe(0);
    }
  });
  it('never consults the clock when no runtime cap is enabled', () => {
    const { board, state } = createGame('clock-free');
    vi.spyOn(performance, 'now').mockImplementation(() => {
      throw new Error('Uncapped inference must not read a clock');
    });
    for (const timeLimitMs of [undefined, 0]) {
      const action = createAIBot('Aeneas', 1, { budget: 1, timeLimitMs }).chooseAction(
        board,
        state,
        state.toAct,
      );
      expect(isLegal(board, state, action)).toBe(true);
    }
  });
  it('validates runtime allowances and preserves an inherited deadline', () => {
    expect(validatedTimeLimit({})).toBe(0);
    expect(validatedTimeLimit({ timeLimitMs: 0.5 })).toBe(0.5);
    for (const value of [-1, NaN, Infinity, null, '3'])
      expect(() => createAIBot('Aeneas', 1, { timeLimitMs: value as number })).toThrow();
    const { board, state } = createGame('inherited-clock');
    const request = {
      board,
      state,
      player: state.toAct,
      config: { ...tierByName('Aeneas'), timeLimitMs: 3 },
      seed: 1,
      deadline: 42,
    };
    vi.spyOn(performance, 'now').mockImplementation(() => {
      throw new Error('Deadline must not restart');
    });
    expect(withDecisionDeadline(request)).toBe(request);
    expect(() => withDecisionDeadline({ ...request, deadline: NaN })).toThrow();
  });
  it('returns a legal nonmutating fallback when preprocessing exhausts the allowance', () => {
    const { board, state } = createGame('expired-main');
    Object.assign(state, { phase: 'main', active: 0, toAct: 0, turn: 1, turnIndex: 0 });
    state.turnOrder.set([0, 1, 2]);
    state.hands.fill(4, 0, 5);
    const before = serializeState(state);
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(2);
    const action = createAIBot('Hector', 1, { timeLimitMs: 1 }).chooseAction(board, state, 0);
    expect(action).toEqual({ type: 'endTurn' });
    expect(isLegal(board, state, action)).toBe(true);
    expect(serializeState(state)).toBe(before);
  });
  it('declines a trade when its decision allowance is already exhausted', () => {
    const fixture = JSON.parse(
      readFileSync(new URL('./fixtures/trade-cycles.jsonl', import.meta.url), 'utf8')
        .trim()
        .split('\n')[0],
    );
    const { board } = createGame(fixture.seed),
      state = deserializeState(fixture.state);
    apply(board, state, fixture.offers[0]);
    const before = serializeState(state);
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(2);
    const action = createAIBot('Hector', 1, { timeLimitMs: 1 }).chooseAction(
      board,
      state,
      state.toAct,
    );
    expect(action).toEqual({ type: 'respondTrade', accept: false, reason: 'does not help me' });
    expect(isLegal(board, state, action)).toBe(true);
    expect(serializeState(state)).toBe(before);
  });
});
