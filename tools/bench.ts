/** Single-process warm benchmarks on a live mid-game position; no parallel timing inflation. */
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import {
  createGame,
  cloneState,
  legalActions,
  apply,
  stateHash,
  deserializeState,
} from '../src/engine/index.js';
import { GreedyBot } from '../src/bots/index.js';
const game = createGame('bench');
const board = game.board;
const fixture = process.argv.indexOf('--position');
// Reusing an exact serialized position isolates engine speed from bot policy changes.
const state =
  fixture >= 0 ? deserializeState(readFileSync(process.argv[fixture + 1], 'utf8')) : game.state;
const bot = new GreedyBot();
while (fixture < 0 && (state.turn < 30 || state.phase !== 'main') && state.phase !== 'gameOver')
  apply(board, state, bot.chooseAction(board, state, state.toAct));
let sink = 0;
function measure(fn: () => void, duration: number) {
  let n = 0;
  const start = performance.now();
  do {
    for (let i = 0; i < 1000; i++) fn();
    n += 1000;
  } while (performance.now() - start < duration);
  return {
    operations: n,
    seconds: (performance.now() - start) / 1000,
    perSecond: n / ((performance.now() - start) / 1000),
  };
}
measure(() => {
  sink += cloneState(state).rng;
}, 100);
const clones = measure(() => {
  sink += cloneState(state).rng;
}, 1000);
const decisions = measure(() => {
  const copy = cloneState(state);
  const actions = legalActions(board, copy);
  if (actions.length) sink += apply(board, copy, actions[0]).length;
}, 1000);
const hashes = measure(() => {
  sink += parseInt(stateHash(state), 16);
}, 1000);
process.stdout.write(
  JSON.stringify(
    {
      clone: clones,
      applyAndLegalActions: decisions,
      stateHash: hashes,
      position: { turn: state.turn, phase: state.phase, hash: stateHash(state) },
      sink,
    },
    null,
    2,
  ) + '\n',
);
