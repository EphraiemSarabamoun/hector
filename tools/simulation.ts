/** Shared simulation loop and statistical summaries, with no filesystem or process side effects. */
import { CONFIG, createGame, renown } from '../src/engine/index.js';
import { createBot } from '../src/bots/index.js';
import { applyWithTradeHistory, createAIBot } from '../src/ai/index.js';
export interface GameResult {
  game: number;
  seed: number;
  turns: number;
  capped: boolean;
  winner: number;
  winningBot: string;
  bots: string[];
  renown: number[];
  actions: number;
  landAttempts: number;
  mapRestarts: number;
  /** Older saved fixtures may omit the randomized turn order; never infer it from player IDs. */
  turnOrder?: number[];
}
/** Rotate named entrants across all seats; a seed identifies both map and chance stream. */
export function simulate(game: number, seed: number, names: readonly string[]): GameResult {
  const bots = names.map((_, seat) =>
    ['random', 'greedy'].includes(names[(seat + game) % names.length].toLowerCase())
      ? createBot(names[(seat + game) % names.length].toLowerCase(), `${seed}:bot:${seat}`)
      : createAIBot(names[(seat + game) % names.length], `${seed}:bot:${seat}`),
  );
  const { board, state } = createGame(seed, names.length);
  let actions = 0;
  let capped = false;
  while (state.phase !== 'gameOver') {
    const action = bots[state.toAct].chooseAction(board, state, state.toAct);
    const events = applyWithTradeHistory(board, state, action);
    actions++;
    if (events.some((e) => e.type === 'winner' && e.reason === 'turnCap')) capped = true;
  }
  return {
    game,
    seed,
    turns: state.turn,
    capped,
    winner: state.winnerId,
    winningBot: bots[state.winnerId].name,
    bots: bots.map((b) => b.name),
    renown: bots.map((_, p) => renown(board, state, p)),
    actions,
    landAttempts: board.generation.landAttempts,
    mapRestarts: board.generation.restarts,
    turnOrder: Array.from(state.turnOrder),
  };
}
const Z95 = 1.959963984540054;
/** Wilson score interval avoids impossible negative rates for small samples and rare caps. */
export function interval(wins: number, n: number): [number, number] {
  if (!n) return [0, 1];
  const z = Z95;
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [
    wins === 0 ? 0 : Math.max(0, centre - margin),
    wins === n ? 1 : Math.min(1, centre + margin),
  ];
}
/** Report stable player IDs separately from randomized starting-order positions. */
export function summarize(rows: readonly GameResult[]) {
  const turns = rows.map((r) => r.turns).sort((a, b) => a - b);
  const n = rows.length;
  const seatCount = rows[0]?.bots.length ?? CONFIG.players.default;
  const rates = (wins: number, total: number) => ({
    wins,
    games: total,
    rate: total ? wins / total : 0,
    interval95: interval(wins, total),
  });
  const byPlayerId = Array.from({ length: seatCount }, (_, playerId) => ({
    playerId,
    ...rates(rows.filter((r) => r.winner === playerId).length, n),
  }));
  const byTurnPosition = Array.from({ length: seatCount }, (_, position) => {
    const known = rows.filter((r) => r.turnOrder && r.turnOrder.length > position);
    return {
      position,
      ...rates(known.filter((r) => r.turnOrder![position] === r.winner).length, known.length),
    };
  });
  return {
    games: n,
    meanTurns: n ? turns.reduce((a, b) => a + b, 0) / n : 0,
    medianTurns: !n ? 0 : n % 2 ? turns[Math.floor(n / 2)] : (turns[n / 2 - 1] + turns[n / 2]) / 2,
    capRate: n ? rows.filter((r) => r.capped).length / n : 0,
    byPlayerId,
    byTurnPosition,
    // Retain the old label for saved reports and consumers migrating to explicit names.
    bySeat: byPlayerId.map(({ playerId, ...rate }) => ({ seat: playerId, ...rate })),
    byBot: [...new Set(rows.flatMap((r) => r.bots))].map((bot) => {
      const wins = rows.filter((r) => r.winningBot === bot).length;
      const appearances = rows.reduce(
        (n, r) => n + r.bots.filter((name) => name === bot).length,
        0,
      );
      const rate = wins / appearances;
      const repeated = rows.some((r) => r.bots.filter((name) => name === bot).length > 1);
      // A game is one independent cluster, even if several seats share a bot type.
      const residuals = rows.map(
        (r) => Number(r.winningBot === bot) - rate * r.bots.filter((name) => name === bot).length,
      );
      const error =
        rows.length > 1
          ? (Z95 *
              Math.sqrt(
                (rows.length / (rows.length - 1)) * residuals.reduce((n, x) => n + x * x, 0),
              )) /
            appearances
          : 1;
      const interval95 = repeated
        ? [Math.max(0, rate - error), Math.min(1, rate + error)]
        : interval(wins, appearances);
      return {
        bot,
        wins,
        appearances,
        rate,
        interval95,
        intervalMethod: repeated ? 'game-cluster normal' : 'Wilson',
      };
    }),
    map: {
      restarts: rows.reduce((n, r) => n + r.mapRestarts, 0),
      landAttempts: rows.reduce((n, r) => n + r.landAttempts, 0),
      landRetryRate: rows.length
        ? rows.reduce((n, r) => n + r.landAttempts - 1, 0) /
          rows.reduce((n, r) => n + r.landAttempts, 0)
        : 0,
    },
  };
}
