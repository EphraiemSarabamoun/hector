/** Stable map identity survives Web Worker structured clones, unlike JavaScript object identity. */
import type { Board } from '../engine/index.js';

const identities = new WeakMap<Board, string>();

/** Boards are immutable plain records; cache their full serialized content without seed-collision assumptions. */
export function boardKey(board: Board): string {
  let key = identities.get(board);
  if (key === undefined) {
    key = JSON.stringify(board);
    identities.set(board, key);
  }
  return key;
}
