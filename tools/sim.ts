/** Run independent games in at most eight processes and preserve one auditable CSV row per game. */
import { availableParallelism } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { simulate, summarize, type GameResult } from './simulation.js';
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
if (args.includes('--worker')) {
  const start = Number(option('--start', '0')),
    count = Number(option('--games', '1')),
    seed = Number(option('--seed', '1'));
  const names = option('--bots', 'greedy,greedy,greedy').split(',');
  for (let i = start; i < start + count; i++)
    process.stdout.write(JSON.stringify(simulate(i, seed + i, names)) + '\n');
} else {
  const count = Number(option('--games', '100')),
    seed = Number(option('--seed', '1')),
    processes = Math.min(8, availableParallelism(), Number(option('--processes', '4')), count);
  const names = option('--bots', 'greedy,greedy,greedy');
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    !Number.isInteger(processes) ||
    processes < 1 ||
    !Number.isInteger(seed)
  )
    throw new Error('Expected positive integer games/processes and integer seed');
  const tasks = [];
  let start = 0;
  for (let p = 0; p < processes; p++) {
    const games = Math.floor(count / processes) + (p < count % processes ? 1 : 0);
    const offset = start;
    start += games;
    tasks.push(
      new Promise<GameResult[]>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '--import',
            'tsx',
            fileURLToPath(import.meta.url),
            '--worker',
            '--start',
            String(offset),
            '--games',
            String(games),
            '--seed',
            String(seed),
            '--bots',
            names,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let out = '',
          err = '';
        child.stdout.on('data', (b) => (out += b));
        child.stderr.on('data', (b) => (err += b));
        child.on('error', reject);
        child.on('close', (code) =>
          code
            ? reject(new Error(err || `Simulator exited ${code}`))
            : resolve(
                out
                  .trim()
                  .split('\n')
                  .filter(Boolean)
                  .map((line) => JSON.parse(line)),
              ),
        );
      }),
    );
  }
  const rows = (await Promise.all(tasks)).flat().sort((a, b) => a.game - b.game);
  await mkdir('runs', { recursive: true });
  const path = option('--out', `runs/sim-${Date.now()}.csv`);
  const csv =
    [
      'game,seed,turns,capped,winner,winningBot,seat0,seat1,seat2,seat3,renown0,renown1,renown2,renown3,actions,landAttempts,mapRestarts,winningTurnPosition,turnOrder',
      ...rows.map((r) =>
        [
          r.game,
          r.seed,
          r.turns,
          r.capped,
          r.winner,
          r.winningBot,
          ...Array.from({ length: 4 }, (_, p) => r.bots[p] ?? ''),
          ...Array.from({ length: 4 }, (_, p) => r.renown[p] ?? ''),
          r.actions,
          r.landAttempts,
          r.mapRestarts,
          r.turnOrder?.indexOf(r.winner) ?? '',
          r.turnOrder?.join('|') ?? '',
        ].join(','),
      ),
    ].join('\n') + '\n';
  await writeFile(path, csv);
  const summary = { ...summarize(rows), csv: path, processes };
  await writeFile(path.replace(/\.csv$/, '.json'), JSON.stringify(summary, null, 2) + '\n');
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}
