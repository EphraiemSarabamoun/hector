/** Reporting checks use explicit outcomes, independent of the bot implementation. */
import { it, expect } from 'vitest';
import { interval, summarize, simulate, type GameResult } from '../tools/simulation.js';
it('reports bot wins per seat appearance and seat wins per independent game', () => {
  const rows: GameResult[] = Array.from({ length: 3 }, (_, game) => ({
    game,
    seed: game,
    turns: game * 10 + 10,
    capped: game === 2,
    winner: game,
    winningBot: game === 1 ? 'random' : 'greedy',
    bots: ['greedy', 'random', 'greedy'],
    renown: [1, 1, 1],
    actions: 1,
    landAttempts: 2,
    mapRestarts: 0,
  }));
  const stats = summarize(rows);
  expect(stats.meanTurns).toBe(20);
  expect(stats.medianTurns).toBe(20);
  expect(stats.capRate).toBe(1 / 3);
  expect(stats.bySeat.map((s) => s.rate)).toEqual([1 / 3, 1 / 3, 1 / 3]);
  expect(stats.byBot.find((b) => b.bot === 'greedy')).toMatchObject({
    wins: 2,
    appearances: 6,
    rate: 1 / 3,
  });
  expect(stats.byBot.find((b) => b.bot === 'random')).toMatchObject({
    wins: 1,
    appearances: 3,
    rate: 1 / 3,
  });
  expect(stats.map.landRetryRate).toBe(0.5);
  expect(stats.byBot.find((b) => b.bot === 'greedy')?.intervalMethod).toBe('game-cluster normal');
  const same = rows.map((r) => ({
    ...r,
    bots: ['greedy', 'greedy', 'greedy'],
    winningBot: 'greedy',
  }));
  expect(summarize(same).byBot[0].interval95).toEqual([1 / 3, 1 / 3]);
});
it('keeps Wilson intervals within probability bounds and includes exact zero/one rates', () => {
  expect(interval(0, 0)).toEqual([0, 1]);
  expect(interval(0, 100)[0]).toBe(0);
  expect(interval(100, 100)[1]).toBe(1);
  expect(interval(50, 100)[0]).toBeCloseTo(0.4038, 4);
  expect(interval(50, 100)[1]).toBeCloseTo(0.5962, 4);
});
it('separates stable player IDs from randomized turn positions and does not invent old order data', () => {
  const base: GameResult = {
    game: 0,
    seed: 0,
    turns: 10,
    capped: false,
    winner: 2,
    winningBot: 'greedy',
    bots: ['greedy', 'greedy', 'greedy'],
    renown: [1, 1, 12],
    actions: 1,
    landAttempts: 1,
    mapRestarts: 0,
    turnOrder: [2, 0, 1],
  };
  const rows = [base, { ...base, game: 1, winner: 0, turnOrder: [0, 2, 1] }];
  const summary = summarize(rows);
  expect(summary.byPlayerId.map((s) => s.rate)).toEqual([0.5, 0, 0.5]);
  expect(summary.byTurnPosition.map((s) => s.rate)).toEqual([1, 0, 0]);
  expect(summary.bySeat.map((s) => s.rate)).toEqual(summary.byPlayerId.map((s) => s.rate));
  expect(summary.byTurnPosition.every((s) => s.games === 2)).toBe(true);
  const legacy = { ...base };
  delete legacy.turnOrder;
  expect(
    summarize([legacy]).byTurnPosition.every(
      (s) => s.games === 0 && s.interval95[0] === 0 && s.interval95[1] === 1,
    ),
  ).toBe(true);
  expect(summarize([])).toMatchObject({ games: 0, meanTurns: 0, medianTurns: 0, capRate: 0 });
});
it('records the replayable order in a seeded simulated game', () => {
  const a = simulate(0, 77, ['greedy', 'greedy', 'greedy']);
  const b = simulate(0, 77, ['greedy', 'greedy', 'greedy']);
  expect(a).toEqual(b);
  expect([...a.turnOrder!].sort()).toEqual([0, 1, 2]);
  expect(a.turnOrder!.indexOf(a.winner)).toBeGreaterThanOrEqual(0);
});
