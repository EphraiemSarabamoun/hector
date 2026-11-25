/** Measurement and optimization checks isolate reproducibility and prevent holdout leakage. */
import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { FEATURE_NAMES, FEATURE_SIGNS, type FeatureSign } from '../src/ai/features.js';
import { probabilitiesFromFeatures } from '../src/ai/value.js';
import { tierByName } from '../src/ai/tiers.js';
import {
  Adam,
  lossGradient,
  foldWeights,
  heldOutGameIds,
  emptyCalibration,
  addCalibration,
  fit,
} from '../tools/fit.js';
import { partitions, playGame } from '../tools/ai-common.js';
import { arenaGame, summarizeArena, median } from '../tools/arena.js';
import {
  checkRawBudget,
  rawDirectoryBytes,
  LEGACY_SELFPLAY_POLICY,
  normalizeSelfplayPolicy,
  resolvedSelfplayPolicy,
  selfplayEntrants,
  selfplayResolvedConfigurations,
  selfplayPolicyOptions,
} from '../tools/selfplay.js';

/** Tiny complete generations exercise file boundaries without running another game simulation. */
function exampleRow(game: number, turn = 1, winner = 0) {
  return {
    game,
    seed: 1000 + game,
    turn,
    winner,
    features: [1, -1, 0].map((x) => FEATURE_NAMES.map((_, i) => (i === 0 ? x : 0))),
  };
}
function exampleMetadata(start: number, games: number) {
  return {
    featureNames: FEATURE_NAMES,
    seed: 1000,
    generation: 0,
    budget: 24,
    weights: FEATURE_NAMES.map(() => 0),
    start,
    games,
    note: `original chunk ${start}`,
    positions: games,
    workers: [
      { file: `/original/location/positions-${start}.jsonl`, start, games, positions: games },
    ],
  };
}
function exampleFit(input: string, out: string) {
  return {
    input,
    out,
    epochs: 1,
    batchSize: 8,
    learningRate: 0.02,
    l2: 0.001,
    initial: FEATURE_NAMES.map(() => 0),
    id: 'validation-test',
  };
}
async function writeRows(file: string, rows: unknown[]) {
  await writeFile(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

describe('training objective', () => {
  it('matches finite differences and ignores a common score offset', () => {
    const matrix = [
        [1, 2],
        [-1, 0],
        [0.5, -2],
      ],
      weights = [0.2, -0.3];
    const result = lossGradient(matrix, 1, weights),
      step = 1e-5;
    for (let j = 0; j < weights.length; j++) {
      const lo = [...weights],
        hi = [...weights];
      lo[j] -= step;
      hi[j] += step;
      expect(result.gradient[j]).toBeCloseTo(
        (lossGradient(matrix, 1, hi).loss - lossGradient(matrix, 1, lo).loss) / (2 * step),
        8,
      );
    }
    expect(result.probabilities).toEqual(probabilitiesFromFeatures(matrix, weights));
    const shifted = matrix.map((row) => row.map((x, j) => x + [100, -45][j]));
    expect(lossGradient(shifted, 1, weights).loss).toBeCloseTo(result.loss, 10);
  });
  it('keeps loss finite with saturated probabilities', () => {
    expect(lossGradient([[1000], [-1000]], 1, [1]).loss).toBe(2000);
  });
  it('folds RMS scaling exactly into inference weights', () => {
    const matrix = [
        [2, 4],
        [-3, 5],
        [6, -2],
      ],
      scales = [2, 3],
      normalized = [0.7, -0.2];
    const scaled = matrix.map((row) => row.map((x, j) => x / scales[j]));
    probabilitiesFromFeatures(matrix, foldWeights(normalized, scales)).forEach((p, i) =>
      expect(p).toBeCloseTo(probabilitiesFromFeatures(scaled, normalized)[i], 12),
    );
  });
  it('Adam learns a separable shared-vector example', () => {
    const matrix = [
        [1, 0],
        [0, 1],
        [-1, -1],
      ],
      optimizer = new Adam([0, 0], 0.05, 0.001);
    const before = lossGradient(matrix, 0, optimizer.weights).loss;
    for (let i = 0; i < 200; i++)
      optimizer.step(lossGradient(matrix, 0, optimizer.weights).gradient);
    expect(lossGradient(matrix, 0, optimizer.weights).loss).toBeLessThan(before / 10);
  });
  it('keeps absent-prior Adam updates exactly equal to an explicit zero prior', () => {
    const baseline = new Adam([0.3, -0.7, 0], 0.02, 0.001);
    const explicitZero = new Adam([0.3, -0.7, 0], 0.02, 0.001, [0, 0, 0]);
    for (let step = 0; step < 50; step++) {
      const gradient = [Math.sin(step), Math.cos(step), 0.1];
      baseline.step(gradient);
      explicitZero.step(gradient);
      expect(explicitZero.weights).toEqual(baseline.weights);
    }
  });
  it('pulls coefficients toward a nonzero prior when the data gradient is zero', () => {
    const target = [3, -4],
      optimizer = new Adam([1, -2], 0.05, 0.5, target);
    const before = optimizer.weights.map((w, j) => Math.abs(w - target[j]));
    for (let step = 0; step < 20; step++) optimizer.step([0, 0]);
    optimizer.weights.forEach((w, j) => expect(Math.abs(w - target[j])).toBeLessThan(before[j]));
    expect(() => new Adam([0, 0], 0.02, 0.1, [1])).toThrow('Invalid optimizer prior');
    expect(() => new Adam([0], 0.02, 0.1, [Infinity])).toThrow('Invalid optimizer prior');
  });
  it('preserves default fit numbers with an explicit zero prior and records a supplied prior independently of initialization', async () => {
    const directory = await mkdtemp(join(process.cwd(), 'runs-fit-test-'));
    try {
      const input = join(directory, 'samples.jsonl');
      await writeRows(
        input,
        Array.from({ length: 10 }, (_, game) => exampleRow(game)),
      );
      const base = exampleFit(input, join(directory, 'baseline.json'));
      const baseline = await fit(base);
      const explicitZero = await fit({
        ...base,
        out: join(directory, 'zero-prior.json'),
        prior: FEATURE_NAMES.map(() => 0),
      });
      expect(explicitZero.weights).toEqual(baseline.weights);
      expect(explicitZero.provenance.trainLogLoss).toBe(baseline.provenance.trainLogLoss);
      expect(explicitZero.provenance.heldOutLogLoss).toBe(baseline.provenance.heldOutLogLoss);
      expect(baseline.provenance.l2Center).toBe('zero');
      const prior = FEATURE_NAMES.map((_, j) => (j === 0 ? 0.6 : 0));
      const centered = await fit({ ...base, out: join(directory, 'prior.json'), prior, l2: 0.37 });
      expect(centered.provenance.l2Center).toBe('prior');
      expect(centered.provenance.priorWeights).toEqual(prior);
      expect(centered.provenance.initialWeights).toEqual(base.initial);
      expect(centered.provenance.l2).toBe(0.37);
      expect(centered.weights).not.toEqual(baseline.weights);
    } finally {
      await rm(directory, { recursive: true });
    }
  });
  it.each([
    { prior: [0] },
    { prior: FEATURE_NAMES.map((_, j) => (j === 0 ? NaN : 0)) },
    { prior: FEATURE_NAMES.map((_, j) => (j === 0 ? Infinity : 0)) },
  ])('rejects invalid raw prior weights before reading input %#', async ({ prior }) => {
    await expect(
      fit({
        ...exampleFit('runs/nonexistent-prior-test.jsonl', 'runs/nonexistent-prior-result.json'),
        prior,
      }),
    ).rejects.toThrow('Invalid prior weights');
  });
  it('projects Adam after each update while zero signs preserve exact unconstrained updates', () => {
    const projected = new Adam([0.01, -0.01, -2], 0.1, 0, undefined, [1, -1, 0]);
    projected.step([1, -1, 1]);
    expect(projected.weights.slice(0, 2)).toEqual([0, 0]);
    expect(projected.weights[2]).toBeLessThan(-2);
    const baseline = new Adam([0.2, -0.4], 0.02, 0.001),
      zeros = new Adam([0.2, -0.4], 0.02, 0.001, undefined, [0, 0]);
    for (let i = 0; i < 20; i++) {
      baseline.step([0.3, -0.1]);
      zeros.step([0.3, -0.1]);
      expect(zeros.weights).toEqual(baseline.weights);
    }
    expect(() => new Adam([0, 0], 0.02, 0.1, undefined, [1])).toThrow('Invalid optimizer signs');
    for (const bad of [2, 0.5, NaN, '1'])
      expect(
        () => new Adam([0], 0.02, 0.1, undefined, [bad] as unknown as readonly FeatureSign[]),
      ).toThrow('Invalid optimizer signs');
  });
  it('exports finite cross-entropy and sign provenance for an actively projected fit', async () => {
    const directory = await mkdtemp(join(process.cwd(), 'runs-fit-test-'));
    try {
      const input = join(directory, 'samples.jsonl');
      const rows = Array.from({ length: 10 }, (_, game) => ({
        ...exampleRow(game, 1, 1),
        features: [2, 0, 0].map((renown) => FEATURE_NAMES.map((_, j) => (j === 0 ? renown : 0))),
      }));
      await writeRows(input, rows);
      const base = exampleFit(input, join(directory, 'unconstrained.json'));
      const baseline = await fit(base);
      const constrained = await fit({
        ...base,
        out: join(directory, 'constrained.json'),
        prior: FEATURE_NAMES.map(() => 0),
        l2: 1,
        constrainSigns: true,
      });
      expect(baseline.weights[0]).toBeLessThan(0);
      expect(constrained.weights[0]).toBe(0);
      constrained.weights.forEach((weight, j) => {
        expect(Number.isFinite(weight)).toBe(true);
        if (FEATURE_SIGNS[j]) expect(weight * FEATURE_SIGNS[j]).toBeGreaterThanOrEqual(0);
      });
      expect(Number.isFinite(constrained.provenance.trainLogLoss)).toBe(true);
      expect(Number.isFinite(constrained.provenance.heldOutLogLoss)).toBe(true);
      expect(constrained.provenance.constrainSigns).toBe(true);
      expect(constrained.provenance.featureSigns).toEqual(FEATURE_SIGNS);
      expect(constrained.provenance.l2).toBe(1);
      expect(constrained.provenance.l2Center).toBe('prior');
      expect(baseline.provenance.constrainSigns).toBe(false);
      expect(baseline.provenance.featureSigns).toBeNull();
    } finally {
      await rm(directory, { recursive: true });
    }
  });
  it('requires an actual boolean sign-projection option', async () => {
    await expect(
      fit({
        ...exampleFit('runs/nonexistent-sign-test.jsonl', 'runs/nonexistent-sign-result.json'),
        constrainSigns: 'true' as unknown as boolean,
      }),
    ).rejects.toThrow('constrainSigns must be a boolean');
  });
  it('selects exactly ten percent of unique games independent of input order', () => {
    const games = Array.from({ length: 5000 }, (_, id) => id);
    const selected = heldOutGameIds(games);
    expect(selected).toHaveLength(500);
    expect(heldOutGameIds([...games].reverse())).toEqual(selected);
    expect(heldOutGameIds([...games, ...games])).toEqual(selected);
    expect(heldOutGameIds([])).toEqual([]);
    expect(heldOutGameIds([2])).toEqual([]);
    expect(heldOutGameIds([1, 2])).toHaveLength(1);
    expect(heldOutGameIds(Array.from({ length: 19 }, (_, i) => i))).toHaveLength(1);
    expect(() => heldOutGameIds([NaN])).toThrow();
    expect(heldOutGameIds([2 ** 32, 0])).toEqual([0]);
  });
  it('calibrates all player outcomes including exact one', () => {
    const bins = emptyCalibration();
    addCalibration(bins, [0.1, 0.2, 0.7], 2);
    addCalibration(bins, [1, 0, 0], 0);
    expect(bins.reduce((sum, b) => sum + b.count, 0)).toBe(6);
    expect(bins.reduce((sum, b) => sum + b.actualSum, 0)).toBe(2);
    expect(bins[9].predicted).toBe(1);
    expect(bins[9].actual).toBe(1);
  });
  it('fits a streaming candidate with auditable holdout metrics', async () => {
    const directory = await mkdtemp(join(process.cwd(), 'runs-fit-test-'));
    try {
      const input = join(directory, 'samples.jsonl'),
        out = join(directory, 'candidate.json');
      const vectors = [1, -1, 0].map((x) => FEATURE_NAMES.map((_, i) => (i === 0 ? x : 0)));
      const heldOut = new Set(heldOutGameIds(Array.from({ length: 100 }, (_, game) => game)));
      await writeFile(
        input,
        Array.from({ length: 100 }, (_, game) =>
          JSON.stringify({
            game,
            seed: 1000 + game,
            turn: 1,
            winner: 0,
            features: heldOut.has(game) ? vectors.map((v) => v.map((x) => x * 100)) : vectors,
          }),
        ).join('\n') + '\n',
      );
      const artifact = await fit({
        input,
        out,
        epochs: 3,
        batchSize: 8,
        learningRate: 0.08,
        l2: 0.001,
        initial: FEATURE_NAMES.map(() => 0),
        id: 'test-candidate',
      });
      expect(artifact.provenance.heldOutGames).toBe(10);
      expect(artifact.provenance.heldOutGameIds).toEqual([...heldOut]);
      expect(artifact.provenance.scales[0]).toBeCloseTo(Math.sqrt(2 / 3), 12);
      expect(artifact.provenance.heldOutLogLoss).toBeLessThan(Math.log(3));
      expect(artifact.provenance.calibration.reduce((n, b) => n + b.count, 0)).toBe(
        artifact.provenance.heldPositions * 3,
      );
      expect(JSON.parse(await readFile(out, 'utf8')).weights).toEqual(artifact.weights);
    } finally {
      await rm(directory, { recursive: true });
    }
  });
  it('fits identical weights and held-out results when the same game stream uses different numeric chunk splits', async () => {
    const directory = await mkdtemp(join(process.cwd(), 'runs-fit-test-'));
    try {
      const first = join(directory, 'first'),
        second = join(directory, 'second');
      await mkdir(first);
      await mkdir(second);
      const games = [0, 1, 2, 10, 11, 12];
      const rows = games.flatMap((game) =>
        [1, 2].map((turn) => {
          const row = exampleRow(game, turn, game % 3);
          row.features = row.features.map((vector, player) =>
            vector.map((x, j) =>
              j === 0 ? x + (game * (player + 1)) / 10 : j === 1 ? (turn + player + game) % 4 : x,
            ),
          );
          return row;
        }),
      );
      await writeRows(join(first, 'positions-0.jsonl'), rows.slice(0, 6));
      await writeRows(join(first, 'positions-10.jsonl'), rows.slice(6));
      await writeRows(join(second, 'positions-0.jsonl'), rows.slice(0, 4));
      await writeRows(join(second, 'positions-2.jsonl'), rows.slice(4, 6));
      await writeRows(join(second, 'positions-10.jsonl'), rows.slice(6));
      const a = await fit({
        ...exampleFit(first, join(first, 'candidate.json')),
        batchSize: 1,
        epochs: 2,
      });
      const b = await fit({
        ...exampleFit(second, join(second, 'candidate.json')),
        batchSize: 1,
        epochs: 2,
      });
      expect(b.weights).toEqual(a.weights);
      expect(b.provenance.heldOutGameIds).toEqual(a.provenance.heldOutGameIds);
      expect(b.provenance.heldOutLogLoss).toBe(a.provenance.heldOutLogLoss);
      expect(b.provenance.trainLogLoss).toBe(a.provenance.trainLogLoss);
      expect(b.provenance.calibration).toEqual(a.provenance.calibration);
    } finally {
      await rm(directory, { recursive: true });
    }
  });
  it('rejects reordered metadata feature names before fitting', async () => {
    const directory = await mkdtemp(join(process.cwd(), 'runs-fit-test-'));
    try {
      await writeFile(join(directory, 'samples.jsonl'), '');
      const reversed = [...FEATURE_NAMES].reverse();
      await writeFile(join(directory, 'metadata.json'), JSON.stringify({ featureNames: reversed }));
      await expect(
        fit({
          input: directory,
          out: join(directory, 'candidate.json'),
          epochs: 1,
          batchSize: 8,
          learningRate: 0.02,
          l2: 0.001,
          initial: FEATURE_NAMES.map(() => 0),
          id: 'wrong-schema',
        }),
      ).rejects.toThrow('Input metadata feature names');
      await writeFile(join(directory, 'metadata.json'), JSON.stringify(exampleMetadata(0, 2)));
      await expect(
        fit({
          input: directory,
          out: join(directory, 'candidate.json'),
          epochs: 1,
          batchSize: 8,
          learningRate: 0.02,
          l2: 0.001,
          initial: FEATURE_NAMES.map(() => 0),
          id: 'right-schema',
        }),
      ).rejects.toThrow('Missing declared games');
    } finally {
      await rm(directory, { recursive: true });
    }
  });
  it.each(['metadata.json', 'metadata-0.json'])(
    'preserves every matching chunk and aggregates disjoint ranges with %s',
    async (primaryName) => {
      const directory = await mkdtemp(join(process.cwd(), 'runs-fit-test-'));
      try {
        const chunks = [exampleMetadata(0, 2), exampleMetadata(2, 2)];
        await writeFile(join(directory, primaryName), JSON.stringify(chunks[0]));
        await writeFile(join(directory, 'metadata-2.json'), JSON.stringify(chunks[1]));
        await writeRows(join(directory, 'positions-0.jsonl'), [exampleRow(0), exampleRow(1)]);
        await writeRows(join(directory, 'positions-2.jsonl'), [exampleRow(2), exampleRow(3)]);
        const artifact = await fit(exampleFit(directory, join(directory, 'candidate.json')));
        expect(artifact.provenance.sourceMetadata?.games).toBe(4);
        expect(artifact.provenance.sourceMetadata?.chunks.map((chunk) => chunk.metadata)).toEqual(
          chunks,
        );
        expect(
          artifact.provenance.sourceMetadata?.ranges.map(({ start, endExclusive }) => [
            start,
            endExclusive,
          ]),
        ).toEqual([
          [0, 2],
          [2, 4],
        ]);
      } finally {
        await rm(directory, { recursive: true });
      }
    },
  );
  it.each(['featureNames', 'seed', 'generation', 'budget', 'weights'])(
    'rejects chunk %s mismatches even when metadata.json is valid',
    async (field) => {
      const directory = await mkdtemp(join(process.cwd(), 'runs-fit-test-'));
      try {
        await writeRows(join(directory, 'positions-0.jsonl'), [exampleRow(0), exampleRow(1)]);
        await writeFile(join(directory, 'metadata.json'), JSON.stringify(exampleMetadata(0, 2)));
        const chunk = exampleMetadata(2, 2);
        if (field === 'featureNames')
          chunk.featureNames = [...FEATURE_NAMES].reverse() as unknown as typeof FEATURE_NAMES;
        else if (field === 'weights') chunk.weights = chunk.weights.map((_, i) => Number(i === 0));
        else if (field === 'seed') chunk.seed++;
        else if (field === 'generation') chunk.generation++;
        else chunk.budget++;
        await writeFile(join(directory, 'metadata-2.json'), JSON.stringify(chunk));
        await expect(fit(exampleFit(directory, join(directory, 'candidate.json')))).rejects.toThrow(
          field === 'featureNames' ? 'Input metadata feature names' : `Inconsistent ${field}`,
        );
      } finally {
        await rm(directory, { recursive: true });
      }
    },
  );
  it('rejects overlapping declared ranges before reading training rows', async () => {
    const directory = await mkdtemp(join(process.cwd(), 'runs-fit-test-'));
    try {
      await writeRows(join(directory, 'positions-0.jsonl'), [exampleRow(0), exampleRow(1)]);
      await writeFile(join(directory, 'metadata.json'), JSON.stringify(exampleMetadata(0, 3)));
      await writeFile(join(directory, 'metadata-2.json'), JSON.stringify(exampleMetadata(2, 2)));
      await expect(fit(exampleFit(directory, join(directory, 'candidate.json')))).rejects.toThrow(
        'Overlapping declared game ranges',
      );
    } finally {
      await rm(directory, { recursive: true });
    }
  });
  it.each([
    {
      label: 'missing game',
      games: 3,
      rows: [exampleRow(0), exampleRow(2)],
      error: 'Missing declared games',
    },
    {
      label: 'extra game',
      games: 2,
      rows: [exampleRow(0), exampleRow(1), exampleRow(2)],
      error: 'outside declared metadata ranges',
    },
    {
      label: 'incorrect row seed',
      games: 2,
      rows: [exampleRow(0), { ...exampleRow(1), seed: 99 }],
      error: 'Row seed does not match metadata base seed',
    },
  ])(
    'rejects $label against declared generation ranges and seed',
    async ({ games, rows, error }) => {
      const directory = await mkdtemp(join(process.cwd(), 'runs-fit-test-'));
      try {
        await writeFile(
          join(directory, 'metadata.json'),
          JSON.stringify(exampleMetadata(0, games)),
        );
        await writeRows(join(directory, 'positions-0.jsonl'), rows);
        await expect(fit(exampleFit(directory, join(directory, 'candidate.json')))).rejects.toThrow(
          error,
        );
      } finally {
        await rm(directory, { recursive: true });
      }
    },
  );
  it.each(['chunk', 'worker'])('rejects an incorrect declared %s position count', async (kind) => {
    const directory = await mkdtemp(join(process.cwd(), 'runs-fit-test-'));
    try {
      const metadata = exampleMetadata(0, 2);
      if (kind === 'chunk') metadata.positions++;
      else metadata.workers[0].positions++;
      await writeFile(join(directory, 'metadata.json'), JSON.stringify(metadata));
      await writeRows(join(directory, 'positions-0.jsonl'), [exampleRow(0), exampleRow(1)]);
      await expect(fit(exampleFit(directory, join(directory, 'candidate.json')))).rejects.toThrow(
        kind === 'chunk' ? 'Declared position count' : 'Declared worker position count',
      );
    } finally {
      await rm(directory, { recursive: true });
    }
  });
  it('rejects games misplaced into another declared worker file even when the generation union is complete', async () => {
    const directory = await mkdtemp(join(process.cwd(), 'runs-fit-test-'));
    try {
      await writeFile(join(directory, 'metadata.json'), JSON.stringify(exampleMetadata(0, 2)));
      await writeFile(join(directory, 'metadata-2.json'), JSON.stringify(exampleMetadata(2, 2)));
      await writeRows(join(directory, 'positions-0.jsonl'), [exampleRow(0), exampleRow(2)]);
      await writeRows(join(directory, 'positions-2.jsonl'), [exampleRow(1), exampleRow(3)]);
      await expect(fit(exampleFit(directory, join(directory, 'candidate.json')))).rejects.toThrow(
        'outside the declared worker range',
      );
    } finally {
      await rm(directory, { recursive: true });
    }
  });
  it.each([[2], [1, 3]])('rejects non-contiguous per-game turns %j', async (...turns) => {
    const directory = await mkdtemp(join(process.cwd(), 'runs-fit-test-'));
    try {
      const input = join(directory, 'positions.jsonl');
      await writeRows(input, [...turns.map((turn) => exampleRow(0, turn)), exampleRow(1)]);
      await expect(fit(exampleFit(input, join(directory, 'candidate.json')))).rejects.toThrow(
        'Non-contiguous sampled turns for game 0',
      );
    } finally {
      await rm(directory, { recursive: true });
    }
  });
  it('rejects a repeated game/turn across files even with the same seed and winner', async () => {
    const directory = await mkdtemp(join(process.cwd(), 'runs-fit-test-'));
    try {
      await writeRows(join(directory, 'positions-a.jsonl'), [exampleRow(0), exampleRow(1)]);
      await writeRows(join(directory, 'positions-b.jsonl'), [exampleRow(0)]);
      await expect(fit(exampleFit(directory, join(directory, 'candidate.json')))).rejects.toThrow(
        'Duplicate training position for game 0, turn 1',
      );
    } finally {
      await rm(directory, { recursive: true });
    }
  });
  it('rejects inconsistent winners across distinct turns of a game', async () => {
    const directory = await mkdtemp(join(process.cwd(), 'runs-fit-test-'));
    try {
      const input = join(directory, 'positions.jsonl');
      await writeRows(input, [exampleRow(0, 1, 0), exampleRow(0, 2, 1), exampleRow(1)]);
      await expect(fit(exampleFit(input, join(directory, 'candidate.json')))).rejects.toThrow(
        'Inconsistent winner for game 0',
      );
    } finally {
      await rm(directory, { recursive: true });
    }
  });
  it.each([undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid sampled turn %s',
    async (turn) => {
      const directory = await mkdtemp(join(process.cwd(), 'runs-fit-test-'));
      try {
        const input = join(directory, 'positions.jsonl');
        await writeRows(input, [{ ...exampleRow(0), turn }, exampleRow(1)]);
        await expect(fit(exampleFit(input, join(directory, 'candidate.json')))).rejects.toThrow(
          'Invalid training position',
        );
      } finally {
        await rm(directory, { recursive: true });
      }
    },
  );
});

describe('final-policy self-play configuration', () => {
  it('uses three all-bot Aeneas entrants with selected policy and unchanged exploration settings', () => {
    const policy = { activeTrading: true, tradeProposals: 4, delta: 0, eps: 0.002 };
    const config = { tier: 'Aeneas', policy, weights: FEATURE_NAMES.map(() => 0), budget: 128 };
    const entrants = selfplayEntrants(config),
      recorded = selfplayResolvedConfigurations(config);
    expect(resolvedSelfplayPolicy(config)).toEqual(policy);
    for (let p = 0; p < 3; p++) {
      expect(entrants[p].name).toBe('Aeneas');
      expect(entrants[p].overrides).toMatchObject({
        ...policy,
        noise: 0.06,
        openingTopK: 5,
        budget: 128,
        humanPlayers: [],
      });
      expect(recorded[p].playerId).toBe(p);
      expect(recorded[p]).toMatchObject({
        name: 'Aeneas',
        config: { ...policy, noise: 0.06, openingTopK: 5, budget: 128, humanPlayers: [] },
      });
    }
    expect(policy).toEqual({ activeTrading: true, tradeProposals: 4, delta: 0, eps: 0.002 });
  });
  it('preserves the original Paris tool default unless Aeneas is explicitly selected', () => {
    const config = { weights: FEATURE_NAMES.map(() => 0), budget: 24 };
    expect(selfplayEntrants(config).every((entrant) => entrant.name === 'Paris')).toBe(true);
    expect(resolvedSelfplayPolicy(config)).toEqual(LEGACY_SELFPLAY_POLICY);
    expect(
      selfplayEntrants({ ...config, tier: 'aeneas' }).every((entrant) => entrant.name === 'Aeneas'),
    ).toBe(true);
    expect(resolvedSelfplayPolicy({ ...config, tier: 'Aeneas' })).toMatchObject({
      eps: tierByName('Aeneas').eps,
      delta: tierByName('Aeneas').delta,
    });
  });
  it('parses explicit policy flags and validates malformed overrides without running games', () => {
    expect(
      selfplayPolicyOptions([
        '--active-trading',
        'true',
        '--trade-proposals',
        '4',
        '--delta',
        '0',
        '--eps',
        '.002',
      ]),
    ).toEqual({ activeTrading: true, tradeProposals: 4, delta: 0, eps: 0.002 });
    expect(selfplayPolicyOptions([])).toEqual({});
    for (const args of [
      ['--active-trading', 'yes'],
      ['--trade-proposals', '5'],
      ['--delta', '-1'],
      ['--eps', 'NaN'],
      ['--eps'],
    ])
      expect(() => selfplayPolicyOptions(args)).toThrow();
    expect(normalizeSelfplayPolicy({ activeTrading: undefined }, LEGACY_SELFPLAY_POLICY)).toEqual(
      LEGACY_SELFPLAY_POLICY,
    );
  });
  it.each([
    { field: 'activeTrading', value: true },
    { field: 'tradeProposals', value: 4 },
    { field: 'delta', value: 0 },
    { field: 'eps', value: 0.001 },
  ])(
    'rejects chunks whose $field policy differs from the legacy defaults',
    async ({ field, value }) => {
      const directory = await mkdtemp(join(process.cwd(), 'runs-fit-test-'));
      try {
        await writeFile(join(directory, 'metadata.json'), JSON.stringify(exampleMetadata(0, 2)));
        await writeFile(
          join(directory, 'metadata-2.json'),
          JSON.stringify({
            ...exampleMetadata(2, 2),
            policy: { ...LEGACY_SELFPLAY_POLICY, [field]: value },
          }),
        );
        await writeRows(join(directory, 'positions-0.jsonl'), [exampleRow(0), exampleRow(1)]);
        await writeRows(join(directory, 'positions-2.jsonl'), [exampleRow(2), exampleRow(3)]);
        await expect(fit(exampleFit(directory, join(directory, 'candidate.json')))).rejects.toThrow(
          'Inconsistent policy across metadata chunks',
        );
      } finally {
        await rm(directory, { recursive: true });
      }
    },
  );
  it('normalizes absent historical policy and explicit matching defaults to the same actual policy', async () => {
    const directory = await mkdtemp(join(process.cwd(), 'runs-fit-test-'));
    try {
      const config = {
        weights: FEATURE_NAMES.map(() => 0),
        budget: 24,
        policy: { ...LEGACY_SELFPLAY_POLICY },
      };
      await writeFile(join(directory, 'metadata.json'), JSON.stringify(exampleMetadata(0, 2)));
      await writeFile(
        join(directory, 'metadata-2.json'),
        JSON.stringify({
          ...exampleMetadata(2, 2),
          policy: { ...LEGACY_SELFPLAY_POLICY },
          resolvedConfigurations: selfplayResolvedConfigurations(config),
        }),
      );
      await writeRows(join(directory, 'positions-0.jsonl'), [exampleRow(0), exampleRow(1)]);
      await writeRows(join(directory, 'positions-2.jsonl'), [exampleRow(2), exampleRow(3)]);
      const artifact = await fit(exampleFit(directory, join(directory, 'candidate.json')));
      expect(artifact.provenance.sourceMetadata?.policy).toEqual(LEGACY_SELFPLAY_POLICY);
      expect(artifact.provenance.sourceMetadata?.config).toMatchObject({
        engine: 'planner',
        noise: 0.06,
        randomMove: 0,
        openingTopK: 5,
        setupBudget: 0,
        lookahead: false,
        budget: 24,
      });
    } finally {
      await rm(directory, { recursive: true });
    }
  });
  it('rejects policy metadata that contradicts the actual per-seat configuration', async () => {
    const directory = await mkdtemp(join(process.cwd(), 'runs-fit-test-'));
    try {
      const config = {
        weights: FEATURE_NAMES.map(() => 0),
        budget: 24,
        policy: { ...LEGACY_SELFPLAY_POLICY, activeTrading: true },
      };
      await writeFile(
        join(directory, 'metadata.json'),
        JSON.stringify({
          ...exampleMetadata(0, 2),
          policy: LEGACY_SELFPLAY_POLICY,
          resolvedConfigurations: selfplayResolvedConfigurations(config),
        }),
      );
      await writeRows(join(directory, 'positions-0.jsonl'), [exampleRow(0), exampleRow(1)]);
      await expect(fit(exampleFit(directory, join(directory, 'candidate.json')))).rejects.toThrow(
        'Recorded policy differs from resolved self-play configurations',
      );
    } finally {
      await rm(directory, { recursive: true });
    }
  });
  it.each([
    { field: 'weights', value: FEATURE_NAMES.map(() => 1), error: 'weights differs from metadata' },
    { field: 'budget', value: 25, error: 'budget differs from metadata' },
    { field: 'noise', value: 0.2 },
    { field: 'engine', value: 'greedy' },
    { field: 'engine', value: 'mcts' },
    { field: 'randomMove', value: 0.4 },
    { field: 'setupBudget', value: 512 },
    { field: 'timeLimitMs', value: 3000 },
    { field: 'openingTopK', value: 2 },
    { field: 'lookahead', value: true },
    { field: 'tradeGuards', value: true },
  ])('rejects a resolved seat with altered $field=$value', async ({ field, value, error }) => {
    const directory = await mkdtemp(join(process.cwd(), 'runs-fit-test-'));
    try {
      const metadata = exampleMetadata(0, 2);
      const resolved = selfplayResolvedConfigurations({
        weights: metadata.weights,
        budget: metadata.budget,
      });
      Object.assign(resolved[1].config!, { [field]: value });
      await writeRows(join(directory, 'positions-0.jsonl'), [exampleRow(0), exampleRow(1)]);
      await writeFile(
        join(directory, 'metadata.json'),
        JSON.stringify({
          ...metadata,
          resolvedConfigurations: resolved,
        }),
      );
      await expect(fit(exampleFit(directory, join(directory, 'candidate.json')))).rejects.toThrow(
        error ?? 'Resolved self-play configurations differ across seats',
      );
    } finally {
      await rm(directory, { recursive: true });
    }
  });
  it.each([
    { field: 'noise', value: 0.2 },
    { field: 'engine', value: 'mcts' },
    { field: 'randomMove', value: 0.4 },
    { field: 'setupBudget', value: 512 },
    { field: 'timeLimitMs', value: 3000 },
    { field: 'openingTopK', value: 2 },
    { field: 'lookahead', value: true },
    { field: 'tradeGuards', value: true },
  ])(
    'rejects internally consistent chunks with a different actual $field',
    async ({ field, value }) => {
      const directory = await mkdtemp(join(process.cwd(), 'runs-fit-test-'));
      try {
        const metadata = exampleMetadata(2, 2);
        const resolved = selfplayResolvedConfigurations({
          weights: metadata.weights,
          budget: metadata.budget,
        });
        for (const seat of resolved) Object.assign(seat.config!, { [field]: value });
        await writeRows(join(directory, 'positions-0.jsonl'), [exampleRow(0), exampleRow(1)]);
        await writeRows(join(directory, 'positions-2.jsonl'), [exampleRow(2), exampleRow(3)]);
        await writeFile(join(directory, 'metadata.json'), JSON.stringify(exampleMetadata(0, 2)));
        await writeFile(
          join(directory, 'metadata-2.json'),
          JSON.stringify({
            ...metadata,
            resolvedConfigurations: resolved,
          }),
        );
        await expect(fit(exampleFit(directory, join(directory, 'candidate.json')))).rejects.toThrow(
          'Inconsistent resolved configuration across metadata chunks',
        );
      } finally {
        await rm(directory, { recursive: true });
      }
    },
  );
  it('ignores cosmetic labels and normalizes absent optional config defaults', async () => {
    const directory = await mkdtemp(join(process.cwd(), 'runs-fit-test-'));
    try {
      const metadata = exampleMetadata(0, 2);
      const resolved = selfplayResolvedConfigurations({
        weights: metadata.weights,
        budget: metadata.budget,
      });
      for (let p = 0; p < resolved.length; p++) {
        Object.assign(resolved[p], { name: `label ${p}` });
        Object.assign(resolved[p].config!, {
          name: `config label ${p}`,
          id: p,
          description: `note ${p}`,
        });
        if (p === 1) {
          delete resolved[p].config!.setupBudget;
          delete resolved[p].config!.timeLimitMs;
          delete resolved[p].config!.activeTrading;
          delete resolved[p].config!.tradeProposals;
          delete resolved[p].config!.humanPlayers;
          delete resolved[p].config!.tradeGuards;
        } else {
          resolved[p].config!.timeLimitMs = 0;
        }
      }
      await writeFile(
        join(directory, 'metadata.json'),
        JSON.stringify({
          ...metadata,
          resolvedConfigurations: resolved,
        }),
      );
      await writeRows(join(directory, 'positions-0.jsonl'), [exampleRow(0), exampleRow(1)]);
      const artifact = await fit(exampleFit(directory, join(directory, 'candidate.json')));
      expect(artifact.provenance.sourceMetadata?.config).toMatchObject({
        setupBudget: 0,
        timeLimitMs: 0,
        activeTrading: false,
        tradeProposals: 2,
        humanPlayers: [],
      });
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});

describe('combined generation byte budget', () => {
  it('counts earlier chunks and own buffered writes before accepting a prospective game batch', async () => {
    const directory = await mkdtemp(join(process.cwd(), 'runs-budget-test-'));
    try {
      const ownFile = join(directory, 'positions-10.jsonl');
      await writeFile(join(directory, 'positions-0.jsonl'), 'x'.repeat(40));
      await writeFile(ownFile, 'x'.repeat(10));
      await writeFile(join(directory, 'metadata.json'), 'metadata does not count');
      expect(await rawDirectoryBytes(directory)).toBe(50);
      await expect(checkRawBudget(directory, 100, ownFile, 30, 30)).resolves.toBeUndefined();
      await expect(checkRawBudget(directory, 100, ownFile, 30, 31)).rejects.toThrow(
        'Combined self-play raw data',
      );
      await writeFile(join(directory, 'positions-20.jsonl'), 'x'.repeat(20));
      await expect(checkRawBudget(directory, 100, ownFile, 30, 11)).rejects.toThrow(
        'Combined self-play raw data',
      );
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});

describe('arena reproducibility', () => {
  it('partitions every game exactly once and caps process count', () => {
    const parts = partitions(23, 10),
      games = parts.flatMap((p) => Array.from({ length: p.games }, (_, i) => p.start + i));
    expect(games).toEqual(Array.from({ length: 23 }, (_, i) => i));
    expect(partitions(2, 8)).toEqual([
      { start: 0, games: 1 },
      { start: 1, games: 1 },
    ]);
    expect(() => partitions(10, 11)).toThrow();
    expect(() => partitions(0, 1)).toThrow();
  });
  it('replays game outcomes and samples every pre-roll turn exactly once', () => {
    const entrants = [0, 1, 2].map(() => ({ name: 'greedy' }));
    const captured: number[] = [];
    const first = playGame(0, 873, entrants, (_board, state) => captured.push(state.turn));
    const second = playGame(0, 873, entrants);
    expect(first.winner).toBe(second.winner);
    expect(first.renown).toEqual(second.renown);
    expect(first.actions).toBe(second.actions);
    expect(captured).toEqual(Array.from({ length: first.turns }, (_, i) => i + 1));
    expect(first.turnMs).toHaveLength(first.turns);
    expect(first.decisionMs).toHaveLength(first.actions);
  });
  it('rotates player IDs with independent seeds and reports turn-order counts', () => {
    const rows = [0, 1, 2].map((game) =>
      arenaGame(game, { seed: 553, challenger: { name: 'greedy' }, opponent: { name: 'greedy' } }),
    );
    expect(rows.map((r) => r.seed)).toEqual([553, 554, 555]);
    expect(rows.map((r) => r.challengerSeat)).toEqual([0, 1, 2]);
    const summary = summarizeArena(rows);
    expect(summary.challengerByTurnOrder.reduce((n, r) => n + r.games, 0)).toBe(3);
    expect(summary.byPlayerId.reduce((n, r) => n + r.wins, 0)).toBe(3);
    expect(summary.byTurnOrder.reduce((n, r) => n + r.wins, 0)).toBe(3);
    expect(summary.medianTurns).toBe([...rows].sort((a, b) => a.turns - b.turns)[1].turns);
  });
  it('averages the middle turns for even-sized samples', () => {
    expect(median([1, 7, 4, 2])).toBe(3);
    expect(median([9, 3, 4])).toBe(4);
    expect(median([])).toBe(0);
  });
});
