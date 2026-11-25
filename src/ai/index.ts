/** Browser-safe AI boundary. Every search begins from a newly randomized hidden-future clone. */
import {
  apply,
  cloneState,
  isLegal,
  legalActions,
  nextRandom,
  randomizeHidden,
  seedValue,
  type Action,
  type Board,
  type GameState,
} from '../engine/index.js';
import { GreedyBot, type Bot } from '../bots/index.js';
import { planTurn } from './planner.js';
import { searchMCTS } from './mcts.js';
import {
  choosePlacement,
  rankedDecisions,
  softmaxIndex,
  validatedSetupBudget,
} from './placement.js';
import {
  assessTrade,
  proposeTrade,
  proposeBestTrade,
  tradeOfferKey,
  tradeProposalLimit,
  tradeGuardsEnabled,
  type TradeProposal,
} from './trade.js';
import { tierByName } from './tiers.js';
import { boardKey } from './board-key.js';
import { deadlineExpired, validatedTimeLimit } from './time.js';
import type { SearchConfig, SearchResult } from './types.js';
import type { ExplainedTradeResponse } from './trade-history.js';
export * from './features.js';
export * from './value.js';
export * from './types.js';
export * from './tiers.js';
export * from './planner.js';
export * from './mcts.js';
export * from './trade.js';
export * from './placement.js';
export * from './time.js';
export * from './trade-history.js';
/** Stateful seeded controller, including an optional cached plan for its current deterministic turn. */
export class AIBot implements Bot {
  readonly name: string;
  readonly config: SearchConfig;
  private random: { rng: number };
  private greedy: GreedyBot;
  private cached: Action[] = [];
  private expected: string[] = [];
  private cachedTurn = -1;
  private cachedBoard = '';
  private offerBoard = '';
  private offerTurn = -1;
  private offerPlayer = -1;
  private sentOffers = new Set<string>();
  private offeredHumans = new Set<number>();
  constructor(name: string, seed: number | string = 0, overrides: Partial<SearchConfig> = {}) {
    const tier = tierByName(name);
    this.name = tier.name;
    this.config = { ...tier, ...overrides };
    validatedSetupBudget(this.config);
    tradeProposalLimit(this.config);
    tradeGuardsEnabled(this.config);
    validatedTimeLimit(this.config);
    this.random = { rng: seedValue(seed) };
    this.greedy = new GreedyBot(seed);
  }
  /** Remember proposals before returning them; responses do not reset the owner's turn history. */
  private tryTrade(
    board: Board,
    state: GameState,
    player: number,
    seed: number,
    deadline?: number,
  ): TradeProposal | null {
    if (state.phase !== 'main' || state.active !== player) return null;
    const identity = boardKey(board);
    if (
      this.offerBoard !== identity ||
      this.offerTurn !== state.turn ||
      this.offerPlayer !== player
    ) {
      this.offerBoard = identity;
      this.offerTurn = state.turn;
      this.offerPlayer = player;
      this.sentOffers.clear();
      this.offeredHumans.clear();
    }
    const options = {
      deadline,
      excludedRecipients: this.offeredHumans,
      excludedOfferKeys: this.config.activeTrading ? this.sentOffers : undefined,
    };
    const proposal = this.config.activeTrading
      ? proposeBestTrade(board, state, player, this.config, seed, options)
      : proposeTrade(board, state, player, this.config, seed, options);
    if (!proposal) return null;
    this.sentOffers.add(tradeOfferKey(proposal));
    if (this.config.humanPlayers?.includes(proposal.to)) this.offeredHumans.add(proposal.to);
    this.cached = [];
    this.expected = [];
    return proposal;
  }
  /** Choose a legal public-information action; cloning ensures inference cannot mutate the real position. */
  chooseAction(board: Board, state: GameState, player: number): Action {
    const limit = validatedTimeLimit(this.config);
    const deadline = limit > 0 ? performance.now() + limit : undefined;
    const actions = legalActions(board, state);
    if (!actions.length) throw new Error('Cannot act in a finished game');
    const seed = Math.floor(nextRandom(this.random) * 4294967296);
    const publicState = cloneState(state);
    randomizeHidden(publicState, seed);
    if (deadlineExpired(deadline)) {
      // A response not evaluated within its allowance has no demonstrated benefit.
      const decline: ExplainedTradeResponse = {
        type: 'respondTrade',
        accept: false,
        reason: 'does not help me',
      };
      return state.phase === 'tradeResponse'
        ? decline
        : (actions.find((action) => action.type === 'endTurn') ?? actions[0]);
    }
    if (state.phase === 'main' && this.config.activeTrading) {
      const proposal = this.tryTrade(board, publicState, player, seed, deadline);
      if (proposal) return proposal;
    }
    if (actions.length === 1) return actions[0];
    if (state.phase === 'tradeResponse')
      return {
        type: 'respondTrade',
        ...assessTrade(board, publicState, player, this.config, seed),
      };
    if (this.config.randomMove > 0 && nextRandom(this.random) < this.config.randomMove) {
      this.cached = [];
      return actions[Math.floor(nextRandom(this.random) * actions.length)];
    }
    if (this.config.engine === 'greedy')
      return this.greedy.chooseAction(board, publicState, player);
    if (
      this.cachedBoard === boardKey(board) &&
      this.cachedTurn === state.turn &&
      this.cached.length &&
      this.expected[0] === publicSignature(state) &&
      isLegal(board, state, this.cached[0])
    ) {
      if (this.cached[0].type === 'endTurn' && !this.config.activeTrading) {
        const proposal = this.tryTrade(board, publicState, player, seed, deadline);
        if (proposal) {
          this.cached = [];
          this.expected = [];
          return proposal;
        }
      }
      this.expected.shift();
      return this.cached.shift()!;
    }
    this.cached = [];
    if (state.phase !== 'main')
      return choosePlacement({
        board,
        state: publicState,
        player,
        config: this.config,
        seed,
        deadline,
      }).action;
    const request = { board, state: publicState, player, config: this.config, seed, deadline };
    const result: SearchResult =
      this.config.engine === 'mcts' ? searchMCTS(request) : planTurn(request);
    if (!result.won && result.action.type === 'endTurn' && !this.config.activeTrading) {
      const proposal = this.tryTrade(board, publicState, player, seed, deadline);
      if (proposal) return proposal;
    }
    let plan = result.plan;
    if (this.config.noise > 0 && result.candidates?.length) {
      const alternatives = result.candidates;
      const index = softmaxIndex(
        alternatives.map((a) => a.value),
        this.config.noise,
        this.random,
      );
      plan = alternatives[index].plan;
    }
    if (this.config.engine === 'planner') {
      this.cached = plan.slice(1);
      this.expected = [];
      this.cachedTurn = state.turn;
      this.cachedBoard = boardKey(board);
      const predicted = cloneState(publicState);
      for (let i = 0; i < plan.length - 1; i++) {
        apply(board, predicted, plan[i]);
        this.expected.push(publicSignature(predicted));
      }
    }
    return plan[0];
  }
}
/** Public snapshot invalidates cached plans when an unknown replacement card is actually revealed. */
function publicSignature(state: GameState): string {
  return JSON.stringify(state, (key, value) =>
    key === 'rng' || key === 'deck' ? undefined : value,
  );
}
/** Build one independent bot per player. Overrides support explicitly recorded training and arena configurations. */
export function createAIBot(
  name: string,
  seed: number | string = 0,
  overrides: Partial<SearchConfig> = {},
): AIBot {
  return new AIBot(name, seed, overrides);
}
