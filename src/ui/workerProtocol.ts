/** Serializable worker messages and the shared computation used by real and test transports. */
import {
  deserializeState,
  generateBoard,
  type Action,
  type Board,
  type GameState,
} from '../engine/index.js';
import { TIERS, type Tier } from './aiPort.js';
import type { SearchConfig } from '../ai/index.js';
/** Saved UI history needed to restore bot policy after worker cancellation or a page reload. */
export interface DecisionContext {
  humanTradeOffered?: boolean;
}
export interface DecisionRequest extends DecisionContext {
  requestId: number;
  boardSeed: number | string;
  serializedState: string;
  player: number;
  tier: Tier;
  botSeed?: number | string;
}
export type DecisionResponse =
  { requestId: number; action: Action } | { requestId: number; error: string };
export type AIFactory = (
  tierName: Tier,
  seed: number | string,
  overrides?: Partial<SearchConfig>,
) => {
  config?: { timeLimitMs?: number };
  chooseAction(board: Board, state: GameState, player: number): Action;
};
/** Share a capped request's budget across history recovery while keeping the persistent bot reusable. */
function chooseWithContext(
  bot: ReturnType<AIFactory>,
  board: Board,
  state: GameState,
  request: DecisionRequest,
  timeLimitMs?: number,
): Action {
  const started = timeLimitMs !== undefined && timeLimitMs > 0 ? performance.now() : undefined;
  let action = bot.chooseAction(board, state, request.player);
  if (request.humanTradeOffered && action.type === 'proposeTrade' && action.to === 0) {
    const remaining =
      started === undefined ? undefined : timeLimitMs! - (performance.now() - started);
    if (remaining !== undefined && remaining <= 0) return { type: 'endTurn' };
    // AIBot exposes a mutable public config. Temporarily shrink its retry cap, then restore it
    // so the next request gets the full configured budget; simple uncapped mocks need no config.
    const config = remaining === undefined ? undefined : bot.config;
    const originalTimeLimitMs = config?.timeLimitMs;
    try {
      if (config) config.timeLimitMs = remaining;
      // The first call restores this bot's private offer memory without applying its proposal.
      action = bot.chooseAction(board, state, request.player);
      if (action.type === 'proposeTrade' && action.to === 0)
        throw new Error('AI repeated a human trade offer after the per-turn human offer limit');
    } finally {
      if (config) config.timeLimitMs = originalTimeLimitMs;
    }
  }
  return action;
}
/** Keep generated maps and private bot streams inside one worker, never in React state. */
export function createDecisionComputer(
  createAIBot: AIFactory,
): (request: DecisionRequest) => DecisionResponse {
  let board: Board | undefined;
  let boardKey: string | undefined;
  const bots = new Map<string, ReturnType<AIFactory>>();
  return (request) => {
    try {
      const nextBoardKey = JSON.stringify(request.boardSeed);
      if (nextBoardKey !== boardKey) {
        board = generateBoard(request.boardSeed);
        boardKey = nextBoardKey;
        bots.clear();
      }
      const state = deserializeState(request.serializedState);
      if (!Number.isInteger(request.player) || request.player !== state.toAct)
        throw new Error('Decision player does not match the position');
      const seed = request.botSeed ?? `${request.boardSeed}:ai:${request.player}`;
      const botKey = JSON.stringify([request.tier, seed, request.player]);
      const tier = TIERS.find((entry) => entry.name.toLowerCase() === request.tier.toLowerCase());
      if (!tier) throw new Error(`Unknown AI tier: ${request.tier}`);
      let bot = bots.get(botKey);
      if (!bot) {
        // Browser player zero is human; only explicit tier metadata enables a runtime search cap.
        bot = createAIBot(tier.name, seed, {
          humanPlayers: [0],
          timeLimitMs: tier.browserTimeLimitMs,
        });
        bots.set(botKey, bot);
      }
      const action = chooseWithContext(bot, board!, state, request, tier.browserTimeLimitMs);
      return { requestId: request.requestId, action };
    } catch (error) {
      return {
        requestId: request.requestId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}
