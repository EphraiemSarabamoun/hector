/** Tuning protocol tests use synthetic game results; no tuning tournaments run in the test suite. */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { FEATURE_NAMES, FEATURE_SIGNS, projectWeights } from '../src/ai/features.js';
import { W0 } from '../src/ai/value.js';
import { tierByName } from '../src/ai/tiers.js';
import { playGame } from '../tools/ai-common.js';
import {
  TUNE_POLICY,
  validateScales,
  gaussianStream,
  sampleCandidates,
  eliteMean,
  seedBase,
  tuningMatch,
  evaluateSlice,
  batchSummary,
  gateAccepted,
  runTuning,
  validateStartingGate,
  outputPath,
  type Model,
  type Candidate,
  type EvaluationBatch,
  type BatchResult,
  type TuneConfig,
} from '../tools/tune.js';
const scales = FEATURE_NAMES.map(() => 1);
const policy = { ...tierByName('Aeneas'), humanPlayers: [], weights: [...W0] };
const baseline: Model = { id: 'w0', weights: [...W0] };
const fitted: Model = {
  id: 'tested-fit',
  weights: projectWeights(W0.map((value, i) => value + (i === 11 ? 0.1 : 0))),
};
function startGate(model = fitted) {
  return {
    games: 600,
    challenger: { games: 600, wins: 250 },
    config: { humanChallenger: false },
    resolvedConfigurations: {
      challenger: { name: 'Aeneas', config: { ...policy, weights: model.weights } },
      opponent: { name: 'Aeneas', config: { ...policy, weights: W0 } },
    },
  };
}
function batch(kind: EvaluationBatch['kind'] = 'iteration'): EvaluationBatch {
  return {
    kind,
    index: 0,
    candidates: kind === 'iteration' ? sampleCandidates(W0, scales, 0.15, 7) : [fitted],
    incumbent: baseline,
    pool: [baseline, { id: 'earlier-accepted', weights: [...fitted.weights] }],
    policy,
    randomSeed: 123,
    seedBase: seedBase(kind, 0),
    games: kind === 'iteration' ? 120 : 600,
    processes: 2,
    deadline: 1_000_000,
  };
}
function result(
  input: EvaluationBatch,
  wins: (candidate: number) => number = () => 250,
): BatchResult {
  const rows = Array.from({ length: input.candidates.length * input.games }, (_, flat) => {
    const match = tuningMatch(input, flat);
    const winner =
      match.game < wins(match.candidate) ? match.challengerSeat : (match.challengerSeat + 1) % 3;
    return {
      flat,
      candidate: match.candidate,
      game: match.game,
      seed: match.seed,
      challengerSeat: match.challengerSeat,
      incumbentSeat: match.incumbentSeat,
      poolModel: match.poolModel,
      winner,
      winnerTurnPosition: winner,
      turnOrder: [0, 1, 2],
      turns: 10,
      capped: false,
      completed: true,
    };
  });
  return { rows, completed: true };
}
function config(overrides: Partial<TuneConfig> = {}): TuneConfig {
  return {
    initial: baseline,
    scales,
    policy,
    randomSeed: 123,
    processes: 2,
    out: 'runs/mock-tune.json',
    minutes: 90,
    finalReserveMinutes: 15,
    maxIterations: 10,
    ...overrides,
  };
}
const noWrites = { now: () => 0, saveBatch: async () => {}, saveArtifact: async () => {} };
afterEach(() => vi.restoreAllMocks());

describe('seeded RMS exploration and constraints', () => {
  it('has reproducible approximately unit Gaussian draws without nonfinite endpoints', () => {
    const first = gaussianStream('gaussian'),
      second = gaussianStream('gaussian');
    const draws = Array.from({ length: 20000 }, () => first());
    expect(draws.slice(0, 50)).toEqual(Array.from({ length: 50 }, () => second()));
    const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
    const variance = draws.reduce((a, b) => a + (b - mean) ** 2, 0) / draws.length;
    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(variance).toBeGreaterThan(0.95);
    expect(variance).toBeLessThan(1.05);
    expect(draws.every(Number.isFinite)).toBe(true);
  });
  it('projects each offspring and records correctly rescaled coordinates', () => {
    const unequal = scales.map((_, i) => i + 1),
      mean = scales.map(() => 0);
    const candidates = sampleCandidates(mean, unequal, 0.15, 'fixed');
    expect(candidates).toEqual(sampleCandidates(mean, unequal, 0.15, 'fixed'));
    expect(candidates).toHaveLength(16);
    for (const c of candidates)
      for (let j = 0; j < FEATURE_NAMES.length; j++) {
        expect(c.rms[j]).toBe(c.weights[j] * unequal[j]);
        if (FEATURE_SIGNS[j] === 1) expect(c.weights[j]).toBeGreaterThanOrEqual(0);
        if (FEATURE_SIGNS[j] === -1) expect(c.weights[j]).toBeLessThanOrEqual(0);
      }
    expect(candidates[0].weights).not.toBe(candidates[1].weights);
    expect(validateScales(scales)).toEqual(scales);
    for (const invalid of [
      [],
      scales.slice(1),
      scales.map((x, i) => (i ? x : 0)),
      scales.map((x, i) => (i ? x : NaN)),
      Array(49),
    ])
      expect(() => validateScales(invalid)).toThrow();
  });
  it('uses top-four RMS means with stable candidate-index tie breaking', () => {
    const candidates: Candidate[] = Array.from({ length: 16 }, (_, index) => ({
      id: String(index),
      index,
      weights: scales.map(() => 0),
      rms: scales.map(() => index),
    }));
    expect(
      eliteMean(
        candidates,
        scales.slice(0, 16).map(() => 1),
      ),
    ).toEqual(scales.map(() => 1.5));
    expect(
      eliteMean(
        candidates,
        Array.from({ length: 16 }, (_, i) => i),
      ),
    ).toEqual(scales.map(() => 13.5));
    expect(() => eliteMean(candidates, [1])).toThrow();
  });
});

describe('common-seed mixed opponents', () => {
  it('explicitly disables browser decision caps for every experimental entrant', () => {
    const input = batch();
    input.policy = { ...input.policy, timeLimitMs: 3000 };
    expect(
      tuningMatch(input, 0).entrants.every((entry) => entry.overrides?.timeLimitMs === 0),
    ).toBe(true);
  });
  it('rotates challenger IDs and gives every candidate identical rival models on the same 120 seeds', () => {
    const input = batch(),
      counts = [0, 0, 0],
      poolIds = new Set<string>();
    for (let game = 0; game < 120; game++) {
      const a = tuningMatch(input, game),
        b = tuningMatch(input, 120 + game);
      counts[a.challengerSeat]++;
      poolIds.add(a.poolModel);
      expect(a.seed).toBe(b.seed);
      expect(a.challengerSeat).toBe(b.challengerSeat);
      expect(a.poolModel).toBe(b.poolModel);
      expect(a.incumbentSeat).toBe(b.incumbentSeat);
      for (let p = 0; p < 3; p++)
        if (p !== a.challengerSeat) expect(a.entrants[p]).toEqual(b.entrants[p]);
      expect(a.entrants[a.incumbentSeat].overrides!.weights).toEqual(input.incumbent.weights);
      expect(
        a.entrants.every(
          (e) =>
            e.name === 'Aeneas' &&
            e.overrides!.budget === policy.budget &&
            e.overrides!.humanPlayers!.length === 0,
        ),
      ).toBe(true);
    }
    expect(counts).toEqual([40, 40, 40]);
    expect(poolIds).toEqual(new Set(['w0', 'earlier-accepted']));
    expect(tuningMatch(input, 0).entrants[0].overrides!.weights).not.toBe(
      input.candidates[0].weights,
    );
  });
  it('keeps iteration, checkpoint and final ranges disjoint and uses two fixed checkpoint opponents', () => {
    const ranges = [
      ['iteration', 0, 120],
      ['iteration', 1, 120],
      ['checkpoint', 0, 600],
      ['checkpoint', 1, 600],
      ['final', 0, 600],
    ] as const;
    const seen = new Set<number>();
    for (const [kind, index, count] of ranges)
      for (let game = 0; game < count; game++) {
        const seed = seedBase(kind, index) + game;
        expect(seen.has(seed)).toBe(false);
        seen.add(seed);
      }
    const input = batch('checkpoint');
    for (let game = 0; game < 3; game++) {
      const match = tuningMatch(input, game);
      for (let p = 0; p < 3; p++)
        if (p !== match.challengerSeat)
          expect(match.entrants[p].overrides!.weights).toEqual(input.incumbent.weights);
    }
    expect(() => seedBase('iteration', 2000)).toThrow();
  });
});

describe('deadlines and trustworthy gates', () => {
  it('stops before a decision and discards a decision that returns after its deadline', () => {
    const entrants = [{ name: 'greedy' }, { name: 'greedy' }, { name: 'greedy' }];
    const expired = playGame(0, 11, entrants, undefined, 0);
    expect(expired.completed).toBe(false);
    expect(expired.actions).toBe(0);
    expect(expired.winner).toBe(-1);
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(2);
    const late = playGame(0, 11, entrants, undefined, 1);
    expect(late.completed).toBe(false);
    expect(late.actions).toBe(0);
    const input = batch();
    expect(evaluateSlice(input, 0, 120, () => input.deadline)).toEqual({
      rows: [],
      completed: false,
    });
  });
  it('distinguishes a point-parity checkpoint from the stronger final gate and rejects partial or duplicated results', () => {
    const input = batch('checkpoint');
    const atParity = batchSummary(
      input,
      result(input, () => 200),
    );
    expect(gateAccepted(atParity)).toBe(false);
    const marginal = batchSummary(
      input,
      result(input, () => 201),
    );
    expect(gateAccepted(marginal)).toBe(true);
    expect(gateAccepted(marginal, true)).toBe(false);
    const strong = batchSummary(
      input,
      result(input, () => 250),
    );
    expect(gateAccepted(strong, true)).toBe(true);
    const partial = result(input, () => 600);
    partial.rows[0].completed = false;
    expect(gateAccepted(batchSummary(input, partial), true)).toBe(false);
    const duplicate = result(input);
    duplicate.rows[1] = { ...duplicate.rows[0] };
    expect(() => batchSummary(input, duplicate)).toThrow();
  });
  it('requires starting-fit evidence for exact weights, policy, sample size and Wilson margin', () => {
    expect(() => validateStartingGate(W0, undefined, policy)).not.toThrow();
    expect(() => validateStartingGate(fitted.weights, startGate(), policy)).not.toThrow();
    expect(() => validateStartingGate(fitted.weights, undefined, policy)).toThrow();
    expect(() =>
      validateStartingGate(
        fitted.weights,
        { ...startGate(), challenger: { games: 600, wins: 201 } },
        policy,
      ),
    ).toThrow();
    const wrong = startGate();
    wrong.resolvedConfigurations.opponent.config.weights = fitted.weights;
    expect(() => validateStartingGate(fitted.weights, wrong, policy)).toThrow();
    const wrongPolicy = startGate();
    wrongPolicy.resolvedConfigurations.challenger.config.budget++;
    expect(() => validateStartingGate(fitted.weights, wrongPolicy, policy)).toThrow();
    const capped = startGate();
    Object.assign(capped.resolvedConfigurations.challenger.config, { timeLimitMs: 3000 });
    expect(() => validateStartingGate(fitted.weights, capped, policy)).toThrow();
    const explicitOff = startGate();
    for (const seat of Object.values(explicitOff.resolvedConfigurations))
      Object.assign(seat.config, { timeLimitMs: 0 });
    expect(() => validateStartingGate(fitted.weights, explicitOff, policy)).not.toThrow();
  });
});

describe('bounded tuning orchestration without game jobs', () => {
  it('reverts and halves sigma after failed gates and stops after two consecutive failures', async () => {
    const calls: EvaluationBatch[] = [];
    const artifact = await runTuning(config(), {
      ...noWrites,
      evaluate: async (input) => {
        calls.push(input);
        return result(input, () => (input.kind === 'iteration' ? 60 : 200));
      },
    });
    expect(calls.filter((c) => c.kind === 'iteration')).toHaveLength(10);
    expect(calls.filter((c) => c.kind === 'checkpoint')).toHaveLength(2);
    const detail = artifact.provenance as any;
    expect(detail.gates.map((g: any) => g.sigma)).toEqual([0.15, 0.075]);
    expect(detail.gates.every((g: any) => !g.accepted)).toBe(true);
    expect(detail.stopReason).toBe('two consecutive failed checkpoint gates');
    expect(detail.fallback).toBe(true);
    expect(artifact.weights).toEqual(W0);
    expect(detail.iterations[5].incumbent.weights).toEqual(W0);
  });
  it('ships only the last accepted checkpoint after a fresh final W0 gate, ignoring later rejected means', async () => {
    const artifact = await runTuning(config(), {
      ...noWrites,
      evaluate: async (input) =>
        result(input, () =>
          input.kind === 'checkpoint'
            ? input.index === 0
              ? 201
              : 200
            : input.kind === 'final'
              ? 250
              : 60,
        ),
    });
    const detail = artifact.provenance as any;
    expect(detail.gates.map((g: any) => g.accepted)).toEqual([true, false]);
    expect(detail.fallback).toBe(false);
    expect(artifact.weights).toEqual(detail.gates[0].candidate.weights);
    expect(detail.finalGate.summary.candidates[0].games).toBe(600);
    expect(detail.seedRanges.at(-1)).toMatchObject({
      kind: 'final',
      start: 6_000_000,
      endExclusive: 6_000_600,
    });
  });
  it('returns explicit W0 fallback when the final gate fails or is incomplete', async () => {
    for (const incomplete of [false, true]) {
      const artifact = await runTuning(
        config({ initial: fitted, startGate: startGate(), maxIterations: 0 }),
        {
          ...noWrites,
          evaluate: async (input) => {
            const rows = result(input, () => (incomplete ? 600 : 201));
            if (incomplete) rows.rows[0].completed = false;
            return rows;
          },
        },
      );
      expect(artifact.id).toBe('w0-fallback');
      expect(artifact.weights).toEqual(W0);
      expect(artifact.provenance.fallback).toBe(true);
    }
  });
  it('reserves final-gate time inside the overall deadline and never writes outside runs', async () => {
    const starts: number[] = [];
    const artifact = await runTuning(
      config({
        initial: fitted,
        startGate: startGate(),
        startedAt: 0,
        minutes: 20,
        finalReserveMinutes: 15,
      }),
      {
        ...noWrites,
        now: () => 6 * 60000,
        evaluate: async (input) => {
          starts.push(input.deadline);
          return result(input, () => 250);
        },
      },
    );
    expect(starts).toEqual([20 * 60000]);
    expect(artifact.provenance.stopReason).toBe('final-gate reserve');
    expect(() => outputPath('outside.json')).toThrow();
    expect(() => outputPath('runs/../outside.json')).toThrow();
    await expect(runTuning(config({ minutes: 91 }), noWrites)).rejects.toThrow();
    await expect(runTuning(config({ processes: 11 }), noWrites)).rejects.toThrow();
  });
});
