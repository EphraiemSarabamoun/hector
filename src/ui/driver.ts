/** Worker-backed AI boundary. Screens never execute bot search on the browser's main thread. */
import { serializeState, type Action, type Board, type GameState } from '../engine/index.js';
import type { Tier } from './aiPort.js';
import type { DecisionContext, DecisionRequest, DecisionResponse } from './workerProtocol.js';
export type { DecisionContext } from './workerProtocol.js';
export { TIERS, type Tier } from './aiPort.js';
export interface Driver {
  readonly name: string;
  readonly tier: Tier;
  decide(
    board: Board,
    state: GameState,
    player: number,
    signal?: AbortSignal,
    context?: DecisionContext,
  ): Promise<Action>;
  cancel(): void;
  dispose(): void;
}
/** A minimal transport permits Node acceptance tests to exercise this same driver class. */
export interface WorkerTransport {
  onmessage: ((event: MessageEvent<DecisionResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(request: DecisionRequest): void;
  terminate(): void;
}
export type WorkerFactory = () => WorkerTransport;
interface PendingDecision {
  requestId: number;
  resolve(action: Action): void;
  reject(error: Error): void;
  removeAbort(): void;
}
/** Construct lazily so the new-game screen and Node rendering need no global Worker. */
function browserWorker(): WorkerTransport {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
}
/** Use the standard abort error shape so navigation cancellations do not show an error notice. */
function abortError(): DOMException {
  return new DOMException('Decision cancelled', 'AbortError');
}
/** Own one worker and at most one request; termination interrupts synchronous search immediately. */
export class WorkerDriver implements Driver {
  readonly name: string;
  private worker?: WorkerTransport;
  private pending?: PendingDecision;
  private nextRequestId = 0;
  private disposed = false;
  constructor(
    readonly tier: Tier,
    private readonly seed?: number | string,
    private readonly workerFactory: WorkerFactory = browserWorker,
  ) {
    this.name = tier;
  }
  /** Serialize immediately so later reducer updates cannot alter an in-flight decision. */
  decide(
    board: Board,
    state: GameState,
    player: number,
    signal?: AbortSignal,
    context?: DecisionContext,
  ): Promise<Action> {
    if (this.disposed) return Promise.reject(new Error('AI driver has been disposed'));
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.pending) this.cancel();
    return new Promise((resolve, reject) => {
      const requestId = ++this.nextRequestId;
      const onAbort = () => {
        if (this.pending?.requestId === requestId) this.cancel();
      };
      this.pending = {
        requestId,
        resolve,
        reject,
        removeAbort: () => signal?.removeEventListener('abort', onAbort),
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const worker = this.ensureWorker();
        worker.postMessage({
          requestId,
          boardSeed: board.seed,
          serializedState: serializeState(state),
          player,
          tier: this.tier,
          botSeed: this.seed,
          humanTradeOffered: context?.humanTradeOffered,
        });
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  /** Clear handlers before terminating so a queued reply cannot resolve a newer request. */
  private stopWorker(): void {
    if (!this.worker) return;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
    this.worker = undefined;
  }
  /** Reuse a completed worker, but create a fresh one after any cancellation or transport error. */
  private ensureWorker(): WorkerTransport {
    if (this.worker) return this.worker;
    const worker = this.workerFactory();
    this.worker = worker;
    worker.onmessage = (event) => {
      const response = event.data;
      if (this.worker !== worker || !this.pending || response.requestId !== this.pending.requestId)
        return;
      const pending = this.pending;
      this.pending = undefined;
      pending.removeAbort();
      if ('error' in response) pending.reject(new Error(response.error));
      else pending.resolve(response.action);
    };
    worker.onerror = (event) => {
      if (this.worker === worker) this.fail(new Error(event.message || 'AI worker failed'));
    };
    return worker;
  }
  /** Reject exactly the active request and retire the transport after failure or navigation. */
  private fail(error: Error): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.removeAbort();
    this.stopWorker();
    pending?.reject(error);
  }
  /** The next decide lazily respawns the terminated worker, including after a finished turn. */
  cancel(): void {
    this.fail(abortError());
  }
  /** Release browser resources permanently when a game's driver set leaves the screen. */
  dispose(): void {
    this.disposed = true;
    this.cancel();
  }
}
/** All browser call sites receive the real worker implementation; tests may inject only transport. */
export function createDriver(
  tier: Tier,
  seed?: number | string,
  workerFactory?: WorkerFactory,
): WorkerDriver {
  return new WorkerDriver(tier, seed, workerFactory);
}
