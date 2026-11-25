/** CPU-only shared-vector softmax fitting with streaming game-level held-out evaluation. */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { FEATURE_NAMES, FEATURE_SIGNS, type FeatureSign } from '../src/ai/features.js';
import { W0 } from '../src/ai/value.js';
import type { SearchConfig } from '../src/ai/types.js';
import {
  LEGACY_SELFPLAY_POLICY,
  normalizeSelfplayPolicy,
  resolvedSelfplayPolicy,
  type TrainingPosition,
} from './selfplay.js';
import { option, integerOption, ensureParent, isMain, readWeights } from './ai-common.js';
/** Stable unsigned game hash; sorting uses game IDs to break the rare 32-bit collision. */
function gameHash(game: number): number {
  let hash = (game ^ 0x9e3779b9) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x21f0aaad);
  hash = Math.imul(hash ^ (hash >>> 15), 0x735a2d97);
  return (hash ^ (hash >>> 15)) >>> 0;
}
/** Legacy approximate split helper; actual fitting uses the explicit exact-size partition below. */
export function isHeldOut(game: number): boolean {
  return gameHash(game) % 10 === 0;
}
/** Hold out floor(10% of unique games), with one held-out game whenever two or more exist. */
export function heldOutGameIds(gameIds: Iterable<number>): number[] {
  const unique = [...new Set(gameIds)];
  if (unique.some((game) => !Number.isSafeInteger(game))) throw new Error('Invalid game ID');
  const count = unique.length < 2 ? 0 : Math.max(1, Math.floor(unique.length * 0.1));
  return unique.sort((a, b) => gameHash(a) - gameHash(b) || a - b).slice(0, count);
}
/** Stable multinomial loss and exact derivative for one shared vector across all players. */
export function lossGradient(
  matrix: readonly (readonly number[])[],
  winner: number,
  weights: readonly number[],
) {
  if (!matrix.length || winner < 0 || winner >= matrix.length || !Number.isInteger(winner))
    throw new Error('Invalid winner or empty player matrix');
  if (matrix.some((row) => row.length !== weights.length))
    throw new Error('Feature/weight dimension mismatch');
  const logits = matrix.map((row) => row.reduce((sum, x, j) => sum + x * weights[j], 0));
  const max = Math.max(...logits),
    exponentials = logits.map((x) => Math.exp(x - max));
  const denominator = exponentials.reduce((a, b) => a + b, 0);
  const probabilities = exponentials.map((x) => x / denominator);
  const gradient = weights.map((_, j) =>
    matrix.reduce((sum, row, p) => sum + (probabilities[p] - Number(p === winner)) * row[j], 0),
  );
  return { loss: max + Math.log(denominator) - logits[winner], gradient, probabilities };
}
export interface CalibrationBin {
  lo: number;
  hi: number;
  count: number;
  predictedSum: number;
  actualSum: number;
  predicted: number;
  actual: number;
}
export function emptyCalibration(): CalibrationBin[] {
  return Array.from({ length: 10 }, (_, i) => ({
    lo: i / 10,
    hi: (i + 1) / 10,
    count: 0,
    predictedSum: 0,
    actualSum: 0,
    predicted: 0,
    actual: 0,
  }));
}
/** Pool all player probabilities, so a bin compares predicted wins with observed win indicators. */
export function addCalibration(
  bins: CalibrationBin[],
  probabilities: readonly number[],
  winner: number,
): void {
  probabilities.forEach((probability, p) => {
    const bin = bins[Math.min(9, Math.floor(probability * 10))];
    bin.count++;
    bin.predictedSum += probability;
    bin.actualSum += Number(p === winner);
    bin.predicted = bin.predictedSum / bin.count;
    bin.actual = bin.actualSum / bin.count;
  });
}
/** Adam applies L2 in optimizer coordinates, with optional prior and post-update sign projection.
 * Omitting both retains the original zero-centred, unconstrained updates exactly. */
export class Adam {
  private m: number[];
  private v: number[];
  private t = 0;
  private prior?: readonly number[];
  private signs?: readonly FeatureSign[];
  constructor(
    readonly weights: number[],
    private learningRate = 0.02,
    private l2 = 0.001,
    prior?: readonly number[],
    signs?: readonly FeatureSign[],
  ) {
    if (
      prior !== undefined &&
      (!Array.isArray(prior) ||
        prior.length !== weights.length ||
        prior.some((x) => !Number.isFinite(x)))
    )
      throw new Error('Invalid optimizer prior');
    if (
      signs !== undefined &&
      (!Array.isArray(signs) ||
        signs.length !== weights.length ||
        signs.some((sign) => sign !== -1 && sign !== 0 && sign !== 1))
    )
      throw new Error('Invalid optimizer signs');
    this.prior = prior?.slice();
    this.signs = signs?.slice();
    this.m = weights.map(() => 0);
    this.v = weights.map(() => 0);
  }
  step(gradient: readonly number[]): void {
    this.t++;
    for (let j = 0; j < this.weights.length; j++) {
      const distance = this.prior ? this.weights[j] - this.prior[j] : this.weights[j];
      const g = gradient[j] + this.l2 * distance;
      this.m[j] = 0.9 * this.m[j] + 0.1 * g;
      this.v[j] = 0.999 * this.v[j] + 0.001 * g * g;
      this.weights[j] -=
        (this.learningRate * (this.m[j] / (1 - 0.9 ** this.t))) /
        (Math.sqrt(this.v[j] / (1 - 0.999 ** this.t)) + 1e-8);
      if (this.signs?.[j] === 1) this.weights[j] = Math.max(0, this.weights[j]);
      else if (this.signs?.[j] === -1) this.weights[j] = Math.min(0, this.weights[j]);
    }
  }
}
/** RMS scaling uses training games only; folding it into the exported weights keeps browser evaluation unchanged. */
export function foldWeights(normalized: readonly number[], scales: readonly number[]): number[] {
  return normalized.map((w, j) => w / scales[j]);
}
export interface FitConfig {
  input: string;
  out: string;
  epochs: number;
  batchSize: number;
  learningRate: number;
  l2: number;
  initial: readonly number[];
  /** Optional raw-coefficient L2 center, independent of initial weights; absent keeps zero-centred L2. */
  prior?: readonly number[];
  /** Project after each update onto FEATURE_SIGNS; absent preserves unconstrained diagnostic fits. */
  constrainSigns?: boolean;
  id: string;
}
/** Generated chunks follow numeric game-start order; other names follow in lexical order. */
function compareInputNames(a: string, b: string): number {
  const start = (name: string): number | undefined => {
    const match = /^positions-(\d+)\.jsonl$/.exec(name);
    const value = match ? Number(match[1]) : NaN;
    return Number.isSafeInteger(value) ? value : undefined;
  };
  const aStart = start(a),
    bStart = start(b),
    lexical = a < b ? -1 : a > b ? 1 : 0;
  if (aStart !== undefined && bStart !== undefined) return aStart - bStart || lexical;
  if (aStart !== undefined) return -1;
  if (bStart !== undefined) return 1;
  return lexical;
}
async function inputFiles(input: string): Promise<string[]> {
  if (input.endsWith('.jsonl')) return [resolve(input)];
  return (await readdir(input))
    .filter((name) => name.endsWith('.jsonl'))
    .sort(compareInputNames)
    .map((name) => resolve(join(input, name)));
}
/** Reopen files each pass; rows are never retained as a generation-sized array. */
async function* positions(
  files: readonly string[],
): AsyncGenerator<TrainingPosition & { sourceFile: string }> {
  for (const file of files) {
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        const row = JSON.parse(line) as TrainingPosition;
        if (
          !Number.isSafeInteger(row.game) ||
          row.game < 0 ||
          !Number.isSafeInteger(row.turn) ||
          row.turn < 1 ||
          !Number.isSafeInteger(row.seed) ||
          !Number.isInteger(row.winner) ||
          !Array.isArray(row.features) ||
          !row.features.length ||
          row.winner < 0 ||
          row.winner >= row.features.length ||
          row.features.some(
            (f) =>
              !Array.isArray(f) ||
              f.length !== FEATURE_NAMES.length ||
              f.some((x) => !Number.isFinite(x)),
          )
        )
          throw new Error(`Invalid training position in ${file}`);
        yield { ...row, sourceFile: file };
      }
    } finally {
      lines.close();
    }
  }
}
type SourceProvenance = NonNullable<Awaited<ReturnType<typeof sourceMetadata>>>;
interface WorkerRange {
  file: string;
  start: number;
  endExclusive: number;
  positions?: number;
}
/** Bind worker ranges by basename so a completed generation can be moved without invalidating provenance. */
function declaredWorkers(metadata: SourceProvenance): Map<string, WorkerRange> {
  const result = new Map<string, WorkerRange>();
  for (const chunk of metadata.chunks) {
    const workers = chunk.metadata.workers;
    if (workers === undefined) continue;
    if (!Array.isArray(workers)) throw new Error(`Invalid workers in ${chunk.file}`);
    const range = metadata.ranges.find((r) => r.file === chunk.file)!;
    for (const worker of workers) {
      if (
        !worker ||
        typeof worker.file !== 'string' ||
        !Number.isSafeInteger(worker.start) ||
        !Number.isSafeInteger(worker.games) ||
        worker.games < 1 ||
        worker.start < range.start ||
        worker.start + worker.games > range.endExclusive ||
        !Number.isSafeInteger(worker.start + worker.games) ||
        (worker.positions !== undefined &&
          (!Number.isSafeInteger(worker.positions) || worker.positions < 0))
      )
        throw new Error(`Invalid worker range in ${chunk.file}`);
      const file = basename(worker.file);
      if (result.has(file)) throw new Error(`Repeated worker file declaration: ${file}`);
      result.set(file, {
        file,
        start: worker.start,
        endExclusive: worker.start + worker.games,
        positions: worker.positions,
      });
    }
  }
  return result;
}
/** Check every row against its declared chunk and worker, counting observations before any fit begins. */
function checkDeclaredRow(
  row: TrainingPosition & { sourceFile: string },
  metadata: SourceProvenance,
  workers: ReadonlyMap<string, WorkerRange>,
  chunkCounts: Map<string, number>,
  workerCounts: Map<string, number>,
): void {
  const range = metadata.ranges.find((r) => row.game >= r.start && row.game < r.endExclusive);
  if (!range) throw new Error(`Game ${row.game} is outside declared metadata ranges`);
  if (row.seed !== Number(metadata.seed) + row.game)
    throw new Error(`Row seed does not match metadata base seed + game ID for game ${row.game}`);
  const file = basename(row.sourceFile),
    worker = workers.get(file);
  const chunk = metadata.chunks.find((c) => c.file === range.file)!;
  if (
    (worker && (row.game < worker.start || row.game >= worker.endExclusive)) ||
    (!worker && chunk.metadata.workers !== undefined)
  )
    throw new Error(`Game ${row.game} is outside the declared worker range for ${file}`);
  chunkCounts.set(range.file, (chunkCounts.get(range.file) ?? 0) + 1);
  workerCounts.set(file, (workerCounts.get(file) ?? 0) + 1);
}
/** Validate cross-row identity once; retain turn sets and labels, never feature matrices. */
async function gameIds(
  files: readonly string[],
  metadata: SourceProvenance | null,
): Promise<number[]> {
  const games = new Map<
    number,
    { seed: number; winner: number; turns: Set<number>; lastTurn: number }
  >();
  const workers = metadata ? declaredWorkers(metadata) : new Map<string, WorkerRange>();
  const chunkCounts = new Map<string, number>(),
    workerCounts = new Map<string, number>();
  for await (const row of positions(files)) {
    if (metadata) checkDeclaredRow(row, metadata, workers, chunkCounts, workerCounts);
    let game = games.get(row.game);
    if (!game) {
      game = { seed: row.seed, winner: row.winner, turns: new Set(), lastTurn: 0 };
      games.set(row.game, game);
    }
    if (game.seed !== row.seed)
      throw new Error('Duplicate game ID across different seeds; fit one generation at a time');
    if (game.winner !== row.winner) throw new Error(`Inconsistent winner for game ${row.game}`);
    if (game.turns.has(row.turn))
      throw new Error(`Duplicate training position for game ${row.game}, turn ${row.turn}`);
    game.turns.add(row.turn);
    game.lastTurn = Math.max(game.lastTurn, row.turn);
  }
  for (const [id, game] of games)
    if (game.lastTurn !== game.turns.size)
      throw new Error(
        `Non-contiguous sampled turns for game ${id}; expected every turn starting at 1`,
      );
  if (metadata) {
    if (games.size !== metadata.games)
      throw new Error(`Missing declared games: expected ${metadata.games}, found ${games.size}`);
    for (const chunk of metadata.chunks)
      if (
        chunk.metadata.positions !== undefined &&
        chunk.metadata.positions !== (chunkCounts.get(chunk.file) ?? 0)
      )
        throw new Error(`Declared position count does not match actual rows in ${chunk.file}`);
    for (const worker of workers.values())
      if (
        worker.positions !== undefined &&
        worker.positions !== (workerCounts.get(worker.file) ?? 0)
      )
        throw new Error(
          `Declared worker position count does not match actual rows in ${worker.file}`,
        );
  }
  return [...games.keys()];
}
interface SourceChunk {
  file: string;
  metadata: Record<string, unknown>;
  start: number;
  games: number;
  endExclusive: number;
}
/** Validate each chunk independently before comparing shared generation settings. */
function metadataChunk(file: string, metadata: Record<string, unknown>): SourceChunk {
  if (
    !metadata ||
    !Array.isArray(metadata.featureNames) ||
    metadata.featureNames.length !== FEATURE_NAMES.length ||
    metadata.featureNames.some((name: unknown, i: number) => name !== FEATURE_NAMES[i])
  )
    throw new Error(`Input metadata feature names do not match FEATURE_NAMES: ${file}`);
  const start = metadata.start ?? 0,
    games = metadata.games;
  if (
    typeof start !== 'number' ||
    !Number.isSafeInteger(start) ||
    start < 0 ||
    typeof games !== 'number' ||
    !Number.isSafeInteger(games) ||
    games < 1 ||
    !Number.isSafeInteger(start + games)
  )
    throw new Error(`Invalid declared game range in ${file}`);
  if (
    typeof metadata.seed !== 'number' ||
    !Number.isSafeInteger(metadata.seed) ||
    typeof metadata.generation !== 'number' ||
    !Number.isSafeInteger(metadata.generation) ||
    metadata.generation < 0 ||
    typeof metadata.budget !== 'number' ||
    !Number.isSafeInteger(metadata.budget) ||
    metadata.budget < 1 ||
    !Array.isArray(metadata.weights) ||
    metadata.weights.length !== FEATURE_NAMES.length ||
    metadata.weights.some((x: unknown) => typeof x !== 'number' || !Number.isFinite(x))
  )
    throw new Error(`Invalid generation settings in ${file}`);
  if (
    metadata.positions !== undefined &&
    (typeof metadata.positions !== 'number' ||
      !Number.isSafeInteger(metadata.positions) ||
      metadata.positions < 0)
  )
    throw new Error(`Invalid declared position count in ${file}`);
  return { file, metadata, start, games, endExclusive: start + games };
}
/** Older generations used the fixed Paris defaults; new generations also record each actual player configuration. */
function recordedSelfplayConfiguration(metadata: Record<string, unknown>) {
  if (metadata.tier !== undefined && typeof metadata.tier !== 'string')
    throw new Error('Invalid recorded self-play tier');
  const resolved = metadata.resolvedConfigurations;
  const defaults =
    resolved === undefined ||
    metadata.tier === undefined ||
    String(metadata.tier).toLowerCase() === 'paris'
      ? LEGACY_SELFPLAY_POLICY
      : resolvedSelfplayPolicy({ tier: String(metadata.tier) });
  const policy =
    metadata.policy === undefined && resolved !== undefined
      ? undefined
      : normalizeSelfplayPolicy(metadata.policy, defaults);
  // Missing historical configurations mean the original Paris collector, independent
  // of today's tier table. Keep every effective setting frozen for chunk comparisons.
  const legacyConfig: SearchConfig = {
    engine: 'planner',
    weights: metadata.weights as number[],
    budget: metadata.budget as number,
    noise: 0.06,
    randomMove: 0,
    openingTopK: 5,
    setupBudget: 0,
    timeLimitMs: 0,
    lookahead: false,
    humanPlayers: [],
    tradeGuards: false,
    ...(policy ?? LEGACY_SELFPLAY_POLICY),
  };
  if (resolved === undefined) return { policy: policy!, config: legacyConfig };
  if (!Array.isArray(resolved) || resolved.length !== 3)
    throw new Error('Invalid resolved self-play configurations');
  let canonical = policy;
  let canonicalConfig: SearchConfig | undefined;
  for (let p = 0; p < resolved.length; p++) {
    const seat = resolved[p];
    const humans = seat?.config?.humanPlayers === undefined ? [] : seat?.config?.humanPlayers;
    if (
      !seat ||
      seat.playerId !== p ||
      !seat.config ||
      !Array.isArray(humans) ||
      humans.length !== 0
    )
      throw new Error('Self-play configurations must describe three all-bot seats');
    const actual = normalizeSelfplayPolicy(
      {
        activeTrading: seat.config.activeTrading ?? false,
        tradeProposals: seat.config.tradeProposals ?? 2,
        delta: seat.config.delta,
        eps: seat.config.eps,
      },
      LEGACY_SELFPLAY_POLICY,
    );
    if (canonical && JSON.stringify(actual) !== JSON.stringify(canonical))
      throw new Error('Recorded policy differs from resolved self-play configurations');
    canonical = actual;
    const raw = seat.config;
    const config: SearchConfig = {
      engine: raw.engine,
      weights: raw.weights,
      budget: raw.budget,
      noise: raw.noise,
      randomMove: raw.randomMove,
      openingTopK: raw.openingTopK,
      setupBudget: raw.setupBudget === undefined ? 0 : raw.setupBudget,
      timeLimitMs: raw.timeLimitMs === undefined ? 0 : raw.timeLimitMs,
      lookahead: raw.lookahead,
      humanPlayers: [],
      tradeGuards: raw.tradeGuards === undefined ? false : raw.tradeGuards,
      ...actual,
    };
    if (
      !['greedy', 'planner', 'mcts'].includes(config.engine) ||
      !Number.isSafeInteger(config.budget) ||
      config.budget < 1 ||
      !Array.isArray(config.weights) ||
      config.weights.length !== FEATURE_NAMES.length ||
      config.weights.some((x) => typeof x !== 'number' || !Number.isFinite(x)) ||
      !Number.isFinite(config.noise) ||
      config.noise < 0 ||
      !Number.isFinite(config.randomMove) ||
      config.randomMove < 0 ||
      !Number.isSafeInteger(config.openingTopK) ||
      config.openingTopK < 1 ||
      !Number.isSafeInteger(config.setupBudget) ||
      config.setupBudget! < 0 ||
      typeof config.timeLimitMs !== 'number' ||
      !Number.isFinite(config.timeLimitMs) ||
      config.timeLimitMs < 0 ||
      typeof config.lookahead !== 'boolean' ||
      typeof config.tradeGuards !== 'boolean'
    )
      throw new Error('Invalid resolved self-play configuration');
    for (const field of ['weights', 'budget'] as const)
      if (JSON.stringify(config[field]) !== JSON.stringify(metadata[field]))
        throw new Error(`Resolved self-play ${field} differs from metadata`);
    if (canonicalConfig && JSON.stringify(config) !== JSON.stringify(canonicalConfig))
      throw new Error('Resolved self-play configurations differ across seats');
    canonicalConfig = config;
  }
  return { policy: canonical!, config: canonicalConfig! };
}
/** Preserve every original chunk and reject incompatible schemas, settings, or overlapping game ranges. */
async function sourceMetadata(input: string) {
  if (input.endsWith('.jsonl')) return null;
  const names = (await readdir(input))
    .filter((name) => /^metadata(?:-\d+)?\.json$/.test(name))
    .sort();
  if (!names.length) return null;
  const chunks: SourceChunk[] = [];
  for (const name of names) {
    const file = resolve(join(input, name));
    chunks.push(metadataChunk(file, JSON.parse(await readFile(file, 'utf8'))));
  }
  const first = chunks[0].metadata;
  const recorded = recordedSelfplayConfiguration(first);
  for (const chunk of chunks.slice(1)) {
    const current = recordedSelfplayConfiguration(chunk.metadata);
    if (JSON.stringify(current.policy) !== JSON.stringify(recorded.policy))
      throw new Error(`Inconsistent policy across metadata chunks: ${chunk.file}`);
    for (const field of ['seed', 'generation', 'budget', 'weights'] as const)
      if (JSON.stringify(chunk.metadata[field]) !== JSON.stringify(first[field]))
        throw new Error(`Inconsistent ${field} across metadata chunks: ${chunk.file}`);
    if (JSON.stringify(current.config) !== JSON.stringify(recorded.config))
      throw new Error(`Inconsistent resolved configuration across metadata chunks: ${chunk.file}`);
  }
  chunks.sort((a, b) => a.start - b.start || a.file.localeCompare(b.file));
  for (let i = 1; i < chunks.length; i++)
    if (chunks[i].start < chunks[i - 1].endExclusive)
      throw new Error(
        `Overlapping declared game ranges: ${chunks[i - 1].file} and ${chunks[i].file}`,
      );
  const games = chunks.reduce((sum, chunk) => sum + chunk.games, 0);
  if (!Number.isSafeInteger(games)) throw new Error('Declared generation game count is too large');
  return {
    featureNames: first.featureNames,
    policy: recorded.policy,
    config: recorded.config,
    tiers: [...new Set(chunks.map((chunk) => chunk.metadata.tier ?? 'Paris'))],
    seed: first.seed,
    generation: first.generation,
    budget: first.budget,
    weights: first.weights,
    games,
    ranges: chunks.map(({ file, start, games, endExclusive }) => ({
      file,
      start,
      games,
      endExclusive,
    })),
    chunks: chunks.map(({ file, metadata }) => ({ file, metadata })),
  };
}
/** Accumulate training-only RMS statistics after the whole-game partition is fixed. */
async function scan(files: readonly string[], heldOut: ReadonlySet<number>) {
  const games = new Set<number>(),
    seeds = new Set<number>();
  const squares = FEATURE_NAMES.map(() => 0);
  let trainPositions = 0,
    heldPositions = 0,
    players = 0;
  for await (const row of positions(files)) {
    games.add(row.game);
    seeds.add(row.seed);
    if (heldOut.has(row.game)) {
      heldPositions++;
      continue;
    }
    trainPositions++;
    for (const vector of row.features) {
      players++;
      vector.forEach((x, j) => {
        squares[j] += x * x;
      });
    }
  }
  if (!trainPositions || !heldPositions)
    throw new Error('Need both training and held-out games; collect more self-play games');
  return {
    games: games.size,
    heldOutGames: heldOut.size,
    heldOutGameIds: [...heldOut],
    trainPositions,
    heldPositions,
    seeds: [...seeds].sort((a, b) => a - b),
    scales: squares.map((sum) => Math.max(Math.sqrt(sum / players), 1e-6)),
  };
}
async function evaluate(
  files: readonly string[],
  weights: readonly number[],
  heldOut: ReadonlySet<number>,
) {
  let trainLoss = 0,
    heldLoss = 0,
    trainCount = 0,
    heldCount = 0;
  const calibration = emptyCalibration();
  for await (const row of positions(files)) {
    const result = lossGradient(row.features, row.winner, weights);
    if (heldOut.has(row.game)) {
      heldLoss += result.loss;
      heldCount++;
      addCalibration(calibration, result.probabilities, row.winner);
    } else {
      trainLoss += result.loss;
      trainCount++;
    }
  }
  return {
    trainLogLoss: trainLoss / trainCount,
    heldOutLogLoss: heldLoss / heldCount,
    calibration,
  };
}
/** Fit a candidate artifact only; promotion always requires a separately measured arena win. */
export async function fit(config: FitConfig) {
  if (
    !Number.isInteger(config.epochs) ||
    config.epochs < 1 ||
    !Number.isInteger(config.batchSize) ||
    config.batchSize < 1 ||
    !(config.learningRate > 0) ||
    !Number.isFinite(config.learningRate) ||
    !(config.l2 >= 0) ||
    !Number.isFinite(config.l2)
  )
    throw new Error('Invalid fit hyperparameters');
  if (config.constrainSigns !== undefined && typeof config.constrainSigns !== 'boolean')
    throw new Error('constrainSigns must be a boolean');
  if (
    config.initial.length !== FEATURE_NAMES.length ||
    config.initial.some((x) => !Number.isFinite(x))
  )
    throw new Error('Invalid initial weights');
  if (
    config.prior !== undefined &&
    (!Array.isArray(config.prior) ||
      config.prior.length !== FEATURE_NAMES.length ||
      config.prior.some((x) => !Number.isFinite(x)))
  )
    throw new Error('Invalid prior weights');
  const files = await inputFiles(config.input);
  if (!files.length) throw new Error('No JSONL input files');
  const metadata = await sourceMetadata(config.input);
  const heldOut = new Set(heldOutGameIds(await gameIds(files, metadata)));
  const dataset = await scan(files, heldOut),
    { scales } = dataset;
  const optimizer = new Adam(
    config.initial.map((w, j) => w * scales[j]),
    config.learningRate,
    config.l2,
    config.prior?.map((w, j) => w * scales[j]),
    config.constrainSigns ? FEATURE_SIGNS : undefined,
  );
  const epochLoss: number[] = [];
  for (let epoch = 0; epoch < config.epochs; epoch++) {
    let gradient = FEATURE_NAMES.map(() => 0),
      batch = 0,
      count = 0,
      loss = 0;
    const flush = () => {
      if (batch) {
        optimizer.step(gradient.map((x) => x / batch));
        gradient = gradient.map(() => 0);
        batch = 0;
      }
    };
    for await (const row of positions(files)) {
      if (heldOut.has(row.game)) continue;
      const matrix = row.features.map((vector) => vector.map((x, j) => x / scales[j]));
      const result = lossGradient(matrix, row.winner, optimizer.weights);
      result.gradient.forEach((x, j) => {
        gradient[j] += x;
      });
      loss += result.loss;
      batch++;
      count++;
      if (batch === config.batchSize) flush();
    }
    flush();
    epochLoss.push(loss / count);
    process.stderr.write(
      `fit epoch ${epoch + 1}/${config.epochs}: online training log-loss ${epochLoss[epoch]}\n`,
    );
  }
  const weights = foldWeights(optimizer.weights, scales),
    metrics = await evaluate(files, weights, heldOut);
  const artifact = {
    id: config.id,
    featureNames: FEATURE_NAMES,
    weights,
    provenance: {
      ...dataset,
      ...metrics,
      date: new Date().toISOString(),
      inputFiles: files,
      sourceMetadata: metadata,
      split:
        'Unique game IDs sorted by unsigned hash then ID; choose floor(games * 0.1), with at least one when two games exist. Explicit heldOutGameIds are excluded from scaling and optimization and used for final evaluation.',
      heldOutFraction: dataset.heldOutGames / dataset.games,
      optimizer: 'Adam',
      normalization:
        'Training-only per-feature RMS; exported weights divide normalized coefficients by RMS. No centering/intercept.',
      l2Space: 'RMS-normalized coefficients',
      l2Center: config.prior === undefined ? 'zero' : 'prior',
      constrainSigns: config.constrainSigns ?? false,
      featureSigns: config.constrainSigns ? FEATURE_SIGNS : null,
      projection: config.constrainSigns
        ? 'After each Adam update; positive training-only RMS scaling preserves raw coefficient signs.'
        : 'none',
      priorWeights: config.prior === undefined ? FEATURE_NAMES.map(() => 0) : [...config.prior],
      epochs: config.epochs,
      batchSize: config.batchSize,
      learningRate: config.learningRate,
      l2: config.l2,
      epochOnlineLogLoss: epochLoss,
      initialWeights: config.initial,
    },
  };
  await ensureParent(config.out);
  await writeFile(config.out, JSON.stringify(artifact, null, 2) + '\n');
  return artifact;
}
async function main() {
  const args = process.argv.slice(2),
    initialPath = option(args, '--weights'),
    priorPath = option(args, '--prior-weights');
  const input = option(args, '--input', option(args, '--in', 'runs/generation-0'))!;
  const constrainSigns = option(args, '--constrain-signs', 'false');
  if (constrainSigns !== 'true' && constrainSigns !== 'false')
    throw new Error('--constrain-signs expects true or false');
  const artifact = await fit({
    input,
    out: option(args, '--out', 'runs/candidate-w1.json')!,
    epochs: integerOption(args, '--epochs', 8),
    batchSize: integerOption(args, '--batch-size', 128),
    learningRate: Number(option(args, '--learning-rate', '.02')),
    l2: Number(option(args, '--l2', '.001')),
    initial: initialPath ? await readWeights(initialPath) : W0,
    prior: priorPath ? await readWeights(priorPath) : undefined,
    constrainSigns: constrainSigns === 'true',
    id: option(args, '--id', 'candidate-w1')!,
  });
  process.stdout.write(
    JSON.stringify(
      {
        id: artifact.id,
        games: artifact.provenance.games,
        heldOutGames: artifact.provenance.heldOutGames,
        trainLogLoss: artifact.provenance.trainLogLoss,
        heldOutLogLoss: artifact.provenance.heldOutLogLoss,
        calibration: artifact.provenance.calibration,
      },
      null,
      2,
    ) + '\n',
  );
}
if (isMain(import.meta.url))
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
