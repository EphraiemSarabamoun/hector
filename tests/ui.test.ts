/** UI acceptance: the reducer and async drivers used by React complete actual games. */
import { describe, expect, it, vi } from 'vitest';
import {
  cloneState,
  deserializeState,
  Good,
  GOOD_COUNT,
  legalActions,
  serializeState,
  stateHash,
  type Action,
} from '../src/engine/index.js';
import {
  FEATURE_NAMES,
  hasAcceptedTrade,
  tierByName,
  W0,
  type SearchConfig,
  type TradeHistoryState,
} from '../src/ai/index.js';
import * as ai from '../src/ai/index.js';
import { createDriver, type WorkerFactory } from '../src/ui/driver.js';
import { createAIBot } from '../src/ui/aiPort.js';
import { createDecisionComputer } from '../src/ui/workerProtocol.js';
/** Test only transport: actual serialization, worker computation and WorkerDriver stay shared. */
const workerFactory: WorkerFactory = () => {
  const compute = createDecisionComputer(createAIBot);
  let terminated = false;
  const transport: ReturnType<WorkerFactory> = {
    onmessage: null,
    onerror: null,
    postMessage(request) {
      const message = structuredClone(request);
      queueMicrotask(() => {
        if (!terminated)
          transport.onmessage?.({ data: structuredClone(compute(message)) } as MessageEvent);
      });
    },
    terminate() {
      terminated = true;
    },
  };
  return transport;
};
import {
  decodeSave,
  encodeSave,
  gameReducer,
  newSession,
  type Settings,
  type Session,
} from '../src/ui/game.js';
const settings: Settings = {
  name: 'Tester',
  colour: '#b84448',
  tiers: ['Aeneas', 'Hector'],
  seed: 'ui-acceptance',
  speed: 'instant',
};
describe('browser game model', () => {
  it('plays all three seats through the shared driver and reducer to a winner, then replays exactly', async () => {
    let session = newSession(settings);
    const drivers = [
      createDriver('Astyanax', undefined, workerFactory),
      createDriver('Aeneas', undefined, workerFactory),
      createDriver('Hector', undefined, workerFactory),
    ];
    for (let decisions = 0; session.state.winnerId < 0; decisions++) {
      expect(decisions).toBeLessThan(5000);
      const action = await drivers[session.state.toAct].decide(
        session.board,
        session.state,
        session.state.toAct,
      );
      session = gameReducer(session, action);
    }
    expect(session.state.phase).toBe('gameOver');
    expect(session.state.winnerId).toBeGreaterThanOrEqual(0);
    let replay = newSession(settings);
    for (const action of session.history) replay = gameReducer(replay, action);
    expect(stateHash(replay.state)).toBe(stateHash(session.state));
    const restored = decodeSave(encodeSave(session));
    expect(stateHash(restored.state)).toBe(stateHash(session.state));
    expect(restored.history).toEqual(session.history);
    expect(restored.notices).toEqual(session.notices);
    drivers.forEach((driver) => driver.dispose());
  }, 30000);
  it('restores every setup position including typed buffers and pending decisions', () => {
    let session = newSession(settings);
    for (let i = 0; i < 12; i++) {
      const restored = decodeSave(encodeSave(session));
      expect(stateHash(restored.state)).toBe(stateHash(session.state));
      expect(restored.state.hands).toBeInstanceOf(Uint16Array);
      session = gameReducer(restored, legalActions(restored.board, restored.state)[0]);
    }
  });
  it('cancels a pending async decision without mutating the game', async () => {
    const session = newSession(settings);
    const hash = stateHash(session.state);
    const driver = createDriver('Hector', undefined, workerFactory);
    const pending = driver.decide(session.board, session.state, session.state.toAct);
    driver.cancel();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(stateHash(session.state)).toBe(hash);
    const abort = new AbortController();
    abort.abort();
    await expect(
      driver.decide(session.board, session.state, session.state.toAct, abort.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    driver.dispose();
  });
  it('rejects damaged saves and illegal actions without changing the original position', () => {
    const session = newSession(settings);
    const hash = stateHash(session.state);
    expect(() => gameReducer(session, { type: 'endTurn' } as Action)).toThrow();
    expect(stateHash(session.state)).toBe(hash);
    const raw = JSON.parse(encodeSave(session));
    raw.hash = 'bad';
    expect(() => decodeSave(JSON.stringify(raw))).toThrow('Damaged save');
  });
});

/** A small public position whose recipients benefit from receiving Timber and shedding Horses. */
function tradeSession(proposer = 0): Session {
  const session = newSession({ ...settings, seed: 'ui-public-trade-history' });
  Object.assign(session.state, {
    phase: 'main',
    active: proposer,
    toAct: proposer,
    turn: 7,
    turnIndex: proposer,
  });
  session.state.turnOrder.set([0, 1, 2]);
  for (let player = 0; player < 3; player++) {
    session.state.hands[player * GOOD_COUNT + Good.Timber] = 3;
    session.state.hands[player * GOOD_COUNT + Good.Horses] = 3;
  }
  return session;
}
/** Fixed valuation makes guard tests independent of future model tuning without overriding guard defaults. */
function tradeConfig(): Partial<SearchConfig> {
  const weights = W0.map(() => 0);
  weights[FEATURE_NAMES.indexOf('handTimber')] = 0.8;
  weights[FEATURE_NAMES.indexOf('handHorses')] = -0.8;
  return { weights, eps: 0.001, delta: 0.01, timeLimitMs: 0 };
}
/** All fixture proposals still cross the same real-action reducer as human and bot screen choices. */
function uiOffer(to: number, horses = 1): Extract<Action, { type: 'proposeTrade' }> {
  return { type: 'proposeTrade', to, give: [1, 0, 0, 0, 0], get: [0, 0, 0, 0, horses] };
}
/** Encode the historical save shape while retaining a correct pre-migration position fingerprint. */
function legacySave(session: Session): string {
  const state = cloneState(session.state) as TradeHistoryState;
  delete state.aiTradeHistory;
  return encodeSave({ ...session, state });
}

describe('UI public accepted-trade history', () => {
  for (const recipient of ['manual human', 'generous Paris bot'] as const) {
    it.each(['Aeneas', 'Sarpedon', 'Hector'])(
      `%s observes table-wide acceptance by a ${recipient}`,
      (tier) => {
        const proposer = recipient === 'manual human' ? 1 : 0;
        const initial = tradeSession(proposer);
        const initialHash = stateHash(initial.state);
        const initialSerialized = serializeState(initial.state);
        const firstRecipient = recipient === 'manual human' ? 0 : 1;
        const offered = gameReducer(initial, uiOffer(firstRecipient, 2));
        const hashBeforeChoice = stateHash(offered.state);
        const serializedBeforeChoice = serializeState(offered.state);
        const response: Action =
          recipient === 'manual human'
            ? { type: 'respondTrade', accept: true }
            : createAIBot('Paris', 17, tradeConfig()).chooseAction(
                offered.board,
                offered.state,
                firstRecipient,
              );
        expect(response).toEqual({ type: 'respondTrade', accept: true });
        expect(stateHash(offered.state)).toBe(hashBeforeChoice);
        expect(serializeState(offered.state)).toBe(serializedBeforeChoice);
        expect(hasAcceptedTrade(offered.board, offered.state, proposer)).toBe(false);
        const accepted = gameReducer(offered, response);
        expect(hasAcceptedTrade(accepted.board, accepted.state, proposer)).toBe(true);
        expect(hasAcceptedTrade(offered.board, offered.state, proposer)).toBe(false);
        expect(stateHash(initial.state)).toBe(initialHash);
        expect(serializeState(initial.state)).toBe(initialSerialized);
        const second = gameReducer(accepted, uiOffer(2));
        const beforeAnswer = stateHash(second.state);
        const serializedBeforeAnswer = serializeState(second.state);
        const guarded = createAIBot(tier, 18, tradeConfig()).chooseAction(
          second.board,
          second.state,
          2,
        );
        expect(guarded).toEqual({
          type: 'respondTrade',
          accept: false,
          reason: 'already traded this turn',
        });
        expect(stateHash(second.state)).toBe(beforeAnswer);
        expect(serializeState(second.state)).toBe(serializedBeforeAnswer);
        const declined = gameReducer(second, guarded);
        expect(declined.log.at(-1)?.events).toContainEqual({
          type: 'tradeResponse',
          player: 2,
          accept: false,
          reason: 'already traded this turn',
        });
      },
    );
  }
  it.each(['Astyanax', 'Paris'])(
    '%s still accepts a beneficial second proposal with public history present',
    (tier) => {
      let session = gameReducer(tradeSession(), uiOffer(1, 2));
      session = gameReducer(session, { type: 'respondTrade', accept: true });
      session = gameReducer(session, uiOffer(2));
      expect(hasAcceptedTrade(session.board, session.state, 0)).toBe(true);
      expect(Boolean(tierByName(tier).tradeGuards)).toBe(false);
      const response = createAIBot(tier, 19, tradeConfig()).chooseAction(
        session.board,
        session.state,
        2,
      );
      expect(response).toEqual({ type: 'respondTrade', accept: true });
      const accepted = gameReducer(session, response);
      expect(accepted.log.at(-1)?.events).toContainEqual({
        type: 'tradeResponse',
        player: 2,
        accept: true,
      });
    },
  );
  it('preserves existing metadata through sibling clones, serialization and saves even without a public log', () => {
    const proposed = gameReducer(tradeSession(), uiOffer(1));
    const accepted = gameReducer(proposed, { type: 'respondTrade', accept: true });
    const hash = stateHash(accepted.state);
    const serialized = serializeState(accepted.state);
    const restored = decodeSave(encodeSave({ ...accepted, log: [] }));
    expect(stateHash(restored.state)).toBe(hash);
    expect(serializeState(restored.state)).toBe(serialized);
    expect(hasAcceptedTrade(restored.board, restored.state, 0)).toBe(true);
    expect(
      (deserializeState(serializeState(accepted.state)) as TradeHistoryState).aiTradeHistory,
    ).toEqual((accepted.state as TradeHistoryState).aiTradeHistory);
    const ended = gameReducer(accepted, { type: 'endTurn' });
    expect(hasAcceptedTrade(ended.board, ended.state, 0)).toBe(false);
    expect(stateHash(accepted.state)).toBe(hash);
    expect(serializeState(accepted.state)).toBe(serialized);
  });
  it('recovers missing legacy history from each current-turn event entry and leaves the original save unchanged', () => {
    let session = gameReducer(tradeSession(), uiOffer(1));
    session = gameReducer(session, { type: 'respondTrade', accept: true });
    const text = legacySave(session);
    const spy = vi.spyOn(ai, 'recordTradeEvents');
    try {
      const restored = decodeSave(text);
      expect(hasAcceptedTrade(restored.board, restored.state, 0)).toBe(true);
      expect(spy).toHaveBeenCalledTimes(session.log.length);
      for (const [index, entry] of session.log.entries())
        expect(spy.mock.calls[index]).toEqual([restored.board, restored.state, entry.events]);
      expect(JSON.parse(JSON.parse(text).state).aiTradeHistory).toBeUndefined();
      const savedAgain = decodeSave(encodeSave(restored));
      expect(stateHash(savedAgain.state)).toBe(stateHash(restored.state));
      expect(serializeState(savedAgain.state)).toBe(serializeState(restored.state));
    } finally {
      spy.mockRestore();
    }
  });
  it('ignores prior-turn acceptances and an uncommitted chosen answer during legacy recovery', () => {
    let session = gameReducer(tradeSession(), uiOffer(1));
    session = {
      ...session,
      log: [
        { turn: 6, events: [{ type: 'tradeResponse', player: 1, accept: true }] },
        ...session.log,
      ],
    };
    const hash = stateHash(session.state);
    const serialized = serializeState(session.state);
    const answer = createAIBot('Paris', 17, tradeConfig()).chooseAction(
      session.board,
      session.state,
      1,
    );
    expect(answer).toEqual({ type: 'respondTrade', accept: true });
    expect(stateHash(session.state)).toBe(hash);
    expect(serializeState(session.state)).toBe(serialized);
    const spy = vi.spyOn(ai, 'recordTradeEvents');
    try {
      const restored = decodeSave(legacySave(session));
      expect(hasAcceptedTrade(restored.board, restored.state, 0)).toBe(false);
      expect(restored.state.phase).toBe('tradeResponse');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][2]).toEqual(session.log[1].events);
      const accepted = gameReducer(restored, answer);
      expect(hasAcceptedTrade(accepted.board, accepted.state, 0)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
  it('validates the original legacy hash before reading public history', () => {
    const session = gameReducer(tradeSession(), uiOffer(1));
    const raw = JSON.parse(legacySave(session));
    raw.hash = 'broken';
    const spy = vi.spyOn(ai, 'recordTradeEvents');
    try {
      expect(() => decodeSave(JSON.stringify(raw))).toThrow('Damaged save');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
  it('starts new games and same-map rematches with no prior accepted-trade metadata', () => {
    let session = gameReducer(tradeSession(), uiOffer(1));
    session = gameReducer(session, { type: 'respondTrade', accept: true });
    expect(hasAcceptedTrade(session.board, session.state, 0)).toBe(true);
    for (const seed of [session.settings.seed, 'fresh-map-after-trade']) {
      const fresh = newSession({ ...session.settings, seed });
      expect(fresh.state.turn).toBe(0);
      expect(Object.hasOwn(fresh.state, 'aiTradeHistory')).toBe(false);
      expect(fresh.history).toEqual([]);
      expect(fresh.log).toEqual([]);
      expect(hasAcceptedTrade(fresh.board, fresh.state, 0)).toBe(false);
      expect(stateHash(decodeSave(encodeSave(fresh)).state)).toBe(stateHash(fresh.state));
    }
  });
});
