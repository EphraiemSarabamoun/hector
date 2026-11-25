/** Direct strength tuning in train-RMS coordinates, with common seeds and independent promotion gates. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextRandom, seedValue } from '../src/engine/index.js';
import { FEATURE_NAMES, FEATURE_SIGNS, projectWeights } from '../src/ai/features.js';
import { W0 } from '../src/ai/value.js';
import { tierByName, type SearchConfig } from '../src/ai/tiers.js';
import { interval } from './simulation.js';
import {
  playGame,
  partitions,
  runWorker,
  ensureParent,
  isMain,
  option,
  integerOption,
  readWeights,
  type Entrant,
} from './ai-common.js';

export const TUNE_POLICY = Object.freeze({
  candidates: 16,
  games: 120,
  elites: 4,
  gateEvery: 5,
  gateGames: 600,
  initialSigma: 0.15,
  failureShrink: 0.5,
  failedGateLimit: 2,
  maxMinutes: 90,
  finalReserveMinutes: 15,
  tuningBase: 2_000_000,
  gateBase: 4_000_000,
  finalBase: 6_000_000,
  seedStride: 1000,
  maxIterations: 2000,
});
export interface Model {
  id: string;
  weights: number[];
}
export interface Candidate extends Model {
  rms: number[];
  index: number;
}
export interface CompactGame {
  flat: number;
  candidate: number;
  game: number;
  seed: number;
  challengerSeat: number;
  winner: number;
  winnerTurnPosition: number;
  turnOrder: number[];
  turns: number;
  capped: boolean;
  completed: boolean;
  poolModel: string;
  incumbentSeat: number;
}
export interface EvaluationBatch {
  kind: 'iteration' | 'checkpoint' | 'final';
  index: number;
  candidates: Model[];
  incumbent: Model;
  pool: Model[];
  policy: SearchConfig;
  randomSeed: number;
  seedBase: number;
  games: number;
  processes: number;
  deadline: number;
}
export interface BatchResult {
  rows: CompactGame[];
  completed: boolean;
}
export interface TuneConfig {
  initial: Model;
  scales: number[];
  policy: SearchConfig;
  randomSeed: number;
  processes: number;
  out: string;
  minutes?: number;
  finalReserveMinutes?: number;
  maxIterations?: number;
  startedAt?: number;
  parentProvenance?: unknown;
  startGate?: unknown;
}
export interface TuneDependencies {
  now?: () => number;
  evaluate?: (batch: EvaluationBatch) => Promise<BatchResult>;
  saveBatch?: (batch: EvaluationBatch, result: BatchResult, summary: unknown) => Promise<void>;
  saveArtifact?: (artifact: unknown) => Promise<void>;
}
const sameWeights = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((w, i) => w === b[i]);
const copyModel = (model: Model): Model => ({ id: model.id, weights: [...model.weights] });

/** Reject anything except a train-only RMS scale for every feature. */
export function validateScales(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== FEATURE_NAMES.length ||
    Array.from(value).some((x) => typeof x !== 'number' || !Number.isFinite(x) || x <= 0)
  )
    throw new Error(`Expected ${FEATURE_NAMES.length} positive finite train-RMS scales`);
  return [...value];
}
/** An independent seeded Box-Muller stream; zero uniforms never enter log(0). */
export function gaussianStream(seed: number | string): () => number {
  const rng = { rng: seedValue(seed) };
  let spare: number | undefined;
  return () => {
    if (spare !== undefined) {
      const value = spare;
      spare = undefined;
      return value;
    }
    const radius = Math.sqrt(-2 * Math.log(1 - nextRandom(rng)));
    const angle = 2 * Math.PI * nextRandom(rng);
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
}
/** Perturb all offspring, project in natural coordinates, then retain exact RMS coordinates for averaging. */
export function sampleCandidates(
  mean: readonly number[],
  scales: readonly number[],
  sigma: number,
  seed: number | string,
): Candidate[] {
  validateScales(scales);
  if (
    mean.length !== scales.length ||
    mean.some((x) => !Number.isFinite(x)) ||
    !Number.isFinite(sigma) ||
    sigma < 0
  )
    throw new Error('Invalid mean or sigma');
  const gaussian = gaussianStream(seed);
  return Array.from({ length: TUNE_POLICY.candidates }, (_, index) => {
    const raw = mean.map((value, j) => (value + sigma * gaussian()) / scales[j]);
    const weights = projectWeights(raw);
    return {
      index,
      id: `candidate-${index}`,
      weights,
      rms: weights.map((value, j) => value * scales[j]),
    };
  });
}
/** Rank by measured win rate, use candidate index only for ties, and average the top four in RMS space. */
export function eliteMean(candidates: readonly Candidate[], fitness: readonly number[]): number[] {
  if (
    candidates.length !== TUNE_POLICY.candidates ||
    fitness.length !== candidates.length ||
    fitness.some((x) => !Number.isFinite(x))
  )
    throw new Error('Incomplete candidate fitness');
  const elite = [...candidates]
    .sort((a, b) => fitness[b.index] - fitness[a.index] || a.index - b.index)
    .slice(0, TUNE_POLICY.elites);
  return elite[0].rms.map(
    (_, j) => elite.reduce((sum, model) => sum + model.rms[j], 0) / elite.length,
  );
}
/** Keep tuning, checkpoint, and final seed windows disjoint even under a fast injected evaluator. */
export function seedBase(kind: EvaluationBatch['kind'], index: number): number {
  if (!Number.isSafeInteger(index) || index < 0 || index >= TUNE_POLICY.maxIterations)
    throw new Error('Invalid seed-range index');
  return kind === 'final'
    ? TUNE_POLICY.finalBase
    : (kind === 'iteration' ? TUNE_POLICY.tuningBase : TUNE_POLICY.gateBase) +
        index * TUNE_POLICY.seedStride;
}
/** All candidates get the same board/chance seeds, pool opponent, and balanced challenger player ID for each game. */
export function tuningMatch(batch: EvaluationBatch, flat: number) {
  const candidate = Math.floor(flat / batch.games),
    game = flat % batch.games,
    challengerSeat = game % 3;
  if (!Number.isSafeInteger(flat) || flat < 0 || candidate >= batch.candidates.length)
    throw new Error('Invalid flat tuning job');
  const rivals = [0, 1, 2].filter((p) => p !== challengerSeat);
  const incumbentSeat = rivals[game % rivals.length];
  const rng = { rng: seedValue(`${batch.randomSeed}:pool:${batch.index}:${game}`) };
  const pool =
    batch.kind === 'iteration'
      ? batch.pool[Math.floor(nextRandom(rng) * batch.pool.length)]
      : batch.incumbent;
  if (!pool) throw new Error('Empty opponent pool');
  const entrants: Entrant[] = Array.from({ length: 3 }, (_, p) => ({
    name: 'Aeneas',
    overrides: {
      ...batch.policy,
      timeLimitMs: 0,
      humanPlayers: [],
      weights: [
        ...(p === challengerSeat
          ? batch.candidates[candidate]
          : p === incumbentSeat
            ? batch.incumbent
            : pool
        ).weights,
      ],
    },
  }));
  return {
    candidate,
    game,
    seed: batch.seedBase + game,
    challengerSeat,
    incumbentSeat,
    poolModel: pool.id,
    entrants,
  };
}
/** Workers stop cooperatively; incomplete games retain their row but never contribute wins. */
export function evaluateSlice(
  batch: EvaluationBatch,
  start: number,
  count: number,
  now: () => number = Date.now,
): BatchResult {
  const rows: CompactGame[] = [];
  for (let flat = start; flat < start + count; flat++) {
    if (now() >= batch.deadline) break;
    const match = tuningMatch(batch, flat);
    const result = playGame(match.game, match.seed, match.entrants, undefined, batch.deadline);
    const completed = result.completed === true;
    rows.push({
      flat,
      candidate: match.candidate,
      game: match.game,
      seed: match.seed,
      challengerSeat: match.challengerSeat,
      incumbentSeat: match.incumbentSeat,
      poolModel: match.poolModel,
      winner: result.winner,
      winnerTurnPosition: result.winnerTurnPosition,
      turnOrder: result.turnOrder,
      turns: result.turns,
      capped: result.capped,
      completed,
    });
    if (!completed) break;
  }
  return { rows, completed: rows.length === count && rows.every((row) => row.completed) };
}
/** A single flat worker pool handles candidate-by-game indices; no nested candidate pools exist. */
export async function evaluateBatch(batch: EvaluationBatch): Promise<BatchResult> {
  const parts = partitions(batch.candidates.length * batch.games, batch.processes);
  const chunks = await Promise.all(
    parts.map((part) => runWorker<BatchResult>(fileURLToPath(import.meta.url), { batch, ...part })),
  );
  return {
    rows: chunks.flatMap((chunk) => chunk.rows).sort((a, b) => a.flat - b.flat),
    completed: chunks.every((chunk) => chunk.completed),
  };
}
/** Validate returned job identities before permitting either a fitness update or a promotion gate. */
export function batchSummary(batch: EvaluationBatch, result: BatchResult) {
  const seen = new Set<number>();
  for (const row of result.rows) {
    const match = tuningMatch(batch, row.flat);
    if (
      seen.has(row.flat) ||
      row.candidate !== match.candidate ||
      row.game !== match.game ||
      row.seed !== match.seed ||
      row.challengerSeat !== match.challengerSeat ||
      row.poolModel !== match.poolModel ||
      row.incumbentSeat !== match.incumbentSeat
    )
      throw new Error('Worker result does not match the fixed evaluation jobs');
    if (row.completed && (!Number.isInteger(row.winner) || row.winner < 0 || row.winner >= 3))
      throw new Error('Completed game lacks a valid winner');
    seen.add(row.flat);
  }
  const candidates = batch.candidates.map((model, index) => {
    const rows = result.rows.filter((row) => row.candidate === index && row.completed);
    const wins = rows.filter((row) => row.winner === row.challengerSeat).length;
    return {
      index,
      id: model.id,
      wins,
      games: rows.length,
      requested: batch.games,
      rate: rows.length ? wins / rows.length : 0,
      interval95: interval(wins, rows.length),
      complete: rows.length === batch.games,
    };
  });
  return {
    kind: batch.kind,
    index: batch.index,
    complete: result.completed && candidates.every((c) => c.complete),
    candidates,
  };
}
/** Checkpoint gates use point parity; the final independent W0 gate requires a Wilson lower bound above parity. */
export function gateAccepted(summary: ReturnType<typeof batchSummary>, final = false): boolean {
  const candidate = summary.candidates[0];
  return (
    summary.complete &&
    summary.candidates.length === 1 &&
    candidate.games === TUNE_POLICY.gateGames &&
    (final ? candidate.interval95[0] > 1 / 3 : candidate.rate > 1 / 3)
  );
}
/** Limit all output artifacts to runs; installing weights is a separate operation. */
export function outputPath(path: string): string {
  const target = resolve(path),
    root = resolve('runs');
  if (!target.startsWith(root + sep) || target === root)
    throw new Error('Tuning --out must be a file under runs/');
  return target;
}
/** Compact rows preserve raw winners and seeds without retaining per-decision timing arrays. */
async function saveBatch(
  base: string,
  batch: EvaluationBatch,
  result: BatchResult,
  summary: unknown,
): Promise<void> {
  const path = `${base.replace(/\.json$/, '')}.artifacts/${batch.kind}-${batch.index}`;
  await ensureParent(path);
  const keys = [
    'flat',
    'candidate',
    'game',
    'seed',
    'challengerSeat',
    'incumbentSeat',
    'poolModel',
    'winner',
    'winnerTurnPosition',
    'turnOrder',
    'turns',
    'capped',
    'completed',
  ] as const;
  const csv =
    [
      keys.join(','),
      ...result.rows.map((row) =>
        keys
          .map((key) => (Array.isArray(row[key]) ? (row[key] as number[]).join('|') : row[key]))
          .join(','),
      ),
    ].join('\n') + '\n';
  await writeFile(`${path}.csv`, csv);
  await writeFile(`${path}.json`, JSON.stringify({ batch, summary }, null, 2) + '\n');
}

/** Execute only bounded evaluation batches, keeping rejected/incomplete gates and explicit W0 fallback in provenance. */
export async function runTuning(config: TuneConfig, dependencies: TuneDependencies = {}) {
  const now = dependencies.now ?? Date.now,
    start = config.startedAt ?? now();
  const minutes = config.minutes ?? TUNE_POLICY.maxMinutes,
    reserve = config.finalReserveMinutes ?? TUNE_POLICY.finalReserveMinutes;
  const maxIterations = config.maxIterations ?? TUNE_POLICY.maxIterations;
  if (
    !Number.isFinite(minutes) ||
    minutes <= 0 ||
    minutes > TUNE_POLICY.maxMinutes ||
    !Number.isFinite(reserve) ||
    reserve < 0 ||
    reserve >= minutes
  )
    throw new Error('Invalid wall-clock or final-gate reserve');
  if (
    !Number.isSafeInteger(maxIterations) ||
    maxIterations < 0 ||
    maxIterations > TUNE_POLICY.maxIterations
  )
    throw new Error('Invalid iteration limit');
  partitions(1, config.processes);
  validateScales(config.scales);
  if (!sameWeights(projectWeights(config.initial.weights), config.initial.weights))
    throw new Error('Starting weights violate the shared sign constraints');
  if (!Number.isSafeInteger(config.randomSeed))
    throw new Error('Tuning RNG seed must be a safe integer');
  // Normal tuning uses deterministic node budgets; the optional browser cap stays off.
  const policy = JSON.parse(
    JSON.stringify({ ...config.policy, humanPlayers: [], timeLimitMs: 0 }),
  ) as SearchConfig;
  validateStartingGate(config.initial.weights, config.startGate, policy);
  const out = outputPath(config.out),
    deadline = start + minutes * 60000;
  const evaluate = dependencies.evaluate ?? evaluateBatch;
  const save =
    dependencies.saveBatch ?? ((batch, result, summary) => saveBatch(out, batch, result, summary));
  let accepted = copyModel(config.initial),
    mean = accepted.weights.map((w, j) => w * config.scales[j]),
    sigma = TUNE_POLICY.initialSigma;
  let failures = 0,
    gateIndex = 0,
    gateReserve = reserve * 60000,
    stopReason = 'iteration limit';
  const baseline: Model = { id: 'w0', weights: [...W0] };
  const pool: Model[] = [copyModel(baseline)];
  if (!sameWeights(accepted.weights, W0)) pool.push(copyModel(accepted));
  const iterations: unknown[] = [],
    gates: unknown[] = [],
    ranges: unknown[] = [];
  const perform = async (batch: EvaluationBatch) => {
    const result = await evaluate(batch),
      summary = batchSummary(batch, result);
    ranges.push({
      kind: batch.kind,
      index: batch.index,
      start: batch.seedBase,
      endExclusive: batch.seedBase + batch.games,
      candidates: batch.candidates.length,
      commonSeedsAcrossCandidates: batch.kind === 'iteration',
    });
    await save(batch, result, summary);
    process.stderr.write(
      `tune ${batch.kind} ${batch.index}: ${summary.complete ? 'complete' : 'incomplete'}; ` +
        summary.candidates.map((candidate) => `${candidate.wins}/${candidate.games}`).join(' ') +
        '\n',
    );
    return summary;
  };
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (now() >= deadline - gateReserve) {
      stopReason = 'final-gate reserve';
      break;
    }
    const candidates = sampleCandidates(
      mean,
      config.scales,
      sigma,
      `${config.randomSeed}:offspring:${iteration}`,
    );
    candidates.forEach(
      (candidate) => (candidate.id = `iteration-${iteration}-candidate-${candidate.index}`),
    );
    const incumbent: Model = {
      id: `mean-before-${iteration}`,
      weights: mean.map((w, j) => w / config.scales[j]),
    };
    const batch: EvaluationBatch = {
      kind: 'iteration',
      index: iteration,
      candidates,
      incumbent,
      pool: pool.map(copyModel),
      policy,
      randomSeed: config.randomSeed,
      seedBase: seedBase('iteration', iteration),
      games: TUNE_POLICY.games,
      processes: config.processes,
      deadline: deadline - gateReserve,
    };
    const summary = await perform(batch);
    iterations.push({ iteration, sigma, incumbent, candidates, summary });
    if (!summary.complete) {
      stopReason = 'incomplete iteration';
      break;
    }
    mean = eliteMean(
      candidates,
      summary.candidates.map((c) => c.rate),
    );
    if ((iteration + 1) % TUNE_POLICY.gateEvery !== 0) continue;
    if (now() >= deadline - gateReserve) {
      stopReason = 'final-gate reserve before checkpoint';
      break;
    }
    const proposed: Model = {
      id: `checkpoint-${gateIndex}`,
      weights: projectWeights(mean.map((w, j) => w / config.scales[j])),
    };
    const gateStart = now();
    const gateBatch: EvaluationBatch = {
      kind: 'checkpoint',
      index: gateIndex,
      candidates: [proposed],
      incumbent: copyModel(accepted),
      pool: [],
      policy,
      randomSeed: config.randomSeed,
      seedBase: seedBase('checkpoint', gateIndex),
      games: TUNE_POLICY.gateGames,
      processes: config.processes,
      deadline: deadline - gateReserve,
    };
    const gate = await perform(gateBatch),
      pass = gateAccepted(gate);
    gates.push({
      index: gateIndex,
      against: copyModel(accepted),
      candidate: proposed,
      accepted: pass,
      summary: gate,
      sigma,
    });
    gateIndex++;
    gateReserve = Math.max(gateReserve, (now() - gateStart) * 1.25);
    if (pass) {
      accepted = copyModel(proposed);
      pool.push(copyModel(accepted));
      failures = 0;
    } else {
      mean = accepted.weights.map((w, j) => w * config.scales[j]);
      if (!gate.complete) {
        stopReason = 'incomplete checkpoint gate';
        break;
      }
      sigma *= TUNE_POLICY.failureShrink;
      failures++;
    }
    if (failures >= TUNE_POLICY.failedGateLimit) {
      stopReason = 'two consecutive failed checkpoint gates';
      break;
    }
  }
  let finalGate: unknown = { accepted: false, reason: 'last accepted checkpoint is W0' },
    ship = copyModel(baseline),
    fallback = true;
  if (!sameWeights(accepted.weights, W0)) {
    const batch: EvaluationBatch = {
      kind: 'final',
      index: 0,
      candidates: [copyModel(accepted)],
      incumbent: copyModel(baseline),
      pool: [],
      policy,
      randomSeed: config.randomSeed,
      seedBase: seedBase('final', 0),
      games: TUNE_POLICY.gateGames,
      processes: config.processes,
      deadline,
    };
    const summary = await perform(batch),
      pass = gateAccepted(summary, true);
    finalGate = { against: baseline, candidate: copyModel(accepted), accepted: pass, summary };
    if (pass) {
      ship = copyModel(accepted);
      fallback = false;
    }
  }
  const artifact = {
    id: fallback ? 'w0-fallback' : `tuned-${accepted.id}`,
    featureNames: FEATURE_NAMES,
    weights: ship.weights,
    provenance: {
      method: 'cross-entropy direct win-rate search in train-RMS coordinates',
      date: new Date(start).toISOString(),
      startedAt: start,
      finishedAt: now(),
      elapsedMilliseconds: now() - start,
      deadline,
      minutes,
      finalReserveMinutes: reserve,
      stopReason,
      fallback,
      lastAccepted: accepted,
      finalGate,
      iterations,
      gates,
      seedRanges: ranges,
      reservedSeedWindows: {
        tuning: [TUNE_POLICY.tuningBase, TUNE_POLICY.gateBase],
        checkpoint: [TUNE_POLICY.gateBase, TUNE_POLICY.finalBase],
        final: [TUNE_POLICY.finalBase, TUNE_POLICY.finalBase + TUNE_POLICY.gateGames],
      },
      randomSeed: config.randomSeed,
      processes: config.processes,
      policy: TUNE_POLICY,
      configuration: policy,
      scales: [...config.scales],
      projection: { featureNames: FEATURE_NAMES, signs: FEATURE_SIGNS },
      parent: config.parentProvenance ?? null,
      shipping: 'Saved under runs only; installing weights is a separate operation.',
    },
  };
  if (dependencies.saveArtifact) await dependencies.saveArtifact(artifact);
  else {
    await ensureParent(out);
    await writeFile(out, JSON.stringify(artifact, null, 2) + '\n');
  }
  return artifact;
}

const POLICY_FIELDS = [
  'engine',
  'budget',
  'noise',
  'randomMove',
  'eps',
  'delta',
  'openingTopK',
  'lookahead',
  'setupBudget',
  'timeLimitMs',
  'activeTrading',
  'tradeProposals',
  'humanPlayers',
] as const;
/** Verify initial-fit promotion using actual weights and an independently recomputed 600-game Wilson result. */
export function validateStartingGate(
  weights: readonly number[],
  summary: any,
  policy: SearchConfig,
): void {
  if (sameWeights(weights, W0)) return;
  const report = summary?.challenger;
  if (
    summary?.games !== TUNE_POLICY.gateGames ||
    report?.games !== TUNE_POLICY.gateGames ||
    !Number.isInteger(report.wins) ||
    report.wins < 0 ||
    report.wins > report.games ||
    interval(report.wins, report.games)[0] <= 1 / 3
  )
    throw new Error('Non-W0 start requires a passing fresh 600-game W0 gate');
  const resolved = summary.resolvedConfigurations;
  const canonical = (config: SearchConfig) =>
    JSON.stringify(
      POLICY_FIELDS.map(
        (key) =>
          config[key] ??
          (
            {
              setupBudget: 0,
              timeLimitMs: 0,
              activeTrading: false,
              tradeProposals: 2,
              humanPlayers: [],
            } as Record<string, unknown>
          )[key],
      ),
    );
  for (const [role, expected] of [
    ['challenger', weights],
    ['opponent', W0],
  ] as const) {
    const entry = resolved?.[role];
    if (
      entry?.name?.toLowerCase() !== 'aeneas' ||
      !entry.config ||
      !sameWeights(entry.config.weights ?? [], expected) ||
      canonical(entry.config) !== canonical(policy)
    )
      throw new Error('Starting gate resolved weights/configuration do not match Aeneas versus W0');
  }
  if (summary.config?.humanChallenger)
    throw new Error('Starting gate must use symmetric bot-only context');
}

async function main(): Promise<void> {
  const startedAt = Date.now(),
    args = process.argv.slice(2),
    worker = option(args, '--worker-config');
  if (worker) {
    const input = JSON.parse(worker);
    process.stdout.write(JSON.stringify(evaluateSlice(input.batch, input.start, input.games)));
    return;
  }
  const weightsPath = option(args, '--weights'),
    scalesPath = option(args, '--scales-from'),
    out = option(args, '--out');
  if (!weightsPath || !scalesPath || !out)
    throw new Error('Required: --weights, --scales-from, --out runs/<artifact>.json');
  outputPath(out);
  const initialWeights = await readWeights(weightsPath),
    raw = JSON.parse(await readFile(weightsPath, 'utf8'));
  const scaleArtifact = JSON.parse(await readFile(scalesPath, 'utf8')),
    scales = validateScales(scaleArtifact.provenance?.scales);
  const policy = { ...tierByName('Aeneas'), humanPlayers: [], timeLimitMs: 0, weights: [...W0] };
  let startGate: unknown = null;
  if (!sameWeights(initialWeights, W0)) {
    const path = option(args, '--start-gate');
    if (!path) throw new Error('Non-W0 start requires --start-gate');
    startGate = JSON.parse(await readFile(path, 'utf8'));
    validateStartingGate(initialWeights, startGate, policy);
  }
  const result = await runTuning({
    initial: { id: raw.id ?? 'starting-model', weights: initialWeights },
    scales,
    policy,
    randomSeed: integerOption(args, '--seed', 271828),
    processes: integerOption(args, '--processes', 1),
    out,
    minutes: Number(option(args, '--minutes', '90')),
    finalReserveMinutes: Number(option(args, '--final-reserve-minutes', '15')),
    maxIterations: integerOption(args, '--max-iterations', TUNE_POLICY.maxIterations),
    startedAt,
    startGate,
    parentProvenance: {
      weightsPath,
      startingArtifact: raw,
      scalesPath,
      scaleProvenance: scaleArtifact.provenance,
      startGate,
    },
  });
  process.stdout.write(
    JSON.stringify({
      id: result.id,
      out,
      fallback: result.provenance.fallback,
      stopReason: result.provenance.stopReason,
      finalGate: result.provenance.finalGate,
    }) + '\n',
  );
}
if (isMain(import.meta.url))
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
