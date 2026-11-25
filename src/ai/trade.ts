/** Win-probability trade policy with a conservative public bound against finishing trades. */
import {
  apply,
  cloneState,
  GOOD_COUNT,
  isLegal,
  randomizeHidden,
  CONFIG,
  type Action,
  type Board,
  type GameState,
  type Goods,
} from '../engine/index.js';
import { evaluate, probabilitiesFromFeatures, type Weights } from './value.js';
import { allFeatures, withHandFeatures } from './features.js';
import { turnRenownUpperBound } from './planner.js';
import type { SearchConfig } from './types.js';
import { deadlineExpired } from './time.js';
import { hasAcceptedTrade, type TradeDeclineReason } from './trade-history.js';
export type TradeProposal = Extract<Action, { type: 'proposeTrade' }>;
export interface TradeAssessment {
  accept: boolean;
  reason?: TradeDeclineReason;
}
/** Absent keeps older explicit configurations compatible; the tier table opts the guarded tiers in. */
export function tradeGuardsEnabled(config: Pick<SearchConfig, 'tradeGuards'>): boolean {
  if (config.tradeGuards !== undefined && typeof config.tradeGuards !== 'boolean')
    throw new Error('Trade guards must be true or false');
  return config.tradeGuards === true;
}
export interface TradeProposalOptions {
  /** Shared absolute performance.now() boundary; absent leaves deterministic exhaustive work uncapped. */
  deadline?: number;
  partnerConfig?: (to: number) => SearchConfig;
  excludedOfferKeys?: ReadonlySet<string>;
  excludedRecipients?: ReadonlySet<number>;
}
/** Enumerate every nonempty goods multiset up to the rules' three-unit limit exactly once. */
function goodsBundles(): readonly Goods[] {
  const bundles: Goods[] = [];
  const vector = Array<number>(GOOD_COUNT).fill(0);
  const add = (good: number, remaining: number) => {
    if (good === GOOD_COUNT - 1) {
      vector[good] = remaining;
      bundles.push(Object.freeze([...vector]));
      return;
    }
    for (let count = 0; count <= remaining; count++) {
      vector[good] = count;
      add(good + 1, remaining - count);
    }
  };
  for (let total = CONFIG.trade.minUnits; total <= CONFIG.trade.maxUnits; total++) add(0, total);
  return Object.freeze(bundles);
}
/** The 55 legal goods-side vectors, shared by bots and the exhaustive Trader benchmark. */
export const TRADE_BUNDLES = goodsBundles();
/** Stable identity includes the recipient and both full goods vectors. */
export function tradeOfferKey(offer: TradeProposal): string {
  return `${offer.to}:${offer.give.join(',')}>${offer.get.join(',')}`;
}
/** Missing configuration retains two offers; explicit larger allowances still obey the rules' four-offer cap. */
export function tradeProposalLimit(config: Pick<SearchConfig, 'tradeProposals'>): number {
  const limit = config.tradeProposals === undefined ? 2 : config.tradeProposals;
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new Error('Trade proposals must be a nonnegative safe integer');
  return Math.min(CONFIG.trade.maxProposals, limit);
}
/** Traverse rival IDs by randomized turn order, as the existing shortage policy does. */
function tradePartners(state: GameState): number[] {
  return Array.from(
    { length: state.players - 1 },
    (_, i) => state.turnOrder[(state.turnIndex + i + 1) % state.players],
  );
}
/** Caller exclusions are policy state, never a change to the underlying rules' legal offers. */
function excluded(offer: TradeProposal, options: TradeProposalOptions): boolean {
  return (
    !!options.excludedRecipients?.has(offer.to) ||
    !!options.excludedOfferKeys?.has(tradeOfferKey(offer))
  );
}
type TradeValuation = (state: GameState, weights: Weights) => number[];
/** A proposal changes only hands among the value features. Cache those rows within this one root. */
function cachedTradeValuation(board: Board, root: GameState): TradeValuation {
  const source = allFeatures(board, root);
  const rows = source.map(
    (row, p) =>
      new Map<string, number[]>([
        [root.hands.subarray(p * GOOD_COUNT, (p + 1) * GOOD_COUNT).join(','), row],
      ]),
  );
  return (state, weights) => {
    if (state.phase === 'gameOver' && state.winnerId >= 0)
      return Array.from({ length: state.players }, (_, p) => Number(p === state.winnerId));
    const matrix = source.map((row, p) => {
      const hand = state.hands.subarray(p * GOOD_COUNT, (p + 1) * GOOD_COUNT),
        key = hand.join(',');
      let result = rows[p].get(key);
      if (!result) {
        result = withHandFeatures(row, root, p, Array.from(hand));
        rows[p].set(key, result);
      }
      return result;
    });
    return probabilitiesFromFeatures(matrix, weights);
  };
}
/** Accept only mutual gains whose relative benefit is fair and which cannot finish the proposer this turn. */
function assessTradeWithValue(
  board: Board,
  state: GameState,
  player: number,
  config: SearchConfig,
  seed: number,
  value: TradeValuation,
): TradeAssessment {
  if (state.phase !== 'tradeResponse' || state.toAct !== player)
    return { accept: false, reason: 'does not help me' };
  if (tradeGuardsEnabled(config)) {
    if (hasAcceptedTrade(board, state, state.active))
      return { accept: false, reason: 'already traded this turn' };
    const given = state.tradeGet.reduce((sum, n) => sum + n, 0);
    const received = state.tradeGive.reduce((sum, n) => sum + n, 0);
    if (given > received + 1) return { accept: false, reason: 'too many goods for too few' };
  }
  const before = cloneState(state);
  randomizeHidden(before, seed);
  const after = cloneState(before);
  apply(board, after, { type: 'respondTrade', accept: true });
  // finishingRisk returns impossible only below this public upper bound and before the cap.
  // Its other outcomes both reject, so a tactical search cannot alter this decision.
  if (
    after.turn >= CONFIG.turnCap ||
    turnRenownUpperBound({ board, state: after, player: state.active, config, seed }) >=
      CONFIG.renown.target
  )
    return { accept: false, reason: 'would let you win' };
  const prior = value(before, config.weights),
    next = value(after, config.weights);
  const mine = next[player] - prior[player],
    theirs = next[state.active] - prior[state.active];
  return mine + 1e-12 >= config.eps && mine + 1e-12 >= theirs - config.delta
    ? { accept: true }
    : { accept: false, reason: 'does not help me' };
}
/** Explain the same guards/value decision used by standalone answers and modeled partners. */
export function assessTrade(
  board: Board,
  state: GameState,
  player: number,
  config: SearchConfig,
  seed: number,
): TradeAssessment {
  return assessTradeWithValue(board, state, player, config, seed, (position, weights) =>
    evaluate(board, position, weights),
  );
}
/** Standalone responses retain the full evaluator; cached valuation is private to one exhaustive root. */
export function acceptsTrade(
  board: Board,
  state: GameState,
  player: number,
  config: SearchConfig,
  seed: number,
): boolean {
  return assessTrade(board, state, player, config, seed).accept;
}
/** Suggest scarce build inputs in exchange for surplus, only when the partner model would accept. */
export function proposeTrade(
  board: Board,
  state: GameState,
  player: number,
  config: SearchConfig,
  seed: number,
  options: TradeProposalOptions = {},
): TradeProposal | null {
  if (
    state.phase !== 'main' ||
    state.active !== player ||
    state.proposals >= tradeProposalLimit(config) ||
    deadlineExpired(options.deadline)
  )
    return null;
  const before = cloneState(state);
  randomizeHidden(before, seed);
  const base = evaluate(board, before, config.weights)[player];
  const hand = state.hands.subarray(player * GOOD_COUNT, (player + 1) * GOOD_COUNT);
  // The closest unavailable build supplies the plan's immediate shortage; leave its inputs in reserve.
  const costs = Object.values(CONFIG.costs).filter((cost) => cost.some((n, g) => n > hand[g]));
  costs.sort(
    (a, b) =>
      a.reduce<number>((n, x, g) => n + Math.max(0, x - hand[g]), 0) -
      b.reduce<number>((n, x, g) => n + Math.max(0, x - hand[g]), 0),
  );
  const target = costs[0];
  if (!target) return null;
  let best: Extract<Action, { type: 'proposeTrade' }> | null = null;
  let bestGain = 0;
  for (let get = 0; get < GOOD_COUNT; get++)
    if (hand[get] < target[get])
      for (let pay = 0; pay < GOOD_COUNT; pay++) {
        if (pay === get || hand[pay] <= target[pay]) continue;
        for (let offset = 1; offset < state.players; offset++) {
          if (deadlineExpired(options.deadline)) return best;
          // Traverse in turn order rather than privileging a player ID.
          const to = state.turnOrder[(state.turnIndex + offset) % state.players];
          const give = Array(GOOD_COUNT).fill(0),
            receive = Array(GOOD_COUNT).fill(0);
          give[pay] = 1;
          receive[get] = 1;
          const proposal: Extract<Action, { type: 'proposeTrade' }> = {
            type: 'proposeTrade',
            to,
            give,
            get: receive,
          };
          if (excluded(proposal, options) || !isLegal(board, before, proposal)) continue;
          const offered = cloneState(before);
          apply(board, offered, proposal);
          if (!acceptsTrade(board, offered, to, options.partnerConfig?.(to) ?? config, seed))
            continue;
          apply(board, offered, { type: 'respondTrade', accept: true });
          const gain = evaluate(board, offered, config.weights)[player] - base;
          if (gain > bestGain + 1e-12) {
            best = proposal;
            bestGain = gain;
          }
        }
      }
  return best;
}

/** Exhaust every legal 1..3-for-1..3 exchange and choose the largest positive own static gain.
 * Partner models may differ by player. This changes proposal activity only: acceptance margins
 * and the conservative finishing guard are shared with the baseline policy.
 */
export function proposeBestTrade(
  board: Board,
  state: GameState,
  player: number,
  config: SearchConfig,
  seed: number,
  options: TradeProposalOptions = {},
): TradeProposal | null {
  if (
    state.phase !== 'main' ||
    state.active !== player ||
    state.proposals >= tradeProposalLimit(config) ||
    deadlineExpired(options.deadline)
  )
    return null;
  const before = cloneState(state);
  randomizeHidden(before, seed);
  const value = cachedTradeValuation(board, before);
  const baseline = value(before, config.weights)[player];
  const affordable = (p: number) =>
    TRADE_BUNDLES.filter((bundle) => bundle.every((n, g) => n <= before.hands[p * GOOD_COUNT + g]));
  const gives = affordable(player);
  let best: TradeProposal | null = null,
    bestGain = 0;
  for (const to of tradePartners(before)) {
    if (options.excludedRecipients?.has(to)) continue;
    const partner = options.partnerConfig?.(to) ?? config;
    const gets = affordable(to);
    for (const give of gives)
      for (const get of gets) {
        if (deadlineExpired(options.deadline)) return best;
        if (give.some((n, g) => n > 0 && get[g] > 0)) continue;
        const proposal: TradeProposal = { type: 'proposeTrade', to, give, get };
        if (excluded(proposal, options) || !isLegal(board, before, proposal)) continue;
        const offered = cloneState(before);
        apply(board, offered, proposal);
        const accepted = cloneState(offered);
        apply(board, accepted, { type: 'respondTrade', accept: true });
        const gain = value(accepted, config.weights)[player] - baseline;
        if (
          gain <= bestGain ||
          !assessTradeWithValue(board, offered, to, partner, seed, value).accept
        )
          continue;
        best = proposal;
        bestGain = gain;
      }
  }
  return best;
}
