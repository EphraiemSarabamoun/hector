/** Exhaustive offer coverage and turn-local proposal bookkeeping for the optional active policy. */
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import {
  createGame,
  cloneState,
  deserializeState,
  serializeState,
  apply,
  isLegal,
  GOOD_COUNT,
  CONFIG,
  type Action,
  type Board,
  type GameState,
} from '../src/engine/index.js';
import { createAIBot, TIERS } from '../src/ai/index.js';
import {
  TRADE_BUNDLES,
  acceptsTrade,
  proposeBestTrade,
  proposeTrade,
  tradeOfferKey,
  tradeProposalLimit,
  type TradeProposal,
  type TradeProposalOptions,
} from '../src/ai/trade.js';
import { W0, evaluate } from '../src/ai/value.js';
import { FEATURE_NAMES } from '../src/ai/features.js';
import * as featureModel from '../src/ai/features.js';
import * as planner from '../src/ai/planner.js';
import type { SearchConfig } from '../src/ai/types.js';
const weights = W0.map(() => 0);
weights[FEATURE_NAMES.indexOf('handTimber')] = 0.8;
weights[FEATURE_NAMES.indexOf('handHorses')] = -0.8;
const config: SearchConfig = {
  engine: 'greedy',
  budget: 1,
  weights,
  noise: 0,
  randomMove: 0,
  eps: -1,
  delta: 2,
  openingTopK: 1,
  lookahead: false,
  tradeProposals: 4,
};
function tradePosition() {
  const game = createGame('active-trades');
  Object.assign(game.state, { phase: 'main', active: 0, toAct: 0, turn: 1, turnIndex: 0 });
  game.state.turnOrder.set([0, 1, 2]);
  game.state.hands.set([0, 0, 0, 0, 3, 3, 0, 0, 0, 0, 3, 0, 0, 0, 0]);
  return game;
}
/** Independent legal-offer oracle uses full feature extraction for every candidate and acceptance. */
function fullOracle(
  board: Board,
  state: GameState,
  player: number,
  policy: SearchConfig,
  seed: number,
  options: TradeProposalOptions = {},
) {
  const baseline = evaluate(board, state, policy.weights)[player];
  let gain = 0,
    best: TradeProposal | null = null;
  for (let offset = 1; offset < state.players; offset++) {
    const to = state.turnOrder[(state.turnIndex + offset) % state.players];
    for (const give of TRADE_BUNDLES)
      for (const get of TRADE_BUNDLES) {
        const offer: TradeProposal = { type: 'proposeTrade', to, give, get };
        if (
          options.excludedRecipients?.has(to) ||
          options.excludedOfferKeys?.has(tradeOfferKey(offer)) ||
          !isLegal(board, state, offer)
        )
          continue;
        const response = cloneState(state);
        apply(board, response, offer);
        if (!acceptsTrade(board, response, to, options.partnerConfig?.(to) ?? policy, seed))
          continue;
        apply(board, response, { type: 'respondTrade', accept: true });
        const next = evaluate(board, response, policy.weights)[player] - baseline;
        if (next > gain) {
          gain = next;
          best = offer;
        }
      }
  }
  return { gain, best };
}
function oracle(options: TradeProposalOptions = {}) {
  const { board, state } = tradePosition();
  return fullOracle(board, state, 0, config, 73, options);
}

describe('exhaustive public trade proposals', () => {
  it('contains every distinct nonempty five-good vector totaling one to three exactly once', () => {
    expect(TRADE_BUNDLES).toHaveLength(55);
    expect(new Set(TRADE_BUNDLES.map((b) => b.join(','))).size).toBe(55);
    expect(
      [1, 2, 3].map((n) => TRADE_BUNDLES.filter((b) => b.reduce((a, x) => a + x, 0) === n).length),
    ).toEqual([5, 15, 35]);
    for (let a = 0; a <= 3; a++)
      for (let b = 0; b <= 3; b++)
        for (let c = 0; c <= 3; c++)
          for (let d = 0; d <= 3; d++)
            for (let e = 0; e <= 3; e++) {
              const vector = [a, b, c, d, e],
                total = a + b + c + d + e;
              expect(TRADE_BUNDLES.some((row) => row.every((x, g) => x === vector[g]))).toBe(
                total >= 1 && total <= 3,
              );
            }
  });
  it('finds a legal maximum-gain offer with distinct partner models and honors exclusions', () => {
    const { board, state } = tradePosition();
    const before = serializeState(state);
    const partnerConfig = () => ({ ...config, eps: 0, weights: weights.map((w) => -w) });
    const options = { partnerConfig };
    const offer = proposeBestTrade(board, state, 0, config, 73, options);
    expect(offer).not.toBeNull();
    expect(isLegal(board, state, offer!)).toBe(true);
    const accepted = cloneState(state);
    apply(board, accepted, offer!);
    apply(board, accepted, { type: 'respondTrade', accept: true });
    expect(evaluate(board, accepted, weights)[0] - evaluate(board, state, weights)[0]).toBeCloseTo(
      oracle(options).gain,
      12,
    );
    expect(offer).toEqual(oracle(options).best);
    const excludedOfferKeys = new Set([tradeOfferKey(offer!)]);
    const alternate = proposeBestTrade(board, state, 0, config, 73, {
      partnerConfig,
      excludedOfferKeys,
    });
    expect(alternate).not.toBeNull();
    expect(tradeOfferKey(alternate!)).not.toBe(tradeOfferKey(offer!));
    expect(
      proposeBestTrade(board, state, 0, config, 73, { excludedRecipients: new Set([1, 2]) }),
    ).toBeNull();
    expect(
      proposeBestTrade(board, state, 0, config, 73, {
        partnerConfig: () => ({ ...config, eps: 1 }),
      }),
    ).toBeNull();
    expect(serializeState(state)).toBe(before);
  });
  it('matches independent full-evaluator selection on nonlinear real positions and differing partner weights', () => {
    for (const tier of TIERS) {
      const fixture = cycles.find((row) => row.tier === tier.name)!;
      const { board } = createGame(fixture.seed),
        state = deserializeState(fixture.state);
      const policy = { ...tier, weights: W0, tradeProposals: 4 };
      const options = {
        partnerConfig: (to: number) => ({
          ...policy,
          weights: W0.map((w) => w * (to % 2 ? 0.8 : 1.2)),
        }),
      };
      const actual = proposeBestTrade(board, state, state.active, policy, 82, options);
      const expected = fullOracle(board, state, state.active, policy, 82, options);
      expect(actual).toEqual(expected.best);
    }
  });
  it('extracts the board features once while caching hand-only changes', () => {
    const { board, state } = tradePosition();
    const spy = vi.spyOn(featureModel, 'allFeatures');
    try {
      expect(proposeBestTrade(board, state, 0, config, 73)).not.toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
  it.each(['exhaustive', 'shortage'] as const)(
    'returns the best fully evaluated legal %s offer when the shared deadline expires',
    (kind) => {
      const { board, state } = tradePosition();
      if (kind === 'shortage') {
        state.hands[5] = state.hands[10] = 0;
        state.hands[8] = state.hands[13] = 3;
      }
      const before = serializeState(state);
      const search = kind === 'exhaustive' ? proposeBestTrade : proposeTrade;
      const partnerConfig = () => ({ ...config, weights: weights.map((w) => -w) });
      let tick = 0;
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => tick++);
      try {
        const offer = search(board, state, 0, config, 73, { partnerConfig, deadline: 2 });
        expect(offer).toEqual({
          type: 'proposeTrade',
          to: 1,
          give: [0, 0, 0, 0, 1],
          get: kind === 'exhaustive' ? [1, 0, 0, 0, 0] : [0, 0, 0, 1, 0],
        });
        expect(clock).toHaveBeenCalledTimes(3);
        expect(isLegal(board, state, offer!)).toBe(true);
        const offered = cloneState(state);
        apply(board, offered, offer!);
        expect(acceptsTrade(board, offered, offer!.to, partnerConfig(), 73)).toBe(true);
        apply(board, offered, { type: 'respondTrade', accept: true });
        expect(evaluate(board, offered, weights)[0]).toBeGreaterThan(
          evaluate(board, state, weights)[0],
        );
        expect(serializeState(state)).toBe(before);
        expect(search(board, state, 0, config, 73, { deadline: 0 })).toBeNull();
      } finally {
        clock.mockRestore();
      }
    },
  );
  it('does not consult the clock when no trade deadline is supplied', () => {
    const { board, state } = tradePosition();
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
      throw new Error('Unexpected wall clock in uncapped trade policy');
    });
    try {
      expect(proposeBestTrade(board, state, 0, config, 73)).not.toBeNull();
      proposeTrade(board, state, 0, config, 73);
      expect(clock).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
  it('is invariant to unseen order and retains a default two-offer allowance with an absolute four-offer cap', () => {
    const { board, state } = tradePosition(),
      changed = cloneState(state);
    changed.deck.subarray(0, changed.deckCount).reverse();
    changed.rng++;
    expect(proposeBestTrade(board, state, 0, config, 91)).toEqual(
      proposeBestTrade(board, changed, 0, config, 91),
    );
    expect(tradeProposalLimit({})).toBe(2);
    expect(tradeProposalLimit({ tradeProposals: 99 })).toBe(CONFIG.trade.maxProposals);
    state.proposals = 2;
    expect(
      proposeBestTrade(board, state, 0, { ...config, tradeProposals: undefined }, 91),
    ).toBeNull();
    state.proposals = 4;
    expect(proposeBestTrade(board, state, 0, { ...config, tradeProposals: 99 }, 91)).toBeNull();
  });
});

describe('bot offer history', () => {
  it('actively proposes before its normal greedy action, excludes repeats after declines, and stops at four', () => {
    const { board, state } = tradePosition();
    const bot = createAIBot('Aeneas', 19, { ...config, activeTrading: true, tradeProposals: 99 });
    const keys = new Set<string>();
    for (let n = 0; n < 4; n++) {
      const action = bot.chooseAction(board, state, 0);
      expect(action.type).toBe('proposeTrade');
      if (action.type !== 'proposeTrade')
        throw new Error('Expected another unique improving offer');
      expect(keys.has(tradeOfferKey(action))).toBe(false);
      keys.add(tradeOfferKey(action));
      expect(isLegal(board, state, action)).toBe(true);
      apply(board, state, action);
      apply(board, state, { type: 'respondTrade', accept: false });
    }
    expect(state.proposals).toBe(4);
    expect(bot.chooseAction(board, state, 0).type).not.toBe('proposeTrade');
  });
  it.each([false, true])(
    'permits one offer per human across Worker board clones with activeTrading=%s',
    (activeTrading) => {
      const { board, state } = tradePosition();
      // The inactive shortage policy targets Muster, so both partners hold its missing Bronze.
      state.hands[5] = 0;
      state.hands[10] = 0;
      state.hands[8] = 3;
      state.hands[13] = 3;
      const spy = vi.spyOn(planner, 'planTurn').mockImplementation(() => ({
        action: { type: 'endTurn' },
        plan: [{ type: 'endTurn' }],
        value: 0,
        nodes: 1,
        won: false,
      }));
      try {
        const bot = createAIBot('Aeneas', 20, {
          ...config,
          engine: 'planner',
          activeTrading,
          humanPlayers: [1, 2],
        });
        const recipients: number[] = [];
        for (let n = 0; n < 2; n++) {
          const action = bot.chooseAction(structuredClone(board), state, 0);
          expect(action.type).toBe('proposeTrade');
          if (action.type !== 'proposeTrade') throw new Error('Expected a human offer');
          recipients.push(action.to);
          apply(board, state, action);
          apply(board, state, { type: 'respondTrade', accept: false });
        }
        expect(new Set(recipients).size).toBe(2);
        expect(bot.chooseAction(structuredClone(board), state, 0).type).not.toBe('proposeTrade');
        state.turn++;
        state.proposals = 0;
        expect(bot.chooseAction(structuredClone(board), state, 0).type).toBe('proposeTrade');
      } finally {
        spy.mockRestore();
      }
    },
  );
});

interface CycleFixture {
  tier: string;
  seed: number;
  state: string;
  offers: TradeProposal[];
  baseHand: number[];
  finalHand: number[];
}
const cycles = readFileSync(new URL('./fixtures/trade-cycles.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as CycleFixture);
/** Report exact historical exploit outcomes; active proposing alone intentionally leaves acceptance unchanged. */
function replayCycle(fixture: CycleFixture, activeTrading: boolean): boolean {
  const { board } = createGame(fixture.seed),
    state = deserializeState(fixture.state);
  const player = state.active,
    policy = TIERS.find((tier) => tier.name === fixture.tier)!;
  expect(Array.from(state.hands.subarray(player * GOOD_COUNT, (player + 1) * GOOD_COUNT))).toEqual(
    fixture.baseHand,
  );
  for (const offer of fixture.offers) {
    expect(isLegal(board, state, offer)).toBe(true);
    apply(board, state, offer);
    const accept = acceptsTrade(board, state, offer.to, { ...policy, activeTrading }, fixture.seed);
    apply(board, state, { type: 'respondTrade', accept });
    if (!accept) return false;
  }
  expect(Array.from(state.hands.subarray(player * GOOD_COUNT, (player + 1) * GOOD_COUNT))).toEqual(
    fixture.finalHand,
  );
  return true;
}
describe('historical trade-cycle fixtures', () => {
  it('replays every exact fixture and reports acceptance under baseline and active trading without inventing a rejection rule', () => {
    const report = TIERS.map((tier) => {
      const rows = cycles.filter((row) => row.tier === tier.name);
      expect(rows.length).toBeGreaterThan(0);
      const baselineAccepted = rows.filter((row) => replayCycle(row, false)).length;
      const activeAccepted = rows.filter((row) => replayCycle(row, true)).length;
      expect(activeAccepted).toBe(baselineAccepted);
      return { tier: tier.name, fixtures: rows.length, baselineAccepted, activeAccepted };
    });
    console.info('trade-cycle replay', JSON.stringify(report));
  });
});
