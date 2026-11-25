/** Stable real-AI port shared by difficulty selection and worker computation. */
import { createAIBot, TIERS } from '../ai/index.js';
export { createAIBot, TIERS };
export type Tier = (typeof TIERS)[number]['name'];
