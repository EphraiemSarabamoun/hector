/** Shared UI state transitions and portable saves. No screen mutates an engine position. */
import {
  cloneState,
  createGame,
  deserializeState,
  serializeState,
  stateHash,
  type Action,
  type Board,
  type GameState,
  type GameEvent,
} from '../engine/index.js';
import { applyWithTradeHistory, recordTradeEvents } from '../ai/index.js';
import type { Tier } from './driver.js';
import { transitionNotices, type Notice } from './feedback.js';
export const SAVE_KEY = 'dardania.save.v1';
export type Speed = 'slow' | 'normal' | 'fast' | 'instant';
export interface Settings {
  name: string;
  colour: string;
  tiers: [Tier, Tier];
  seed: string;
  speed: Speed;
}
export interface LogEntry {
  turn: number;
  owner?: number;
  group?: string;
  events: GameEvent[];
}
export interface Session {
  board: Board;
  state: GameState;
  settings: Settings;
  history: Action[];
  log: LogEntry[];
  notices: Notice[];
}
/** Deterministic map setup keeps stable human ID zero separate from shuffled turn order. */
export function newSession(settings: Settings): Session {
  return { ...createGame(settings.seed, 3), settings, history: [], log: [], notices: [] };
}
/** Every actual human/bot transition records public trade history; the engine still owns legality. */
export function gameReducer(session: Session, action: Action): Session {
  const state = cloneState(session.state);
  const events = applyWithTradeHistory(session.board, state, action);
  return {
    ...session,
    state,
    history: [...session.history, action],
    notices: [
      ...session.notices.filter(
        (n) => !(action.type === 'respondTrade' && session.state.toAct === 0 && n.kind === 'trade'),
      ),
      ...transitionNotices(
        session.board,
        session.state,
        state,
        events,
        session.settings,
        session.history.length,
      ),
    ],
    log: [
      ...session.log,
      {
        turn: session.state.turn,
        owner: session.state.active,
        group:
          session.state.turn === 0
            ? `setup-${session.state.setupStep}`
            : `turn-${session.state.turn}`,
        events,
      },
    ],
  };
}
/** Reconstruct the human offer cap from saved public events when a worker restarts. */
export function humanTradeOffered(session: Session, player: number): boolean {
  return session.log.some(
    (entry) =>
      entry.turn === session.state.turn &&
      entry.events.some(
        (event) => event.type === 'tradeProposed' && event.player === player && event.to === 0,
      ),
  );
}
/** Persist the engine's exact RNG and pending phase as well as settings and replay history. */
export function encodeSave(session: Session): string {
  return JSON.stringify({
    version: 1,
    settings: session.settings,
    history: session.history,
    log: session.log,
    notices: session.notices,
    state: serializeState(session.state),
    hash: stateHash(session.state),
  });
}
/** Older saves recover history only from individual public event batches in the current turn. */
function recoverLegacyTradeHistory(session: Session): void {
  if (Object.hasOwn(session.state, 'aiTradeHistory')) return;
  for (const entry of session.log)
    if (entry.turn === session.state.turn)
      recordTradeEvents(session.board, session.state, entry.events);
}
/** Validate the saved fingerprint before adding legacy metadata, then regenerate its map. */
export function decodeSave(text: string): Session {
  const save = JSON.parse(text);
  if (
    save.version !== 1 ||
    typeof save.settings?.seed !== 'string' ||
    !Array.isArray(save.history) ||
    !Array.isArray(save.log)
  )
    throw new Error('Unsupported save');
  const state = deserializeState(save.state);
  if (
    stateHash(state) !== save.hash ||
    state.players !== 3 ||
    !Array.isArray(save.settings.tiers) ||
    save.settings.tiers.length !== 2
  )
    throw new Error('Damaged save');
  const session: Session = {
    ...newSession(save.settings),
    state,
    history: save.history,
    log: save.log,
    notices: Array.isArray(save.notices) ? save.notices : [],
  };
  recoverLegacyTradeHistory(session);
  return session;
}
