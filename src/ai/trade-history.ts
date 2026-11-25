/** Public policy history travels with positions without changing the rules engine or its legal actions. */
import { apply, type Action, type Board, type GameEvent, type GameState } from '../engine/index.js';
import { boardKey } from './board-key.js';

/** Plain immutable metadata survives engine clones, structured clones and portable state serialization. */
export interface PublicTradeHistory {
  readonly board: string;
  readonly turn: number;
  readonly acceptedProposers: readonly number[];
}
export type TradeHistoryState = GameState & { aiTradeHistory?: PublicTradeHistory };
export type TradeDeclineReason =
  | 'already traded this turn'
  | 'too many goods for too few'
  | 'does not help me'
  | 'would let you win';
export type ExplainedTradeResponse = Extract<Action, { type: 'respondTrade' }> & {
  reason?: TradeDeclineReason;
};
const DECLINE_REASONS: readonly TradeDeclineReason[] = Object.freeze([
  'already traded this turn',
  'too many goods for too few',
  'does not help me',
  'would let you win',
]);

/** Read only a matching game's current-turn history, never another board or a previous turn. */
export function acceptedTradeProposers(board: Board, state: GameState): readonly number[] {
  const history = (state as TradeHistoryState).aiTradeHistory;
  return history?.board === boardKey(board) && history.turn === state.turn
    ? history.acceptedProposers
    : [];
}

/** Any recipient's actual acceptance spends the proposer's single guarded trade for this turn. */
export function hasAcceptedTrade(board: Board, state: GameState, proposer: number): boolean {
  return acceptedTradeProposers(board, state).includes(proposer);
}

/** Optional action metadata is restricted to the four public policy phrases. */
export function tradeDeclineReason(action: Action): TradeDeclineReason | undefined {
  if (action.type !== 'respondTrade' || action.accept) return undefined;
  const reason = (action as ExplainedTradeResponse).reason;
  return reason !== undefined && DECLINE_REASONS.includes(reason) ? reason : undefined;
}

/**
 * Call after real engine transitions, including human and generous-bot responses.
 * Search decisions alone never count as acceptances. Replacement records keep sibling
 * clone branches independent even though cloneState shallow-copies this immutable metadata.
 */
export function recordTradeEvents(
  board: Board,
  state: GameState,
  events: readonly GameEvent[],
): void {
  const owned = state as TradeHistoryState;
  if (!events.some((event) => event.type === 'tradeProposed' || event.type === 'tradeResponse')) {
    if (
      owned.aiTradeHistory &&
      (owned.aiTradeHistory.turn !== state.turn || owned.aiTradeHistory.board !== boardKey(board))
    )
      delete owned.aiTradeHistory;
    return;
  }
  const accepted = [...acceptedTradeProposers(board, state)];
  if (
    events.some((event) => event.type === 'tradeResponse' && event.accept === true) &&
    !accepted.includes(state.active)
  )
    accepted.push(state.active);
  owned.aiTradeHistory = Object.freeze({
    board: boardKey(board),
    turn: state.turn,
    acceptedProposers: Object.freeze(accepted),
  });
}

/** Real game hosts use this engine-compatible wrapper for every human/bot action; searches keep engine apply. */
export function applyWithTradeHistory(
  board: Board,
  state: GameState,
  action: Action,
  chance?: Parameters<typeof apply>[3],
): GameEvent[] {
  const events = apply(board, state, action, chance);
  recordTradeEvents(board, state, events);
  const reason = tradeDeclineReason(action);
  if (reason)
    for (const event of events)
      if (event.type === 'tradeResponse' && event.accept === false) event.reason = reason;
  return events;
}
