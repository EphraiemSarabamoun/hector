/** Worker message cloning must preserve turn-local cache and offer identity. */
import { describe, it, expect, vi } from 'vitest';
import { createGame, apply, Card, Good, isLegal } from '../src/engine/index.js';
import { createAIBot } from '../src/ai/index.js';
import { boardKey } from '../src/ai/board-key.js';
import * as planner from '../src/ai/planner.js';

describe('structured-cloned maps', () => {
  it('recognizes full equivalent maps and distinguishes a same-seed changed map', () => {
    const { board } = createGame('worker-map');
    expect(boardKey(structuredClone(board))).toBe(boardKey(board));
    const changed = structuredClone(board);
    Object.assign(changed.hexes[0], { number: changed.hexes[0].number + 1 });
    expect(boardKey(changed)).not.toBe(boardKey(board));
  });
  it('reuses a multi-action winning plan across freshly cloned Worker messages', () => {
    const { board, state } = createGame('worker-plan');
    Object.assign(state, { phase: 'main', active: 0, toAct: 0, turn: 1, turnIndex: 0 });
    state.turnOrder.set([0, 1, 2]);
    state.cards[Card.Monument] = 11;
    state.row.fill(Card.Monument);
    state.market[Good.Horses] = 6;
    state.hands.set([0, 4, 1, 1, 0]);
    const bot = createAIBot('Aeneas', 7, { budget: 200, tradeProposals: 0 });
    const spy = vi.spyOn(planner, 'planTurn');
    try {
      for (let step = 0; state.winnerId < 0 && step < 10; step++) {
        const action = bot.chooseAction(structuredClone(board), state, 0);
        expect(isLegal(board, state, action)).toBe(true);
        apply(board, state, action);
      }
      expect(state.winnerId).toBe(0);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
