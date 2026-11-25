/** Tactical, information-boundary and adversarial trade checks for the browser AI. */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  createGame,
  cloneState,
  apply,
  Card,
  Good,
  GOOD_COUNT,
  isLegal,
  stateHash,
  type GameState,
  type Action,
} from '../src/engine/index.js';
import {
  createAIBot,
  TIERS,
  planTurn,
  searchMCTS,
  acceptsTrade,
  proposeTrade,
  FEATURE_NAMES,
  W0,
  evaluate,
  type SearchConfig,
} from '../src/ai/index.js';
const config: SearchConfig = {
  engine: 'planner',
  budget: 200,
  weights: W0,
  noise: 0,
  randomMove: 0,
  eps: 0.001,
  delta: 0.01,
  openingTopK: 1,
  lookahead: false,
};
function main(seed: string = 'search') {
  const game = createGame(seed);
  Object.assign(game.state, { phase: 'main', active: 0, toAct: 0, turn: 1, turnIndex: 0 });
  game.state.turnOrder.set([0, 1, 2]);
  return game;
}
function tradeWeights() {
  const weights = W0.map(() => 0);
  weights[FEATURE_NAMES.indexOf('handTimber')] = 0.8;
  weights[FEATURE_NAMES.indexOf('handHorses')] = -0.8;
  return weights;
}
describe('turn search', () => {
  it('finds a two-action market then Monument win this turn', () => {
    const { board, state } = main();
    state.cards[Card.Monument] = 11;
    state.row.fill(Card.Monument);
    state.market[Good.Horses] = 6;
    state.hands.set([0, 4, 1, 1, 0]);
    const result = planTurn({ board, state, player: 0, config, seed: 7 });
    expect(result.won).toBe(true);
    expect(result.plan.length).toBeGreaterThan(1);
    for (const action of result.plan) apply(board, state, action);
    expect(state.winnerId).toBe(0);
  });
  it.each(TIERS.map((t) => t.name))(
    '%s cannot distinguish two hidden deck permutations',
    (name) => {
      for (const phase of ['setupSteading', 'main'] as const) {
        const { board, state } = main(`privacy-${phase}`);
        state.phase = phase;
        if (phase === 'main') {
          state.hands.fill(9, 0, GOOD_COUNT);
          state.vertexOwner[0] = 0;
          state.vertexKind[0] = 1;
        }
        const other = cloneState(state);
        other.deck.set([...other.deck.subarray(0, other.deckCount)].reverse());
        const before = stateHash(state);
        const a = createAIBot(name, 'same-seed').chooseAction(board, state, 0);
        const b = createAIBot(name, 'same-seed').chooseAction(board, other, 0);
        expect(a).toEqual(b);
        expect(isLegal(board, state, a)).toBe(true);
        expect(stateHash(state)).toBe(before);
      }
    },
  );
  it('runs seeded UCT directly, including the forced roll phase, without mutating its source', () => {
    const { board, state } = main('uct');
    state.hands.set([1, 1, 1, 1, 1]);
    state.vertexOwner[0] = 0;
    state.vertexKind[0] = 1;
    const request = { board, state, player: 0, config: { ...config, budget: 128 }, seed: 29 };
    const hash = stateHash(state);
    const a = searchMCTS(request),
      b = searchMCTS(request);
    expect(a.action).toEqual(b.action);
    expect(isLegal(board, state, a.action)).toBe(true);
    expect(a.nodes).toBeGreaterThan(0);
    expect(stateHash(state)).toBe(hash);
    state.phase = 'roll';
    expect(searchMCTS({ ...request, state }).action).toEqual({ type: 'roll' });
  });
  it('has no Node imports anywhere under src/ai', () => {
    function visit(dir: string) {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (name.endsWith('.ts'))
          expect(readFileSync(p, 'utf8')).not.toMatch(
            /(?:from\s*|import\s*\()\s*['"](?:node:|fs['"]|path['"]|os['"]|child_process['"])/,
          );
        else if (!name.includes('.') && name !== 'weights') visit(p);
      }
    }
    visit('src/ai');
  });
  it('repeats a complete seeded game with identical state hashes', async () => {
    const a = createGame('ai-replay'),
      b = createGame('ai-replay');
    const botsA = [0, 1, 2].map((p) => createAIBot('Paris', p, { budget: 8 })),
      botsB = [0, 1, 2].map((p) => createAIBot('Paris', p, { budget: 8 }));
    let steps = 0;
    while (a.state.phase !== 'gameOver') {
      if (steps++ % 100 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      const p = a.state.toAct;
      const action = botsA[p].chooseAction(a.board, a.state, p);
      expect(action).toEqual(botsB[p].chooseAction(b.board, b.state, p));
      apply(a.board, a.state, action);
      apply(b.board, b.state, action);
    }
    expect(stateHash(a.state)).toBe(stateHash(b.state));
  }, 120000);
});
describe('trade anti-farming', () => {
  it('accepts an improving exchange and rejects repeated attempts to trade away useful goods for junk', () => {
    const { board, state } = main();
    state.hands[Good.Timber] = 5;
    state.hands[GOOD_COUNT + Good.Horses] = 5;
    const offer: Action = {
      type: 'proposeTrade',
      to: 1,
      give: [1, 0, 0, 0, 0],
      get: [0, 0, 0, 0, 1],
    };
    apply(board, state, offer);
    const settings = { ...config, weights: tradeWeights() };
    expect(acceptsTrade(board, state, 1, settings, 9)).toBe(true);
    apply(board, state, { type: 'respondTrade', accept: true });
    for (let i = 0; i < 3; i++) {
      const test = cloneState(state);
      test.proposals = 0;
      test.active = test.toAct = 0;
      test.phase = 'main';
      test.hands[Good.Horses] = 3;
      test.hands[GOOD_COUNT + Good.Timber] = 3;
      apply(board, test, {
        type: 'proposeTrade',
        to: 1,
        give: [0, 0, 0, 0, 1],
        get: [1, 0, 0, 0, 0],
      });
      expect(acceptsTrade(board, test, 1, settings, 9)).toBe(false);
    }
  });
  it('rejects a recipient-improving trade that lets the proposer win immediately', () => {
    const { board, state } = main('finishing-trade');
    state.cards[Card.Monument] = 11;
    state.row.fill(Card.Monument);
    state.hands.set([1, 0, 1, 1, 0]);
    state.hands[GOOD_COUNT + Good.Horses] = 1;
    apply(board, state, {
      type: 'proposeTrade',
      to: 1,
      give: [1, 0, 0, 0, 0],
      get: [0, 0, 0, 0, 1],
    });
    const settings = { ...config, weights: tradeWeights() };
    const before = evaluate(board, state, settings.weights);
    const after = cloneState(state);
    apply(board, after, { type: 'respondTrade', accept: true });
    expect(evaluate(board, after, settings.weights)[1]).toBeGreaterThan(before[1]);
    expect(acceptsTrade(board, state, 1, settings, 17)).toBe(false);
  });
  it('rejects a finishing market sequence even when the bounded planner misses it', () => {
    const { board, state } = main('bounded-miss');
    state.cards[Card.Monument] = 11;
    state.row.fill(Card.Monument);
    state.hands.set([11, 10, 0, 0, 0]);
    state.hands[GOOD_COUNT + Good.Horses] = 1;
    apply(board, state, {
      type: 'proposeTrade',
      to: 1,
      give: [1, 0, 0, 0, 0],
      get: [0, 0, 0, 0, 1],
    });
    const settings = { ...config, weights: tradeWeights() };
    expect(acceptsTrade(board, state, 1, settings, 17)).toBe(false);
    const after = cloneState(state);
    apply(board, after, { type: 'respondTrade', accept: true });
    for (const action of [
      { type: 'marketBuy', pay: Good.Clay, get: Good.Grain },
      { type: 'marketBuy', pay: Good.Clay, get: Good.Bronze },
      { type: 'buyCard', slot: 0 },
    ] as Action[])
      apply(board, after, action);
    expect(after.winnerId).toBe(0);
  });
  it('rejects a positive recipient gain when the proposer gains too much more', () => {
    const { board, state } = main('relative-gain');
    state.hands.set([3, 2, 0, 0, 3, 1, 0, 3, 3, 0, 0, 0, 2, 3, 3]);
    apply(board, state, {
      type: 'proposeTrade',
      to: 1,
      give: [0, 1, 0, 0, 0],
      get: [0, 0, 1, 0, 0],
    });
    const before = evaluate(board, state, W0);
    const after = cloneState(state);
    apply(board, after, { type: 'respondTrade', accept: true });
    const next = evaluate(board, after, W0);
    expect(next[1] - before[1]).toBeGreaterThan(config.eps);
    expect(next[0] - before[0]).toBeGreaterThan(next[1] - before[1] + 0.005);
    expect(acceptsTrade(board, state, 1, { ...config, delta: 0.005 }, 1)).toBe(false);
  });
  it('rejects trades that let the proposer win below twelve at the turn cap', () => {
    const { board, state } = main('cap-trade');
    state.turn = 600;
    state.cards[Card.Monument] = 2;
    state.hands[Good.Timber] = 3;
    state.hands[GOOD_COUNT + Good.Horses] = 1;
    apply(board, state, {
      type: 'proposeTrade',
      to: 1,
      give: [1, 0, 0, 0, 0],
      get: [0, 0, 0, 0, 1],
    });
    expect(acceptsTrade(board, state, 1, { ...config, weights: tradeWeights() }, 1)).toBe(false);
    const accepted = cloneState(state);
    apply(board, accepted, { type: 'respondTrade', accept: true });
    apply(board, accepted, { type: 'endTurn' });
    expect(accepted.winnerId).toBe(0);
  });
  it('enforces eps and proposer-relative gain, and never proposes past the stricter two-offer limit', () => {
    const { board, state } = main('strict-trade');
    state.hands[Good.Timber] = 2;
    state.hands[GOOD_COUNT + Good.Horses] = 2;
    apply(board, state, {
      type: 'proposeTrade',
      to: 1,
      give: [1, 0, 0, 0, 0],
      get: [0, 0, 0, 0, 1],
    });
    expect(acceptsTrade(board, state, 1, { ...config, weights: tradeWeights(), eps: 1 }, 1)).toBe(
      false,
    );
    apply(board, state, { type: 'respondTrade', accept: false });
    state.proposals = 2;
    expect(proposeTrade(board, state, 0, config, 1)).toBeNull();
  });
});
