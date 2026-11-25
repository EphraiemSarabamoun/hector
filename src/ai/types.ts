/** Browser-safe search contracts shared by tier settings, planners and tournament tools. */
import type { Action, Board, GameState } from '../engine/index.js';
import type { Weights } from './value.js';
export interface SearchConfig {
  engine: 'greedy' | 'planner' | 'mcts';
  budget: number;
  weights: Weights;
  noise: number;
  randomMove: number;
  eps: number;
  delta: number;
  openingTopK: number;
  lookahead: boolean;
  /** Optional nonnegative integer successor-evaluation budget for setup forecasts; zero keeps immediate ranking. */
  setupBudget?: number;
  /** Opt into exhaustive proposals before other main actions; absent preserves shortage-only trading. */
  activeTrading?: boolean;
  /** Own-turn proposal allowance, capped by the rules; absent retains the two-offer policy. */
  tradeProposals?: number;
  /** Configured human IDs receive at most one offer from this bot per own turn. */
  humanPlayers?: readonly number[];
  /** Guard answers with one table-wide accepted trade per proposer/turn and at most one net good given. False selects the legacy policy. */
  tradeGuards?: boolean;
  /** Optional browser runtime allowance per decision; absent or zero keeps deterministic node-budget search. */
  timeLimitMs?: number;
}
export interface SearchResult {
  action: Action;
  plan: Action[];
  value: number;
  nodes: number;
  won: boolean;
  candidates?: { action: Action; plan: Action[]; value: number }[];
}
export interface SearchRequest {
  board: Board;
  state: GameState;
  player: number;
  config: SearchConfig;
  seed: number;
  /** Absolute performance.now() cutoff shared by nested work within one decision. */
  deadline?: number;
}
