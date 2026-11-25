/** Transport acceptance covers typed position roundtrips and cancellation interleavings. */
import { describe, expect, it, vi } from 'vitest';
import {
  createGame,
  Good,
  GOOD_COUNT,
  legalActions,
  isLegal,
  serializeState,
  stateHash,
  type Action,
} from '../src/engine/index.js';
import { createAIBot } from '../src/ui/aiPort.js';
import { hasAcceptedTrade, type SearchConfig } from '../src/ai/index.js';
import { decodeSave, encodeSave, gameReducer, newSession } from '../src/ui/game.js';
import {
  createDriver,
  WorkerDriver,
  type WorkerFactory,
  type WorkerTransport,
} from '../src/ui/driver.js';
import {
  createDecisionComputer,
  type DecisionRequest,
  type DecisionResponse,
} from '../src/ui/workerProtocol.js';
/** Hold replies until explicitly delivered to reproduce late worker events deterministically. */
function heldTransport() {
  const requests: DecisionRequest[] = [];
  let terminated = false;
  const transport: WorkerTransport = {
    onmessage: null,
    onerror: null,
    postMessage(request) {
      requests.push(structuredClone(request));
    },
    terminate() {
      terminated = true;
    },
  };
  return {
    transport,
    requests,
    get terminated() {
      return terminated;
    },
  };
}
describe('worker AI transport', () => {
  it.each([
    ['Hector', 3000],
    ['Astyanax', undefined],
    ['Paris', undefined],
    ['Aeneas', undefined],
    ['Sarpedon', undefined],
  ] as const)(
    'configures %s human identity and browser time limit for both cached rival seats',
    (tierName, timeLimitMs) => {
      const { board, state } = createGame('worker-human-seat');
      const constructions: {
        tier: string;
        seed: number | string;
        overrides: Partial<SearchConfig> | undefined;
      }[] = [];
      const decisions: number[] = [];
      const compute = createDecisionComputer((tier, seed, overrides) => {
        constructions.push({ tier, seed, overrides });
        return {
          chooseAction(receivedBoard, receivedState, player) {
            decisions.push(player);
            return legalActions(receivedBoard, receivedState)[0];
          },
        };
      });
      for (const [requestId, player] of [1, 2, 1, 2].entries()) {
        const position = { ...state, toAct: player };
        const response = compute({
          requestId,
          boardSeed: board.seed,
          serializedState: serializeState(position),
          player,
          tier: tierName,
        });
        expect(response).toEqual({ requestId, action: legalActions(board, position)[0] });
      }
      expect(constructions).toEqual([
        {
          tier: tierName,
          seed: `${board.seed}:ai:1`,
          overrides: { humanPlayers: [0], timeLimitMs },
        },
        {
          tier: tierName,
          seed: `${board.seed}:ai:2`,
          overrides: { humanPlayers: [0], timeLimitMs },
        },
      ]);
      expect(decisions).toEqual([1, 2, 1, 2]);
    },
  );
  it('restores the saved human-offer cap by asking the same bot twice on the same unchanged position', () => {
    const { board, state } = createGame('worker-saved-human-offer');
    const position = { ...state, toAct: 1 };
    const hash = stateHash(position);
    const humanOffer: Action = {
      type: 'proposeTrade',
      to: 0,
      give: [1, 0, 0, 0, 0],
      get: [0, 1, 0, 0, 0],
    };
    const botOffer: Action = { ...humanOffer, to: 2 };
    const positions: unknown[] = [];
    let creations = 0;
    const compute = createDecisionComputer(() => {
      creations++;
      let calls = 0;
      return {
        chooseAction(_board, receivedState) {
          positions.push(receivedState);
          expect(stateHash(receivedState)).toBe(hash);
          return calls++ === 0 ? humanOffer : botOffer;
        },
      };
    });
    expect(
      compute({
        requestId: 1,
        boardSeed: board.seed,
        serializedState: serializeState(position),
        player: 1,
        tier: 'Hector',
        humanTradeOffered: true,
      }),
    ).toEqual({ requestId: 1, action: botOffer });
    expect(creations).toBe(1);
    expect(positions).toHaveLength(2);
    expect(positions[0]).toBe(positions[1]);
    expect(stateHash(position)).toBe(hash);
  });
  it('allows a first human offer and bounds retries for a bot that ignores the saved human-offer cap', () => {
    const { board, state } = createGame('worker-bounded-human-offer');
    const humanOffer: Action = {
      type: 'proposeTrade',
      to: 0,
      give: [1, 0, 0, 0, 0],
      get: [0, 1, 0, 0, 0],
    };
    let calls = 0;
    const compute = createDecisionComputer(() => ({
      chooseAction() {
        calls++;
        return humanOffer;
      },
    }));
    const request: DecisionRequest = {
      requestId: 1,
      boardSeed: board.seed,
      serializedState: serializeState(state),
      player: state.toAct,
      tier: 'Hector',
    };
    expect(compute(request)).toEqual({ requestId: 1, action: humanOffer });
    expect(calls).toBe(1);
    expect(compute({ ...request, requestId: 2, humanTradeOffered: true })).toEqual({
      requestId: 2,
      error: 'AI repeated a human trade offer after the per-turn human offer limit',
    });
    expect(calls).toBe(3);
  });
  it('spends only the remaining cap on a saved-offer retry and restores the next request budget', () => {
    const { board, state } = createGame('worker-shared-time-budget');
    const humanOffer: Action = {
      type: 'proposeTrade',
      to: 0,
      give: [1, 0, 0, 0, 0],
      get: [0, 1, 0, 0, 0],
    };
    const botOffer: Action = { ...humanOffer, to: 2 };
    let clock = 100;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const config = { timeLimitMs: 3000 };
    const budgets: (number | undefined)[] = [];
    const compute = createDecisionComputer(() => ({
      config,
      chooseAction() {
        budgets.push(config.timeLimitMs);
        clock += 1700;
        return budgets.length === 1 ? humanOffer : botOffer;
      },
    }));
    const request: DecisionRequest = {
      requestId: 1,
      boardSeed: board.seed,
      serializedState: serializeState(state),
      player: state.toAct,
      tier: 'Hector',
      humanTradeOffered: true,
    };
    try {
      expect(compute(request)).toEqual({ requestId: 1, action: botOffer });
      expect(budgets).toEqual([3000, 1300]);
      expect(config.timeLimitMs).toBe(3000);
      expect(compute({ ...request, requestId: 2, humanTradeOffered: false })).toEqual({
        requestId: 2,
        action: botOffer,
      });
      expect(budgets).toEqual([3000, 1300, 3000]);
    } finally {
      now.mockRestore();
    }
  });
  it.each(['throw', 'repeat'] as const)(
    'restores the configured cap when a saved-offer retry fails by %s',
    (failure) => {
      const { board, state } = createGame('worker-retry-cap-error');
      const humanOffer: Action = {
        type: 'proposeTrade',
        to: 0,
        give: [1, 0, 0, 0, 0],
        get: [0, 1, 0, 0, 0],
      };
      let clock = 0;
      const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
      const config = { timeLimitMs: 3000 };
      const budgets: (number | undefined)[] = [];
      const compute = createDecisionComputer(() => ({
        config,
        chooseAction() {
          budgets.push(config.timeLimitMs);
          clock += 1000;
          if (budgets.length === 2 && failure === 'throw') throw new Error('retry failed');
          return budgets.length <= 2 ? humanOffer : { type: 'endTurn' };
        },
      }));
      const request: DecisionRequest = {
        requestId: 1,
        boardSeed: board.seed,
        serializedState: serializeState(state),
        player: state.toAct,
        tier: 'Hector',
        humanTradeOffered: true,
      };
      try {
        expect(compute(request)).toEqual({
          requestId: 1,
          error:
            failure === 'throw'
              ? 'retry failed'
              : 'AI repeated a human trade offer after the per-turn human offer limit',
        });
        expect(budgets).toEqual([3000, 2000]);
        expect(config.timeLimitMs).toBe(3000);
        expect(compute({ ...request, requestId: 2, humanTradeOffered: false })).toEqual({
          requestId: 2,
          action: { type: 'endTurn' },
        });
        expect(budgets).toEqual([3000, 2000, 3000]);
      } finally {
        now.mockRestore();
      }
    },
  );
  it('ends the turn without retrying when the first capped decision exhausts the request budget', () => {
    const { board, state } = createGame('worker-expired-retry');
    Object.assign(state, { phase: 'main', active: 1, toAct: 1 });
    const config = { timeLimitMs: 3000 };
    let calls = 0;
    const now = vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(3100);
    const compute = createDecisionComputer(() => ({
      config,
      chooseAction() {
        calls++;
        return { type: 'proposeTrade', to: 0, give: [1, 0, 0, 0, 0], get: [0, 1, 0, 0, 0] };
      },
    }));
    try {
      const response = compute({
        requestId: 1,
        boardSeed: board.seed,
        serializedState: serializeState(state),
        player: 1,
        tier: 'Hector',
        humanTradeOffered: true,
      });
      expect(response).toEqual({ requestId: 1, action: { type: 'endTurn' } });
      expect(isLegal(board, state, { type: 'endTurn' })).toBe(true);
      expect(calls).toBe(1);
      expect(config.timeLimitMs).toBe(3000);
    } finally {
      now.mockRestore();
    }
  });
  it('does not read the clock or change public config for an uncapped tier retry', () => {
    const { board, state } = createGame('worker-uncapped-retry');
    const config = Object.freeze({ timeLimitMs: undefined });
    const now = vi.spyOn(performance, 'now').mockImplementation(() => {
      throw new Error('Unexpected uncapped clock read');
    });
    let calls = 0;
    const compute = createDecisionComputer(() => ({
      config,
      chooseAction() {
        return ++calls === 1
          ? { type: 'proposeTrade', to: 0, give: [1, 0, 0, 0, 0], get: [0, 1, 0, 0, 0] }
          : { type: 'endTurn' };
      },
    }));
    try {
      expect(
        compute({
          requestId: 1,
          boardSeed: board.seed,
          serializedState: serializeState(state),
          player: state.toAct,
          tier: 'Paris',
          humanTradeOffered: true,
        }),
      ).toEqual({ requestId: 1, action: { type: 'endTurn' } });
      expect(calls).toBe(2);
      expect(now).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });
  it.each(['Aeneas', 'Sarpedon', 'Hector'])(
    '%s reads saved table-wide history after cancellation, worker recreation and reload',
    async (tier) => {
      let session = newSession({
        name: 'Saved guard house',
        colour: '#b84448',
        tiers: ['Paris', tier],
        seed: 'worker-guard-history',
        speed: 'instant',
      });
      Object.assign(session.state, { phase: 'main', active: 1, toAct: 1, turn: 9, turnIndex: 1 });
      session.state.turnOrder.set([0, 1, 2]);
      for (let player = 0; player < 3; player++) {
        session.state.hands[player * GOOD_COUNT + Good.Timber] = 3;
        session.state.hands[player * GOOD_COUNT + Good.Horses] = 3;
      }
      const offer: Extract<Action, { type: 'proposeTrade' }> = {
        type: 'proposeTrade',
        to: 0,
        give: [1, 0, 0, 0, 0],
        get: [0, 0, 0, 0, 1],
      };
      session = gameReducer(session, offer);
      session = gameReducer(session, { type: 'respondTrade', accept: true });
      session = gameReducer(session, { ...offer, to: 2 });
      expect(hasAcceptedTrade(session.board, session.state, 1)).toBe(true);
      const save = encodeSave(session);
      const serialized = serializeState(session.state);
      const workers: {
        held: ReturnType<typeof heldTransport>;
        compute: ReturnType<typeof createDecisionComputer>;
      }[] = [];
      const driver = createDriver(tier, undefined, () => {
        const held = heldTransport();
        workers.push({ held, compute: createDecisionComputer(createAIBot) });
        return held.transport;
      });
      const cancelled = driver.decide(session.board, session.state, 2, undefined, {
        humanTradeOffered: true,
      });
      driver.cancel();
      await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
      for (let restart = 0; restart < 2; restart++) {
        const restored = decodeSave(save);
        const pending = driver.decide(restored.board, restored.state, 2, undefined, {
          humanTradeOffered: true,
        });
        const worker = workers.at(-1)!;
        const request = worker.held.requests.at(-1)!;
        expect(JSON.parse(request.serializedState).aiTradeHistory.acceptedProposers).toEqual([1]);
        const response = worker.compute(request);
        worker.held.transport.onmessage?.({ data: response } as MessageEvent<DecisionResponse>);
        const action = await pending;
        expect(action).toEqual({
          type: 'respondTrade',
          accept: false,
          reason: 'already traded this turn',
        });
        expect(serializeState(restored.state)).toBe(serialized);
        expect(hasAcceptedTrade(restored.board, restored.state, 2)).toBe(false);
        const declined = gameReducer(restored, action);
        expect(declined.log.at(-1)?.events).toContainEqual({
          type: 'tradeResponse',
          player: 2,
          accept: false,
          reason: 'already traded this turn',
        });
        driver.cancel();
      }
      expect(workers).toHaveLength(3);
      expect(workers.every((worker) => worker.held.terminated)).toBe(true);
      expect(serializeState(session.state)).toBe(serialized);
      driver.dispose();
    },
  );
  it('roundtrips every serialized typed buffer and returns an action without mutating the snapshot', async () => {
    const { board, state } = createGame('worker-roundtrip');
    const hash = stateHash(state);
    const held = heldTransport();
    const driver = createDriver('Hector', 123, () => held.transport);
    expect(driver).toBeInstanceOf(WorkerDriver);
    const pending = driver.decide(board, state, state.toAct);
    expect(held.requests[0].serializedState).toBe(serializeState(state));
    expect(held.requests[0].boardSeed).toBe(board.seed);
    let called = false;
    const compute = createDecisionComputer((tier, seed, overrides) => ({
      chooseAction(receivedBoard, receivedState, player) {
        called = true;
        expect(receivedBoard).not.toBe(board);
        expect(stateHash(receivedState)).toBe(hash);
        for (const [key, value] of Object.entries(state)) {
          if (ArrayBuffer.isView(value))
            expect(receivedState[key as keyof typeof state]).toBeInstanceOf(value.constructor);
        }
        return createAIBot(tier, seed, overrides).chooseAction(
          receivedBoard,
          receivedState,
          player,
        );
      },
    }));
    const response = compute(held.requests[0]);
    held.transport.onmessage?.({
      data: structuredClone(response),
    } as MessageEvent<DecisionResponse>);
    expect(legalActions(board, state)).toContainEqual(await pending);
    expect(called).toBe(true);
    expect(stateHash(state)).toBe(hash);
    driver.dispose();
  });
  it('terminates cancelled work, respawns, and ignores queued replies from old workers or request ids', async () => {
    const { board, state } = createGame('worker-cancel');
    const workers: ReturnType<typeof heldTransport>[] = [];
    const factory: WorkerFactory = () => {
      const held = heldTransport();
      workers.push(held);
      return held.transport;
    };
    const driver = createDriver('Paris', undefined, factory);
    const first = driver.decide(board, state, state.toAct, undefined, { humanTradeOffered: true });
    const oldHandler = workers[0].transport.onmessage!;
    const firstRequest = workers[0].requests[0];
    expect(firstRequest.humanTradeOffered).toBe(true);
    driver.cancel();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(workers[0].terminated).toBe(true);
    expect(workers).toHaveLength(1);
    const second = driver.decide(board, state, state.toAct, undefined, { humanTradeOffered: true });
    const secondRequest = workers[1].requests[0];
    expect(secondRequest.humanTradeOffered).toBe(true);
    expect(secondRequest.requestId).toBeGreaterThan(firstRequest.requestId);
    const compute = createDecisionComputer(createAIBot);
    oldHandler({ data: compute(firstRequest) } as MessageEvent<DecisionResponse>);
    workers[1].transport.onmessage?.({
      data: compute(firstRequest),
    } as MessageEvent<DecisionResponse>);
    let resolved = false;
    void second.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    workers[1].transport.onmessage?.({
      data: compute(secondRequest),
    } as MessageEvent<DecisionResponse>);
    await second;
    expect(workers[1].terminated).toBe(false);
    const third = driver.decide(board, state, state.toAct, undefined, { humanTradeOffered: false });
    expect(workers[1].requests[1].humanTradeOffered).toBe(false);
    expect(workers).toHaveLength(2);
    workers[1].transport.onmessage?.({
      data: compute(workers[1].requests[1]),
    } as MessageEvent<DecisionResponse>);
    await third;
    driver.dispose();
    expect(workers[1].terminated).toBe(true);
    await expect(driver.decide(board, state, state.toAct)).rejects.toThrow('disposed');
  });
  it('removes completed abort listeners so an old effect cannot cancel a new decision', async () => {
    const { board, state } = createGame('worker-completed-abort');
    const held = heldTransport();
    const driver = createDriver('Hector', undefined, () => held.transport);
    const abort = new AbortController();
    const compute = createDecisionComputer(createAIBot);
    const first = driver.decide(board, state, state.toAct, abort.signal);
    held.transport.onmessage?.({
      data: compute(held.requests[0]),
    } as MessageEvent<DecisionResponse>);
    await first;
    const second = driver.decide(board, state, state.toAct);
    abort.abort();
    expect(held.terminated).toBe(false);
    held.transport.onmessage?.({
      data: compute(held.requests[1]),
    } as MessageEvent<DecisionResponse>);
    await second;
    driver.dispose();
  });
  it('handles aborts, worker errors and computation errors without leaking active requests', async () => {
    const { board, state } = createGame('worker-errors');
    const held = heldTransport();
    let creations = 0;
    const driver = createDriver('Aeneas', undefined, () => {
      creations++;
      return held.transport;
    });
    const abort = new AbortController();
    abort.abort();
    await expect(driver.decide(board, state, state.toAct, abort.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(creations).toBe(0);
    const activeAbort = new AbortController();
    const cancelled = driver.decide(board, state, state.toAct, activeAbort.signal);
    activeAbort.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    const broken = driver.decide(board, state, state.toAct);
    held.transport.onerror?.({ message: 'worker exploded' } as ErrorEvent);
    await expect(broken).rejects.toThrow('worker exploded');
    const badPosition = driver.decide(board, state, state.toAct);
    const request = held.requests[held.requests.length - 1];
    const compute = createDecisionComputer(createAIBot);
    held.transport.onmessage?.({
      data: compute({ ...request, serializedState: 'invalid JSON' }),
    } as MessageEvent<DecisionResponse>);
    await expect(badPosition).rejects.toThrow();
    driver.dispose();
  });
});
