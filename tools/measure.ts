/** Recompute quantitative tournament claims from CSV artifacts, independently of search and arena summaries. */
import { readFile } from 'node:fs/promises';
import { interval } from './simulation.js';
/** Parse quoted CSV fields, including JSON arrays preserved in the game rows. */
export function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let field = '',
    quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === ',' && !quoted) {
      result.push(field);
      field = '';
    } else field += c;
  }
  result.push(field);
  return result;
}
/** Recount wins and durations; this tool never reruns or drops a game. */
export async function measureCsv(path: string) {
  const lines = (await readFile(path, 'utf8')).trim().split('\n');
  const keys = parseCsvLine(lines[0]);
  const rows = lines
    .slice(1)
    .map((line) => Object.fromEntries(parseCsvLine(line).map((value, i) => [keys[i], value])));
  const turns = rows.map((r) => Number(r.turns)).sort((a, b) => a - b),
    n = rows.length;
  const wins = rows.filter((r) => r.challengerWin === '1' || r.challengerWin === 'true').length;
  const seatRate = (count: number) => ({
    wins: count,
    rate: count / n,
    interval95: interval(count, n),
  });
  return {
    path,
    games: n,
    meanTurns: turns.reduce((a, b) => a + b, 0) / n,
    medianTurns: n % 2 ? turns[Math.floor(n / 2)] : (turns[n / 2 - 1] + turns[n / 2]) / 2,
    capRate: rows.filter((r) => r.capped === '1' || r.capped === 'true').length / n,
    challenger: { wins, rate: wins / n, interval95: interval(wins, n) },
    byPlayerId: [0, 1, 2].map((p) => ({
      playerId: p,
      ...seatRate(rows.filter((r) => Number(r.winner) === p).length),
    })),
    byTurnPosition: [0, 1, 2].map((p) => ({
      position: p,
      ...seatRate(rows.filter((r) => Number(r.winnerTurnPosition) === p).length),
    })),
  };
}
if (process.argv[1]?.endsWith('/measure.ts'))
  for (const path of process.argv.slice(2))
    process.stdout.write(JSON.stringify(await measureCsv(path)) + '\n');
