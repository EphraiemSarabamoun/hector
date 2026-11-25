/** Dedicated AI thread. The stable aiPort module selects the baseline or merged AI implementation. */
import { createAIBot } from './aiPort.js';
import {
  createDecisionComputer,
  type DecisionRequest,
  type DecisionResponse,
} from './workerProtocol.js';
const compute = createDecisionComputer(createAIBot);
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<DecisionRequest>) => void) | null;
  postMessage(response: DecisionResponse): void;
};
scope.onmessage = (event) => scope.postMessage(compute(event.data));
