/** The single difficulty table. Fixed-work search policies with explicit optional browser deadline metadata. */
import { FITTED_WEIGHTS, W0 } from './value.js';
import type { SearchConfig } from './types.js';
export type { SearchConfig } from './types.js';
export interface TierDefinition extends SearchConfig {
  id: number;
  name: string;
  description: string;
  /** Browser workers opt into this runtime cap; deterministic arena controllers leave timeLimitMs unset. */
  browserTimeLimitMs?: number;
}
const base = {
  engine: 'planner' as const,
  weights: W0,
  randomMove: 0,
  noise: 0,
  eps: 0.001,
  delta: 0.015,
  openingTopK: 1,
  setupBudget: 0,
  lookahead: false,
  tradeGuards: false,
};
export const TIERS: readonly TierDefinition[] = Object.freeze(
  [
    {
      ...base,
      id: 1,
      name: 'Astyanax',
      description: 'Greedy decisions with forty percent exploration.',
      engine: 'greedy' as const,
      budget: 1,
      randomMove: 0.4,
      eps: 0,
      delta: 0.08,
    },
    {
      ...base,
      id: 2,
      name: 'Paris',
      description: 'A short noisy turn plan.',
      budget: 128,
      noise: 0.005,
      eps: 0,
      delta: 0.06,
    },
    {
      ...base,
      id: 3,
      name: 'Aeneas',
      tradeGuards: true,
      description: 'Position evaluation with deterministic turn planning.',
      weights: FITTED_WEIGHTS,
      budget: 128,
    },
    {
      ...base,
      id: 4,
      name: 'Sarpedon',
      tradeGuards: true,
      description: 'A deeper search with the position model.',
      weights: FITTED_WEIGHTS,
      budget: 4096,
      setupBudget: 2048,
    },
    {
      ...base,
      id: 5,
      name: 'Hector',
      tradeGuards: true,
      browserTimeLimitMs: 3000,
      description: 'Deep search with conservative trades.',
      weights: FITTED_WEIGHTS,
      budget: 32768,
      setupBudget: 8192,
      delta: 0.005,
    },
  ].map((tier) => Object.freeze(tier)),
);
/** Resolve friendly names without making the UI depend on capitalization. */
export function tierByName(name: string): TierDefinition {
  const tier = TIERS.find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (!tier) throw new Error(`Unknown difficulty: ${name}`);
  return tier;
}
