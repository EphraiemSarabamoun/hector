/** Small replayable random stream: callers own the single mutable 32-bit state. */
export interface RandomState {
  rng: number;
}

/** Convert a numeric or textual seed to a stable unsigned word without host entropy. */
export function seedValue(seed: number | string): number {
  if (typeof seed === 'number') return seed >>> 0;
  let value = 2166136261;
  for (let i = 0; i < seed.length; i++) value = Math.imul(value ^ seed.charCodeAt(i), 16777619);
  return value >>> 0;
}

/** Advance Mulberry32 and return a uniform fraction; zero is a valid stream state. */
export function nextRandom(state: RandomState): number {
  state.rng = (state.rng + 0x6d2b79f5) >>> 0;
  let value = state.rng;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

/** Return a shuffled copy while preserving the input and consuming only this stream. */
export function shuffle<T>(state: RandomState, items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(nextRandom(state) * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}
