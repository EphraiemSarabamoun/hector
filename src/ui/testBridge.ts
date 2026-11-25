/** Browser acceptance can read a snapshot and restore a save, but can never submit a move. */
import { serializeState, type Action, type GameEvent } from '../engine/index.js';
import { decodeSave, type Session, type Settings } from './game.js';
import type { Notice } from './feedback.js';

export interface TestSnapshot {
  settings: Settings;
  state: string;
  historyLength: number;
  history: Action[];
  lastAction: Action | null;
  lastEvents: GameEvent[];
  notices: Notice[];
}
export interface TestBridge {
  snapshot(): TestSnapshot | null;
  load(serializedSave: string): void;
}
interface TestHost {
  location: { search: string };
  __DARDANIA_TEST__?: TestBridge;
}
declare global {
  interface Window {
    __DARDANIA_TEST__?: TestBridge;
  }
}

/** Install only behind the explicit test URL flag; returned data cannot mutate the live game. */
export function installTestBridge(
  host: TestHost,
  current: () => Session | null,
  restore: (session: Session) => void,
): () => void {
  if (new URLSearchParams(host.location.search).get('test') !== '1') return () => {};
  const bridge: TestBridge = {
    snapshot() {
      const session = current();
      if (!session) return null;
      return {
        settings: structuredClone(session.settings),
        state: serializeState(session.state),
        historyLength: session.history.length,
        history: structuredClone(session.history),
        lastAction: structuredClone(session.history.at(-1) ?? null),
        lastEvents: structuredClone(session.log.at(-1)?.events ?? []),
        notices: structuredClone(session.notices),
      };
    },
    load(serializedSave) {
      restore(decodeSave(serializedSave));
    },
  };
  host.__DARDANIA_TEST__ = bridge;
  return () => {
    if (host.__DARDANIA_TEST__ === bridge) delete host.__DARDANIA_TEST__;
  };
}
