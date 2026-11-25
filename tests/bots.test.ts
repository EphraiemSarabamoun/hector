/** Tactical baseline promises matter for interpreting tournament lengths. */
import { expect, it } from 'vitest';
import { createGame, Card, GOOD_COUNT } from '../src/engine/index.js';
import { GreedyBot } from '../src/bots/index.js';
it.each(['muster', 'raid'] as const)(
  'greedy wins now by taking Warlord with %s before other development',
  (mode) => {
    const { board, state } = createGame('bot-title');
    state.phase = 'main';
    state.turn = 1;
    state.active = state.toAct = 0;
    state.musters[0] = 2;
    state.cards[Card.Monument] = 10;
    state.row.fill(Card.Granary);
    if (mode === 'muster') state.hands.fill(20, 0, GOOD_COUNT);
    else state.cards[Card.Raid] = 1;
    expect(new GreedyBot().chooseAction(board, state, 0)).toEqual(
      mode === 'muster' ? { type: 'muster' } : { type: 'playCard', card: Card.Raid },
    );
  },
);
