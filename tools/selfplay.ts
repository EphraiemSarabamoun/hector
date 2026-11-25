/** Bounded streaming self-play: all player feature matrices at every pre-roll turn start. */
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile, stat, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allFeatures, FEATURE_NAMES } from '../src/ai/features.js';
import { W0 } from '../src/ai/value.js';
import { tierByName } from '../src/ai/tiers.js';
import {
  type Entrant,
  playGame,
  partitions,
  runWorker,
  writeLine,
  finishStream,
  option,
  integerOption,
  isMain,
  readWeights,
  resolvedEntrant,
} from './ai-common.js';
export interface TrainingPosition {
  game: number;
  seed: number;
  turn: number;
  winner: number;
  features: number[][];
}
export interface SelfplayPolicy {
  activeTrading: boolean;
  tradeProposals: number;
  delta: number;
  eps: number;
}
/** Historical Paris-based generations did not record policy explicitly; keep their actual defaults fixed. */
export const LEGACY_SELFPLAY_POLICY: Readonly<SelfplayPolicy> = Object.freeze({
  activeTrading: false,
  tradeProposals: 2,
  delta: 0.06,
  eps: 0,
});
/** Canonical numeric/boolean policy values make absent and explicit defaults compare consistently. */
export function normalizeSelfplayPolicy(
  policy: unknown,
  defaults: Readonly<SelfplayPolicy>,
): SelfplayPolicy {
  if (policy !== undefined && (!policy || typeof policy !== 'object' || Array.isArray(policy)))
    throw new Error('Invalid self-play policy');
  const overrides = (policy ?? {}) as Partial<SelfplayPolicy>;
  if (
    Object.keys(overrides).some(
      (key) => !['activeTrading', 'tradeProposals', 'delta', 'eps'].includes(key),
    )
  )
    throw new Error('Unknown self-play policy setting');
  const resolved = {
    ...defaults,
    ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)),
  };
  if (
    typeof resolved.activeTrading !== 'boolean' ||
    !Number.isSafeInteger(resolved.tradeProposals) ||
    resolved.tradeProposals < 1 ||
    resolved.tradeProposals > 4 ||
    !Number.isFinite(resolved.delta) ||
    resolved.delta < 0 ||
    !Number.isFinite(resolved.eps) ||
    resolved.eps < 0
  )
    throw new Error('Invalid self-play policy');
  return {
    activeTrading: resolved.activeTrading,
    tradeProposals: resolved.tradeProposals,
    delta: resolved.delta,
    eps: resolved.eps,
  };
}
export interface SelfplayConfig {
  games: number;
  seed: number;
  processes: number;
  out: string;
  generation: number;
  budget: number;
  weights: readonly number[];
  maxBytes?: number;
  start?: number;
  policy?: Partial<SelfplayPolicy>;
  /** Historical tool calls keep Paris; final-policy collection explicitly selects Aeneas. */
  tier?: string;
}
/** Resolve policy overrides against the selected tier before spawning or recording workers. */
export function resolvedSelfplayPolicy(config: Partial<SelfplayConfig>): SelfplayPolicy {
  const tier = tierByName(config.tier ?? 'Paris');
  return normalizeSelfplayPolicy(config.policy, {
    activeTrading: tier.activeTrading ?? false,
    tradeProposals: tier.tradeProposals ?? 2,
    delta: tier.delta,
    eps: tier.eps,
  });
}
/** The selected tier supplies normal play; exploration and all-bot human lists remain explicit. */
export function selfplayEntrants(
  config: Pick<SelfplayConfig, 'weights' | 'budget' | 'policy' | 'tier'>,
): Entrant[] {
  const policy = resolvedSelfplayPolicy(config);
  return Array.from({ length: 3 }, () => ({
    name: tierByName(config.tier ?? 'Paris').name,
    overrides: {
      ...policy,
      weights: config.weights,
      noise: 0.06,
      budget: config.budget,
      openingTopK: 5,
      humanPlayers: [],
    },
  }));
}
/** Serialize the same entrants used by workers, with stable player IDs and no private streams. */
export function selfplayResolvedConfigurations(
  config: Pick<SelfplayConfig, 'weights' | 'budget' | 'policy' | 'tier'>,
) {
  return selfplayEntrants(config).map((entrant, playerId) => ({
    playerId,
    ...resolvedEntrant(entrant),
  }));
}
/** Self-play CLI policy flags mirror arena suffixes without the challenger/opponent prefix. */
export function selfplayPolicyOptions(args: string[]): Partial<SelfplayPolicy> {
  const policy: Partial<SelfplayPolicy> = {};
  for (const field of ['activeTrading', 'tradeProposals', 'delta', 'eps'] as const) {
    const flag = `--${field === 'activeTrading' ? 'active-trading' : field === 'tradeProposals' ? 'trade-proposals' : field}`;
    if (!args.includes(flag)) continue;
    const raw = option(args, flag);
    if (raw === undefined) throw new Error(`Missing value for ${flag}`);
    if (field === 'activeTrading') {
      if (raw !== 'true' && raw !== 'false')
        throw new Error('Active trading must be true or false');
      policy.activeTrading = raw === 'true';
    } else policy[field] = Number(raw);
  }
  normalizeSelfplayPolicy(policy, LEGACY_SELFPLAY_POLICY);
  return policy;
}
interface WorkerConfig extends SelfplayConfig {
  start: number;
  file: string;
  byteLimit: number;
}
/** Count only raw JSONL files; generation metadata and fitted model artifacts do not use the raw allowance. */
export async function rawDirectoryBytes(directory: string): Promise<number> {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.jsonl'));
  return (
    await Promise.all(names.map(async (name) => (await stat(join(directory, name))).size))
  ).reduce((sum, size) => sum + size, 0);
}
/** Check each prospective game batch, including this worker's buffered bytes not visible to stat yet.
 * Concurrent workers can write between checks; without a directory lock their outstanding game
 * batches remain a bounded race. The invocation also divides its initial remaining allowance.
 */
export async function checkRawBudget(
  directory: string,
  limit: number,
  ownFile: string,
  ownBytes: number,
  prospectiveBytes: number,
): Promise<void> {
  const current = await rawDirectoryBytes(directory);
  let ownDiskBytes = 0;
  try {
    ownDiskBytes = (await stat(ownFile)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (current + Math.max(0, ownBytes - ownDiskBytes) + prospectiveBytes > limit)
    throw new Error(
      'Combined self-play raw data would exceed the configured generation byte limit',
    );
}
/** Hold only one game's positions until its winner is known, then flush with backpressure. */
export async function selfplayWorker(config: WorkerConfig) {
  const stream = createWriteStream(config.file, { flags: 'wx' });
  let bytes = 0,
    positions = 0,
    turns = 0,
    caps = 0;
  const entrants = selfplayEntrants(config);
  const resolvedConfigurations = selfplayResolvedConfigurations(config);
  try {
    for (let game = config.start; game < config.start + config.games; game++) {
      const seed = config.seed + game;
      const samples: Omit<TrainingPosition, 'winner'>[] = [];
      const result = playGame(game, seed, entrants, (board, state) => {
        samples.push({ game, seed, turn: state.turn, features: allFeatures(board, state) });
      });
      const lines = samples.map((sample) => JSON.stringify({ ...sample, winner: result.winner }));
      const batchBytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line + '\n'), 0);
      if (bytes + batchBytes > config.byteLimit)
        throw new Error(
          'Self-play raw data would exceed the remaining worker generation allowance',
        );
      await checkRawBudget(
        dirname(config.file),
        Math.min(config.maxBytes ?? 1_800_000_000, 1_800_000_000),
        config.file,
        bytes,
        batchBytes,
      );
      for (const line of lines) {
        bytes += Buffer.byteLength(line + '\n');
        await writeLine(stream, line);
        positions++;
      }
      turns += result.turns;
      caps += Number(result.capped);
      if ((game - config.start + 1) % 100 === 0)
        process.stderr.write(
          `selfplay worker ${config.start}: ${game - config.start + 1}/${config.games}, ${bytes} bytes\n`,
        );
    }
    await finishStream(stream);
  } catch (error) {
    stream.destroy();
    throw error;
  }
  return {
    file: config.file,
    start: config.start,
    games: config.games,
    firstSeed: config.seed + config.start,
    lastSeed: config.seed + config.start + config.games - 1,
    positions,
    bytes,
    meanTurns: turns / config.games,
    caps,
    resolvedConfigurations,
  };
}
/** A generation is written to independent worker files; prior generations are never removed implicitly.
 * Append with --start N using unchanged seed/generation/budget/weights: game IDs start at N,
 * seeds remain base + game ID, and metadata-N.json preserves the extra chunk. Fitting reads
 * every metadata chunk and rejects overlaps. Existing raw files share the directory byte cap.
 */
export async function runSelfplay(config: SelfplayConfig) {
  if (
    !Number.isInteger(config.budget) ||
    config.budget < 1 ||
    !Number.isInteger(config.generation) ||
    config.generation < 0 ||
    !Number.isSafeInteger(config.start ?? 0) ||
    (config.start ?? 0) < 0 ||
    config.weights.length !== FEATURE_NAMES.length ||
    config.weights.some((x) => !Number.isFinite(x))
  )
    throw new Error('Invalid self-play configuration');
  const resolvedConfigurations = selfplayResolvedConfigurations(config);
  const policy = resolvedSelfplayPolicy(config);
  const parts = partitions(config.games, config.processes);
  if (!Number.isSafeInteger(config.seed)) throw new Error('Seed must be an integer');
  const maxBytes = Math.min(config.maxBytes ?? 1_800_000_000, 1_800_000_000);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid raw byte limit');
  await mkdir(config.out, { recursive: true });
  const existingBytes = await rawDirectoryBytes(config.out);
  if (existingBytes >= maxBytes)
    throw new Error('Combined self-play raw data already reaches the generation byte limit');
  const workers = await Promise.all(
    parts.map((part) =>
      runWorker<Awaited<ReturnType<typeof selfplayWorker>>>(fileURLToPath(import.meta.url), {
        ...config,
        ...part,
        start: part.start + (config.start ?? 0),
        file: resolve(join(config.out, `positions-${part.start + (config.start ?? 0)}.jsonl`)),
        maxBytes,
        byteLimit: Math.floor((maxBytes - existingBytes) / parts.length),
      }),
    ),
  );
  const bytes = (await Promise.all(workers.map(async (w) => (await stat(w.file)).size))).reduce(
    (a, b) => a + b,
    0,
  );
  if (
    workers.some(
      (worker) =>
        JSON.stringify(worker.resolvedConfigurations) !== JSON.stringify(resolvedConfigurations),
    )
  )
    throw new Error('Self-play worker policies differ from the recorded configuration');
  const metadata = {
    ...config,
    tier: tierByName(config.tier ?? 'Paris').name,
    policy,
    resolvedConfigurations,
    featureNames: FEATURE_NAMES,
    date: new Date().toISOString(),
    seedRule: 'seed = base seed + game ID; bot seed = `${seed}:bot:${playerID}`',
    sampling:
      'one full player feature matrix per turn at phase roll before dice; winner added after game completion',
    workers,
    positions: workers.reduce((sum, w) => sum + w.positions, 0),
    bytes,
    existingRawBytesAtStart: existingBytes,
    generationRawByteLimit: maxBytes,
    concurrentByteLimitCaveat:
      'Each worker checks before flushing a game batch; simultaneous invocations can race between checks by their outstanding game batches. No directory lock is used.',
  };
  await writeFile(
    join(config.out, (config.start ?? 0) ? `metadata-${config.start}.json` : 'metadata.json'),
    JSON.stringify(metadata, null, 2) + '\n',
  );
  return metadata;
}
async function main() {
  const args = process.argv.slice(2),
    worker = option(args, '--worker-config');
  if (worker) {
    process.stdout.write(JSON.stringify(await selfplayWorker(JSON.parse(worker))));
    return;
  }
  const weightsPath = option(args, '--weights');
  const generation = integerOption(args, '--generation', 0);
  const metadata = await runSelfplay({
    games: integerOption(args, '--games', 5000),
    seed: integerOption(args, '--seed', 30000),
    processes: integerOption(args, '--processes', 1),
    generation,
    tier: option(args, '--tier', 'Paris'),
    start: integerOption(args, '--start', 0),
    budget: integerOption(args, '--budget', 24),
    weights: weightsPath ? await readWeights(weightsPath) : W0,
    out: option(args, '--out', `runs/generation-${generation}`)!,
    policy: selfplayPolicyOptions(args),
  });
  process.stdout.write(JSON.stringify(metadata, null, 2) + '\n');
}
if (isMain(import.meta.url))
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
