/** Public engine boundary. Consumers import this module rather than internal implementation paths. */
export * from './config.js';
export * from './rng.js';
export * from './board.js';
export * from './mapgen.js';
export * from './state.js';
export * from './actions.js';
export * from './rules.js';
import { generateBoard } from './mapgen.js';
import { createState } from './state.js';
import { CONFIG } from './config.js';
/** Generate a fresh map and a ready-to-place setup position from a single replay seed. */
export function createGame(seed: number | string, players: number = CONFIG.players.default) {
  const board = generateBoard(seed);
  return { board, state: createState(board, seed, players) };
}
