/** Shared-player softmax value model, usable unchanged in Node and browser Workers. */
import initial from './weights/w0.json' with { type: 'json' };
import fitted from './weights/fitted.json' with { type: 'json' };
import type { Board, GameState } from '../engine/index.js';
import { allFeatures } from './features.js';
/** One coefficient for each FEATURE_NAMES entry, shared by every player. */
export type Weights = readonly number[];
/** Hand-set baseline; frozen to prevent a search from changing a live model. */
export const W0: Weights = Object.freeze([...initial.weights]);
/** Retained position model; JSON provenance distinguishes supervised fits, strength tuning and fallback. */
export const FITTED_WEIGHTS: Weights = Object.freeze([...fitted.weights]);
/** Stable softmax for training or inference; accepts readonly feature rows. */
export function probabilitiesFromFeatures(
  matrix: readonly (readonly number[])[],
  weights: Weights,
): number[] {
  if (!matrix.length) return [];
  const scores = matrix.map((row) => {
    if (row.length !== weights.length) throw new Error('Feature and weight lengths differ');
    let score = 0;
    for (let i = 0; i < weights.length; i++) score += row[i] * weights[i];
    return score;
  });
  const maximum = Math.max(...scores);
  const exponents = scores.map((score) => Math.exp(score - maximum));
  const sum = exponents.reduce((a, b) => a + b, 0);
  return exponents.map((value) => value / sum);
}
/** Estimate win probabilities, returning an exact one-hot vector for finished games. */
export function evaluate(board: Board, state: GameState, weights: Weights = W0): number[] {
  if (state.phase === 'gameOver' && state.winnerId >= 0)
    return Array.from({ length: state.players }, (_, p) => Number(p === state.winnerId));
  return probabilitiesFromFeatures(allFeatures(board, state), weights);
}
