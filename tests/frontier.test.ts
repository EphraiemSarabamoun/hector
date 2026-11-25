/** Differential queue checks pin the planner's original current-index tie and swap semantics. */
import { describe, it, expect } from 'vitest';
import { IndexedFrontier } from '../src/ai/frontier.js';
import { nextRandom, seedValue } from '../src/engine/index.js';
interface Value {
  id: number;
  score: number;
}

/** Kept deliberately literal: this is the original planner frontier selection/removal sequence. */
function linearPop<T extends { score: number }>(frontier: T[]): T | undefined {
  if (!frontier.length) return undefined;
  let index = 0;
  for (let i = 1; i < frontier.length; i++)
    if (frontier[i].score > frontier[index].score) index = i;
  const value = frontier[index];
  frontier[index] = frontier[frontier.length - 1];
  frontier.pop();
  return value;
}

describe('indexed planner frontier', () => {
  it('uses current array index for ties, including the priority change caused by swapping the last entry', () => {
    const values = [
      { id: 0, score: 1 },
      { id: 1, score: 3 },
      { id: 2, score: 3 },
      { id: 3, score: 3 },
    ];
    const frontier = new IndexedFrontier(values);
    expect(Array.from({ length: 4 }, () => frontier.pop()!.id)).toEqual([1, 3, 2, 0]);
    expect(frontier.length).toBe(0);
    expect(frontier.pop()).toBeUndefined();
    const allEqual = new IndexedFrontier(values.map((value) => ({ ...value, score: 0 })));
    expect(Array.from({ length: 4 }, () => allEqual.pop()!.id)).toEqual([0, 3, 2, 1]);
  });
  it('handles an empty queue, repeated drain/refill, immutable values, and selection of the final array entry', () => {
    const frontier = new IndexedFrontier<Value>();
    expect(frontier.pop()).toBeUndefined();
    const value = Object.freeze({ id: 0, score: 1 });
    for (let repeat = 0; repeat < 100; repeat++) {
      frontier.push(value);
      frontier.push(value);
      frontier.push({ id: 1, score: 2 });
      expect(frontier.pop()!.id).toBe(1);
      expect(frontier.pop()).toBe(value);
      expect(frontier.pop()).toBe(value);
      expect(frontier.length).toBe(0);
    }
    expect(Object.keys(value)).toEqual(['id', 'score']);
  });
  it('matches 100,000 seeded mixed operations with frequent exact ties and special ordered numeric values', () => {
    for (const seed of ['frontier-one', 'frontier-two']) {
      const rng = { rng: seedValue(seed) },
        reference: Value[] = [];
      const frontier = new IndexedFrontier<Value>();
      let id = 0,
        pops = 0;
      for (let step = 0; step < 100000; step++) {
        if (!reference.length || nextRandom(rng) < 0.505) {
          const bucket = Math.floor(nextRandom(rng) * 20);
          const score =
            bucket === 0 ? -Infinity : bucket === 1 ? Infinity : bucket === 2 ? -0 : bucket % 6;
          const value = { id: id++, score };
          reference.push(value);
          frontier.push(value);
        } else {
          const expected = linearPop(reference),
            actual = frontier.pop();
          pops++;
          if (actual !== expected)
            throw new Error(
              `Pop mismatch at ${seed} operation ${step}: expected ${expected?.id}, got ${actual?.id}`,
            );
        }
        if (frontier.length !== reference.length) throw new Error(`Length mismatch at ${step}`);
      }
      while (reference.length) expect(frontier.pop()).toBe(linearPop(reference));
      expect(pops).toBeGreaterThan(40000);
      expect(frontier.length).toBe(0);
    }
  });
  it('matches deeply populated queues when every removal repairs both heap and frontier positions', () => {
    const values = Array.from({ length: 4096 }, (_, id) => ({ id, score: (id * 7) % 17 }));
    const reference = [...values],
      frontier = new IndexedFrontier(values);
    for (let pop = 0; pop < 12000; pop++) {
      expect(frontier.pop()).toBe(linearPop(reference));
      if (pop % 3 !== 0) {
        const value = { id: values.length + pop, score: pop % 17 };
        reference.push(value);
        frontier.push(value);
      }
    }
    while (reference.length) expect(frontier.pop()).toBe(linearPop(reference));
    expect(frontier.length).toBe(0);
  });
});
