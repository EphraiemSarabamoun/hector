/** Auditable one-against-two tournaments with independent seeds and exact timing samples. */
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { interval } from './simulation.js';
import {
  type Entrant,
  type PlayedGame,
  playGame,
  partitions,
  runWorker,
  timingSummary,
  percentile,
  option,
  integerOption,
  entrantOptions,
  ensureParent,
  isMain,
  resolvedEntrant,
} from './ai-common.js';
export interface ArenaConfig {
  games: number;
  seed: number;
  challenger: Entrant;
  opponent: Entrant;
  processes?: number;
  out?: string;
  /** Apply the same single-human offer context to a proxy and its matched plain challenger. */
  humanChallenger?: boolean;
}
export interface ArenaRow extends PlayedGame {
  challengerSeat: number;
  challengerTurnPosition: number;
  challengerWin: boolean;
}
/** Unique game seeds support Wilson intervals; rotate the challenger evenly through player IDs. */
export function arenaGame(
  game: number,
  config: Pick<ArenaConfig, 'seed' | 'challenger' | 'opponent' | 'humanChallenger'>,
): ArenaRow {
  const challengerSeat = game % 3;
  const row = playGame(game, config.seed + game, arenaEntrants(game, config));
  return {
    ...row,
    challengerSeat,
    challengerTurnPosition: row.turnOrder.indexOf(challengerSeat),
    challengerWin: row.winner === challengerSeat,
  };
}
/** Match the human context by rotating the challenger ID, independent of which controller plays it. */
export function arenaEntrants(
  game: number,
  config: Pick<ArenaConfig, 'challenger' | 'opponent' | 'humanChallenger'>,
): Entrant[] {
  const challengerSeat = game % 3;
  return Array.from({ length: 3 }, (_, player) => {
    const entrant = player === challengerSeat ? config.challenger : config.opponent;
    const humans = [...(entrant.overrides?.humanPlayers ?? [])];
    if (config.humanChallenger && player !== challengerSeat && !humans.includes(challengerSeat))
      humans.push(challengerSeat);
    return { ...entrant, overrides: { ...entrant.overrides, humanPlayers: humans } };
  });
}
export function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function rate(wins: number, games: number) {
  return { wins, games, rate: games ? wins / games : 0, interval95: interval(wins, games) };
}
/** Report stable player IDs separately from randomized turn order; timings are bot decision wall time. */
export function summarizeArena(rows: readonly ArenaRow[]) {
  const games = rows.length,
    wins = rows.filter((r) => r.challengerWin).length;
  const decisions = rows.flatMap((r) => r.decisionMsByPlayer[r.challengerSeat]);
  const turns = rows.flatMap((r) => r.turnMsByPlayer[r.challengerSeat]);
  return {
    games,
    challenger: rate(wins, games),
    meanTurns: games ? rows.reduce((sum, r) => sum + r.turns, 0) / games : 0,
    medianTurns: median(rows.map((r) => r.turns)),
    capRate: games ? rows.filter((r) => r.capped).length / games : 0,
    byPlayerId: [0, 1, 2].map((p) => ({
      playerId: p,
      ...rate(rows.filter((r) => r.winner === p).length, games),
    })),
    byTurnOrder: [0, 1, 2].map((p) => ({
      turnPosition: p,
      ...rate(rows.filter((r) => r.winnerTurnPosition === p).length, games),
    })),
    challengerByPlayerId: [0, 1, 2].map((p) => {
      const sample = rows.filter((r) => r.challengerSeat === p);
      return { playerId: p, ...rate(sample.filter((r) => r.challengerWin).length, sample.length) };
    }),
    challengerByTurnOrder: [0, 1, 2].map((p) => {
      const sample = rows.filter((r) => r.challengerTurnPosition === p);
      return {
        turnPosition: p,
        ...rate(sample.filter((r) => r.challengerWin).length, sample.length),
      };
    }),
    timings: {
      units: 'milliseconds',
      definition:
        'chooseAction wall time in Node; turn totals include all decisions during that active turn, including other players responding; setup is included in decision timings and excluded from turn timings',
      decision: timingSummary(decisions),
      turn: timingSummary(turns),
      allDecision: timingSummary(rows.flatMap((r) => r.decisionMs)),
      allTurn: timingSummary(rows.flatMap((r) => r.turnMs)),
    },
    design: {
      rotation: 'challenger player ID = game % 3',
      seed: 'base seed + game',
      pairing:
        'Every game uses an independent seed. Challenger player IDs rotate evenly; turn-order counts are measured, not forced.',
      intervalMethod: 'Wilson 95% over independently seeded games.',
      equalPlayerIdCoverage: games % 3 === 0,
    },
  };
}
/** Keep at most ten CPU workers; result ordering and game assignment do not depend on worker count. */
export async function runArena(config: ArenaConfig) {
  if (!Number.isSafeInteger(config.seed)) throw new Error('Seed must be an integer');
  const parts = partitions(config.games, config.processes ?? 1);
  const chunks = await Promise.all(
    parts.map((part) =>
      runWorker<ArenaRow[]>(fileURLToPath(import.meta.url), { ...config, out: undefined, ...part }),
    ),
  );
  const rows = chunks.flat().sort((a, b) => a.game - b.game);
  const summary = {
    ...summarizeArena(rows),
    resolvedConfigurations: {
      challenger: resolvedEntrant(config.challenger),
      opponent: resolvedEntrant(config.opponent),
      byChallengerSeat: [0, 1, 2].map((seat) => ({
        challengerSeat: seat,
        players: arenaEntrants(seat, config).map(resolvedEntrant),
      })),
    },
    config,
    processes: parts.length,
    date: new Date().toISOString(),
  };
  if (config.out) {
    const path = config.out.endsWith('.csv') ? config.out : `${config.out}.csv`;
    await ensureParent(path);
    const headers = [
      'game',
      'seed',
      'challengerSeat',
      'challengerTurnPosition',
      'winner',
      'winnerTurnPosition',
      'challengerWin',
      'turns',
      'capped',
      'actions',
      'turnOrder',
      'bots',
      'renown',
      'challengerDecisionMedianMs',
      'challengerDecisionP95Ms',
      'challengerTurnMedianMs',
      'challengerTurnP95Ms',
    ];
    const escape = (x: unknown) =>
      '"' + (typeof x === 'object' ? JSON.stringify(x) : String(x)).replaceAll('"', '""') + '"';
    const csv =
      [
        headers.join(','),
        ...rows.map((r) =>
          [
            r.game,
            r.seed,
            r.challengerSeat,
            r.challengerTurnPosition,
            r.winner,
            r.winnerTurnPosition,
            Number(r.challengerWin),
            r.turns,
            Number(r.capped),
            r.actions,
            r.turnOrder,
            r.bots,
            r.renown,
            percentile(r.decisionMsByPlayer[r.challengerSeat], 0.5),
            percentile(r.decisionMsByPlayer[r.challengerSeat], 0.95),
            percentile(r.turnMsByPlayer[r.challengerSeat], 0.5),
            percentile(r.turnMsByPlayer[r.challengerSeat], 0.95),
          ]
            .map(escape)
            .join(','),
        ),
      ].join('\n') + '\n';
    await writeFile(path, csv);
    await writeFile(path.replace(/\.csv$/, '.json'), JSON.stringify(summary, null, 2) + '\n');
    await writeFile(
      path.replace(/\.csv$/, '.timings.json'),
      JSON.stringify({
        units: 'milliseconds',
        decisions: rows.flatMap((r) => r.decisionMsByPlayer[r.challengerSeat]),
        turns: rows.flatMap((r) => r.turnMsByPlayer[r.challengerSeat]),
      }) + '\n',
    );
  }
  return { rows, summary };
}
async function main() {
  const args = process.argv.slice(2),
    worker = option(args, '--worker-config');
  if (worker) {
    const config = JSON.parse(worker) as ArenaConfig & { start: number };
    const rows: ArenaRow[] = [];
    for (let game = config.start; game < config.start + config.games; game++) {
      rows.push(arenaGame(game, config));
      if ((game - config.start + 1) % 10 === 0)
        process.stderr.write(
          `arena worker ${config.start}: ${game - config.start + 1}/${config.games}\n`,
        );
    }
    process.stdout.write(JSON.stringify(rows));
    return;
  }
  const human = option(args, '--human-challenger', 'false')!;
  if (!['true', 'false'].includes(human)) throw new Error('Human challenger must be true or false');
  const result = await runArena({
    games: integerOption(args, '--games', 600),
    seed: integerOption(args, '--seed', 40000),
    processes: integerOption(args, '--processes', 1),
    challenger: {
      name: option(args, '--challenger', 'Hector')!,
      overrides: await entrantOptions(args, 'challenger'),
      normalBase: option(args, '--trader-base', 'Aeneas'),
    },
    opponent: {
      name: option(args, '--opponent', 'Aeneas')!,
      overrides: await entrantOptions(args, 'opponent'),
    },
    out: option(args, '--out', `runs/arena-${Date.now()}.csv`),
    humanChallenger: human === 'true',
  });
  process.stdout.write(JSON.stringify(result.summary, null, 2) + '\n');
}
if (isMain(import.meta.url))
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
