/** An indexed max-heap with the planner's exact former array-and-swap removal order. */
interface Entry<T> {
  value: T;
  arrayIndex: number;
  heapIndex: number;
}

/** Choose the largest score, breaking exact ties by the current frontier array index.
 * Values must keep their ordered numeric score unchanged while queued. The planner's
 * scores are finite; NaN has no numeric ordering and is outside this queue's contract.
 * Heap positions and frontier positions are separate: removing an array entry swaps
 * the last frontier entry into its slot, which can change that entry's tie priority.
 */
export class IndexedFrontier<T extends { score: number }> {
  private readonly entries: Entry<T>[] = [];
  private readonly heap: Entry<T>[] = [];

  constructor(values: readonly T[] = []) {
    for (const value of values) this.push(value);
  }

  /** Number of queued values, matching the former frontier array's length. */
  get length(): number {
    return this.entries.length;
  }

  /** Append at the next array index and restore the heap's score/index priority. */
  push(value: T): void {
    const entry = { value, arrayIndex: this.entries.length, heapIndex: this.heap.length };
    this.entries.push(entry);
    this.heap.push(entry);
    this.siftUp(entry.heapIndex);
  }

  /** Remove the same value the original strict-greater linear scan would select. */
  pop(): T | undefined {
    if (!this.heap.length) return undefined;
    const chosen = this.heap[0];
    const arrayLast = this.entries.pop()!;
    const heapLast = this.heap.pop()!;
    if (heapLast !== chosen) {
      this.heap[0] = heapLast;
      heapLast.heapIndex = 0;
      this.siftDown(0);
    }
    if (arrayLast !== chosen) {
      this.entries[chosen.arrayIndex] = arrayLast;
      arrayLast.arrayIndex = chosen.arrayIndex;
      // Only its array index decreased. Its score is unchanged, so its priority
      // can only improve; heapIndex follows any movement during root removal.
      this.siftUp(arrayLast.heapIndex);
    }
    return chosen.value;
  }

  /** This is exact equality, matching the old scan's strict > rather than an epsilon or FIFO rule. */
  private higher(a: Entry<T>, b: Entry<T>): boolean {
    return (
      a.value.score > b.value.score ||
      (a.value.score === b.value.score && a.arrayIndex < b.arrayIndex)
    );
  }

  /** Exchange heap slots while maintaining both entries' back-pointers. */
  private swap(a: number, b: number): void {
    const first = this.heap[a],
      second = this.heap[b];
    this.heap[a] = second;
    second.heapIndex = a;
    this.heap[b] = first;
    first.heapIndex = b;
  }

  /** Repair an appended entry or an entry whose tie-breaking index just improved. */
  private siftUp(index: number): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.higher(this.heap[index], this.heap[parent])) break;
      this.swap(index, parent);
      index = parent;
    }
  }

  /** Repair the root after moving the final heap entry into the vacated root slot. */
  private siftDown(index: number): void {
    for (;;) {
      const left = index * 2 + 1;
      if (left >= this.heap.length) return;
      const right = left + 1;
      const best =
        right < this.heap.length && this.higher(this.heap[right], this.heap[left]) ? right : left;
      if (!this.higher(this.heap[best], this.heap[index])) return;
      this.swap(index, best);
      index = best;
    }
  }
}
