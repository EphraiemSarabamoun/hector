/** Privacy and baseline symmetry checks for search callers sharing the public engine. */
import { describe, it, expect } from 'vitest';
import {
  Building,
  Card,
  CARD_COUNT,
  GOOD_COUNT,
  createGame,
  cloneState,
  randomizeHidden,
  serializeState,
  deserializeState,
  stateHash,
  legalActions,
  isLegal,
  apply,
} from '../src/engine/index.js';
import { GreedyBot, RandomBot, createBot } from '../src/bots/index.js';

describe('search privacy hook', () => {
  it('canonicalizes equivalent hidden permutations before sampling and preserves the public position', () => {
    const { state } = createGame('privacy');
    const original = serializeState(state);
    const a = cloneState(state),
      b = cloneState(state);
    b.deck.subarray(0, b.deckCount).reverse();
    b.deck.fill(Card.Granary, b.deckCount);
    b.rng = 7;
    randomizeHidden(a, 'sample');
    randomizeHidden(b, 'sample');
    expect(serializeState(a)).toBe(serializeState(b));
    expect(serializeState(state)).toBe(original);
    expect([...a.deck.subarray(0, a.deckCount)].sort()).toEqual(
      [...state.deck.subarray(0, state.deckCount)].sort(),
    );
    expect(a.deck.subarray(a.deckCount).every((x) => x === 0)).toBe(true);
    const publicA = { ...a, deck: state.deck, rng: state.rng };
    expect(serializeState(publicA)).toBe(original);
    const other = cloneState(state);
    randomizeHidden(other, 'other');
    expect(other.rng).not.toBe(a.rng);
  });
  it('handles an empty unseen deck and keeps restored samples replayable', () => {
    const { state } = createGame('empty-private');
    state.deckCount = 0;
    const sample = cloneState(state);
    randomizeHidden(sample, 42);
    expect(sample.deck.every((x) => x === 0)).toBe(true);
    expect(stateHash(deserializeState(serializeState(sample)))).toBe(stateHash(sample));
  });
  it('baseline decisions do not depend on the real hidden order', () => {
    const { board, state } = createGame('private-baselines');
    const altered = cloneState(state);
    altered.deck.subarray(0, altered.deckCount).reverse();
    for (const name of ['random', 'greedy'])
      expect(createBot(name, 12).chooseAction(board, state, state.toAct)).toEqual(
        createBot(name, 12).chooseAction(board, altered, altered.toAct),
      );
  });
  it('every difficulty ignores original hidden permutations in setup and main search', async () => {
    const { createAIBot, TIERS } = await import('../src/ai/index.js');
    const { board, state } = createGame('private-every-tier');
    for (const main of [false, true]) {
      const a = cloneState(state);
      if (main) {
        a.phase = 'main';
        a.turn = 1;
        a.vertexOwner[0] = a.active;
        a.vertexKind[0] = Building.Steading;
        a.hands.fill(20, a.active * GOOD_COUNT, (a.active + 1) * GOOD_COUNT);
      }
      const b = cloneState(a);
      b.deck.subarray(0, b.deckCount).reverse();
      b.rng ^= 12345;
      for (const tier of TIERS) {
        const overrides = { budget: 16, setupBudget: 0 };
        expect(createAIBot(tier.name, 'same', overrides).chooseAction(board, a, a.toAct)).toEqual(
          createAIBot(tier.name, 'same', overrides).chooseAction(board, b, b.toAct),
        );
      }
    }
  });
});

describe('seeded greedy ties', () => {
  it('plunders equally attractive opponents without preferring the lower player ID', () => {
    const { board, state } = createGame('plunder-ties');
    state.phase = 'plunder';
    state.active = 0;
    state.toAct = 0;
    const hex = board.hexes[state.warband];
    for (const [i, p] of [
      [0, 1],
      [2, 2],
    ]) {
      state.vertexOwner[hex.vertices[i]] = p;
      state.vertexKind[hex.vertices[i]] = Building.Steading;
      state.hands[p * GOOD_COUNT] = 1;
    }
    const counts = [0, 0, 0];
    for (let seed = 0; seed < 1000; seed++) {
      const bot = new GreedyBot(seed);
      const action = bot.chooseAction(board, state, 0);
      expect(action.type).toBe('plunder');
      if (action.type === 'plunder') counts[action.victim]++;
      expect(new GreedyBot(seed).chooseAction(board, state, 0)).toEqual(action);
    }
    expect(counts[1]).toBeGreaterThan(450);
    expect(counts[1]).toBeLessThan(550);
  });
  it('randomizes direct upgrade and immediate-winning candidate choices', () => {
    const { board, state } = createGame('upgrade-ties');
    state.phase = 'main';
    state.turn = 1;
    state.active = 0;
    state.toAct = 0;
    state.hands.fill(30);
    state.row.fill(Card.Caravan);
    const sites: number[] = [];
    for (const v of board.vertices)
      if (!v.shrine && sites.every((other) => other !== v.id && !v.neighbours.includes(other))) {
        sites.push(v.id);
        if (sites.length === 6) break;
      }
    const kinds = [
      Building.Citadel,
      Building.Town,
      Building.Town,
      Building.Town,
      Building.Steading,
      Building.Steading,
    ];
    sites.forEach((v, i) => {
      state.vertexOwner[v] = 0;
      state.vertexKind[v] = kinds[i];
    });
    const winners = new Set<number>();
    for (let seed = 0; seed < 40; seed++) {
      const action = new GreedyBot(seed).chooseAction(board, state, 0);
      expect(action.type).toBe('upgrade');
      if (action.type === 'upgrade') winners.add(action.v);
      const next = cloneState(state);
      apply(board, next, action);
      expect(next.winnerId).toBe(0);
    }
    expect(winners.size).toBeGreaterThan(1);
    state.vertexOwner.fill(-1);
    state.vertexKind.fill(Building.Empty);
    sites.slice(0, 2).forEach((v) => {
      state.vertexOwner[v] = 0;
      state.vertexKind[v] = Building.Steading;
    });
    const upgrades = new Set<number>();
    for (let seed = 0; seed < 40; seed++) {
      const a = new GreedyBot(seed).chooseAction(board, state, 0);
      if (a.type === 'upgrade') upgrades.add(a.v);
    }
    expect(upgrades.size).toBe(2);
  });
  it('keeps seeded full-game action choices reproducible without changing the callers position', () => {
    const a = createGame('greedy-repeat'),
      b = createGame('greedy-repeat');
    const botA = new GreedyBot(5),
      botB = new GreedyBot(5);
    for (let step = 0; step < 300 && a.state.phase !== 'gameOver'; step++) {
      const before = stateHash(a.state);
      const action = botA.chooseAction(a.board, a.state, a.state.toAct);
      expect(stateHash(a.state)).toBe(before);
      expect(botB.chooseAction(b.board, b.state, b.state.toAct)).toEqual(action);
      apply(a.board, a.state, action);
      apply(b.board, b.state, action);
      expect(stateHash(a.state)).toBe(stateHash(b.state));
    }
  });
});

describe('optimized legal moves and fingerprints', () => {
  it('matches direct validation for every market and upgrade through a complete game', () => {
    const { board, state } = createGame('fast-validation');
    const bot = new RandomBot(90);
    while (state.phase !== 'gameOver') {
      if (state.phase === 'main') {
        const actions = legalActions(board, state);
        for (let pay = 0; pay < GOOD_COUNT; pay++)
          for (let get = 0; get < GOOD_COUNT; get++) {
            const action = { type: 'marketBuy', pay, get } as const;
            expect(
              actions.some((a) => a.type === 'marketBuy' && a.pay === pay && a.get === get),
            ).toBe(isLegal(board, state, action));
          }
        for (const v of board.vertices)
          expect(actions.some((a) => a.type === 'upgrade' && a.v === v.id)).toBe(
            isLegal(board, state, { type: 'upgrade', v: v.id }),
          );
      }
      apply(board, state, bot.chooseAction(board, state, state.toAct));
    }
  });
  it('hashes every scalar and typed buffer, independent of JSON property insertion order', () => {
    const { state } = createGame('hash-fields');
    const original = stateHash(state);
    for (const key of Object.keys(state) as (keyof typeof state)[]) {
      const copy = cloneState(state);
      const value = copy[key];
      if (typeof value === 'number') (copy as unknown as Record<string, unknown>)[key] = value + 1;
      else if (typeof value === 'string') copy.phase = 'main';
      else value[0]++;
      expect(stateHash(copy), key).not.toBe(original);
    }
    const reordered = Object.fromEntries(
      Object.entries(state).reverse(),
    ) as unknown as typeof state;
    expect(stateHash(reordered)).toBe(original);
  });
});
