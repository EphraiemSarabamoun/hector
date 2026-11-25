/** Real Chromium module-worker timing, using naturally reached baseline self-play turns.
 * Run --prepare to create the position corpus; run --sanity for one position;
 * run without flags for the complete 30-position, five-tier benchmark.
 */
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { cpus, loadavg, platform, release } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { createGame, legalActions, serializeState } from '../src/engine/index.js';
import { GreedyBot } from '../src/bots/index.js';
import { applyWithTradeHistory, TIERS } from '../src/ai/index.js';
import type { WorkerDriver } from '../src/ui/driver.js';

interface Position {
  id: number;
  seed: number;
  turn: number;
  player: number;
  sourceMainLegalActions: number;
  serializedTurnStart: string;
  serializedMain: string;
  sourceActions: number;
}
interface TimingRow {
  position: number;
  seed: number;
  turn: number;
  player: number;
  tier: string;
  budget: number;
  tradeGuards: boolean;
  decisionMs: number;
  turnMs: number;
  requests: number;
  mainRequests: number;
  offTurnRequests: number;
  decisionTimesMs: number[];
  mainDecisionTimesMs: number[];
  firstMainLegalActions: number;
  finalPhase: string;
}
interface BrowserHarness {
  run(position: Position, tier: string): Promise<TimingRow>;
  warm(position: Position, tier: string): Promise<number>;
  responsiveness(position: Position): Promise<Record<string, unknown>>;
  dispose(): void;
}

declare global {
  interface Window {
    workerTiming: BrowserHarness;
  }
}
const prefix = process.argv.includes('--sanity')
  ? 'runs/browser-timing-sanity'
  : 'runs/browser-timing';
const corpusPath = 'runs/browser-timing-corpus.json';

/** Keep the first naturally reached main phase at spaced turns, retaining its true roll start.
 * No hands, structures, chance streams or phases are edited to make a timing case.
 */
function generateCorpus(): Position[] {
  const positions: Position[] = [];
  for (let seed = 7301; positions.length < 30 && seed < 7401; seed++) {
    const { board, state } = createGame(seed, 3);
    const bots = Array.from({ length: 3 }, (_, p) => new GreedyBot(`${seed}:timing-source:${p}`));
    const targets = new Set([12, 24, 36, 48, 60]);
    let actions = 0;
    let turnStart = '';
    let capturedRoll = -1;
    while (state.phase !== 'gameOver' && positions.length < 30) {
      if (state.phase === 'roll' && capturedRoll !== state.turn) {
        turnStart = serializeState(state);
        capturedRoll = state.turn;
      }
      if (
        state.phase === 'main' &&
        targets.has(state.turn) &&
        legalActions(board, state).length > 1
      ) {
        positions.push({
          id: positions.length,
          seed,
          turn: state.turn,
          player: state.active,
          sourceMainLegalActions: legalActions(board, state).length,
          serializedTurnStart: turnStart,
          serializedMain: serializeState(state),
          sourceActions: actions,
        });
        targets.delete(state.turn);
      }
      applyWithTradeHistory(
        board,
        state,
        bots[state.toAct].chooseAction(board, state, state.toAct),
      );
      if (++actions > 20000) throw new Error(`Source game ${seed} did not terminate`);
    }
  }
  if (positions.length !== 30) throw new Error(`Only generated ${positions.length} positions`);
  return positions;
}

/** Nearest-rank p95 and conventional median, with raw samples retained for recomputation. */
function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    count: n,
    median: n % 2 ? sorted[Math.floor(n / 2)] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2,
    p95: sorted[Math.ceil(n * 0.95) - 1],
    max: sorted[n - 1],
  };
}
function csv(row: TimingRow): string {
  return (
    [
      row.position,
      row.seed,
      row.turn,
      row.player,
      row.tier,
      row.budget,
      row.tradeGuards,
      row.decisionMs,
      row.turnMs,
      row.requests,
      row.mainRequests,
      row.offTurnRequests,
      row.firstMainLegalActions,
      row.finalPhase,
      JSON.stringify(row.decisionTimesMs),
      JSON.stringify(row.mainDecisionTimesMs),
    ]
      .map((value) => `"${String(value).replaceAll('"', '""')}"`)
      .join(',') + '\n'
  );
}

await mkdir('runs', { recursive: true });
let positions: Position[];
try {
  const saved = JSON.parse(await readFile(corpusPath, 'utf8'));
  if (saved.version !== 2 || process.argv.includes('--prepare'))
    throw new Error('Regenerate corpus');
  positions = saved.positions;
} catch {
  positions = generateCorpus();
}
await writeFile(
  corpusPath,
  JSON.stringify(
    {
      version: 2,
      method:
        'Three seeded GreedyBot seats; first main phase with at least two legal choices at turns12,24,36,48,60; complete unchanged roll-start and main snapshots.',
      positions,
    },
    null,
    2,
  ),
);
if (process.argv.includes('--prepare')) {
  console.log(
    `Prepared ${positions.length} natural turns across ${new Set(positions.map((p) => p.seed)).size} seeds: ${corpusPath}`,
  );
  process.exit(0);
}

// A single owned loopback Vite server and one Chromium page avoid parallel search contention.
const server = await createServer({
  configFile: false,
  server: { host: '127.0.0.1', port: 5184, strictPort: true },
});
await writeFile(
  'runs/browser-timing-harness.html',
  '<!doctype html><title>Worker timing</title><p>Real Chromium worker timing harness</p>',
);
await server.listen();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  // tsx/esbuild names nested functions with this helper; install it in the evaluated realm.
  await page.addInitScript(
    'globalThis.__name = (fn, name) => Object.defineProperty(fn, "name", { value: name, configurable: true });',
  );
  page.setDefaultTimeout(0);
  await page.goto('http://127.0.0.1:5184/runs/browser-timing-harness.html');
  await page.evaluate(async () => {
    const enginePath = '/src/engine/index.ts';
    const driverPath = '/src/ui/driver.ts';
    const aiPath = '/src/ai/index.ts';
    const engine: typeof import('../src/engine/index.js') = await import(enginePath);
    const driversModule: typeof import('../src/ui/driver.js') = await import(driverPath);
    const ai: typeof import('../src/ai/index.js') = await import(aiPath);
    const drivers = new Map<string, WorkerDriver>();
    const boards = new Map<number, ReturnType<typeof engine.generateBoard>>();
    const boardFor = (seed: number) => {
      if (!boards.has(seed)) boards.set(seed, engine.generateBoard(seed));
      return boards.get(seed)!;
    };
    const driverFor = (seed: number, tier: string) => {
      const key = `${seed}:${tier}`;
      if (!drivers.has(key)) {
        for (const prior of drivers.values()) prior.dispose();
        drivers.clear();
        drivers.set(key, new driversModule.WorkerDriver(tier, `${seed}:timing-ai`));
      }
      return drivers.get(key)!;
    };
    window.workerTiming = {
      async warm(position, tier) {
        // A genuine forced roll request loads the module, map and bot without a cached main plan.
        const state = engine.deserializeState(position.serializedTurnStart);
        const start = performance.now();
        await driverFor(position.seed, tier).decide(boardFor(position.seed), state, state.toAct);
        return performance.now() - start;
      },
      async run(position, tier) {
        const board = boardFor(position.seed);
        const state = engine.deserializeState(position.serializedTurnStart);
        const driver = driverFor(position.seed, tier);
        const decisionTimesMs: number[] = [],
          mainDecisionTimesMs: number[] = [];
        let offTurnRequests = 0,
          firstMainLegalActions = 0;
        const start = performance.now();
        while (state.turn === position.turn && state.phase !== 'gameOver') {
          const isMain = state.phase === 'main';
          if (isMain && !mainDecisionTimesMs.length)
            firstMainLegalActions = engine.legalActions(board, state).length;
          const player = state.toAct;
          const before = performance.now();
          const action = await driver.decide(board, state, player);
          const elapsed = performance.now() - before;
          decisionTimesMs.push(elapsed);
          if (isMain) mainDecisionTimesMs.push(elapsed);
          if (player !== position.player) offTurnRequests++;
          // These are actual benchmark turn transitions, so all recipients share public acceptance history.
          ai.applyWithTradeHistory(board, state, action);
          if (decisionTimesMs.length > 200)
            throw new Error(`Turn failed to finish: ${tier}/${position.id}`);
        }
        const turnMs = performance.now() - start;
        if (!mainDecisionTimesMs.length)
          throw new Error(`No main decision: ${tier}/${position.id}`);
        return {
          position: position.id,
          seed: position.seed,
          turn: position.turn,
          player: position.player,
          tier,
          budget: ai.TIERS.find((t) => t.name === tier)!.budget,
          tradeGuards: ai.TIERS.find((t) => t.name === tier)!.tradeGuards === true,
          decisionMs: mainDecisionTimesMs[0],
          turnMs,
          requests: decisionTimesMs.length,
          mainRequests: mainDecisionTimesMs.length,
          offTurnRequests,
          decisionTimesMs,
          mainDecisionTimesMs,
          firstMainLegalActions,
          finalPhase: state.phase,
        };
      },
      async responsiveness(position) {
        for (const prior of drivers.values()) prior.dispose();
        drivers.clear();
        const state = engine.deserializeState(position.serializedMain);
        const board = boardFor(position.seed);
        const driver = new driversModule.WorkerDriver('Hector', `${position.seed}:responsiveness`);
        // Warm map/module first, then observe frames while actual Hector main search is pending.
        const warm = engine.deserializeState(position.serializedTurnStart);
        await driver.decide(board, warm, warm.toAct);
        let running = true,
          frames = 0;
        const frameTimes: number[] = [];
        const tick = (time: number) => {
          if (running) {
            frames++;
            frameTimes.push(time);
            requestAnimationFrame(tick);
          }
        };
        requestAnimationFrame(tick);
        const before = performance.now();
        await driver.decide(board, state, state.toAct);
        const decisionMs = performance.now() - before;
        running = false;
        driver.dispose();
        const cancellationDriver = new driversModule.WorkerDriver(
          'Hector',
          `${position.seed}:cancellation`,
        );
        await cancellationDriver.decide(board, warm, warm.toAct);
        const controller = new AbortController();
        const pending = cancellationDriver
          .decide(board, state, state.toAct, controller.signal)
          .then(
            () => 'resolved',
            (error: Error) => error.name,
          );
        const cancelStart = performance.now();
        setTimeout(() => controller.abort(), 0);
        const cancellationResult = await pending;
        const cancellationMs = performance.now() - cancelStart;
        const recovered = await cancellationDriver.decide(board, warm, warm.toAct);
        cancellationDriver.dispose();
        driver.dispose();
        return {
          framesDuringSearch: frames,
          decisionMs,
          maximumFrameGapMs: Math.max(0, ...frameTimes.slice(1).map((t, i) => t - frameTimes[i])),
          cancellationResult,
          cancellationMs,
          postCancellationAction: recovered.type,
          responsive: frames >= 2,
          cancellationPassed: cancellationResult === 'AbortError' && recovered.type === 'roll',
        };
      },
      dispose() {
        for (const driver of drivers.values()) driver.dispose();
      },
    };
  });
  const selectedTiers = process.argv.includes('--sanity')
    ? TIERS.filter((t) => t.name === 'Hector')
    : TIERS;
  const selectedPositions = process.argv.includes('--sanity') ? positions.slice(0, 1) : positions;
  const rows: TimingRow[] = [],
    warmRequests: { tier: string; seed: number; ms: number }[] = [];
  const warmed = new Set<string>();
  await writeFile(
    `${prefix}.csv`,
    'position,seed,turn,player,tier,budget,trade_guards,first_main_decision_ms,whole_turn_ms,requests,main_requests,off_turn_requests,first_main_legal_actions,final_phase,all_decision_ms_json,main_decision_ms_json\n',
  );
  // Hash measured sources so timing results identify their exact implementation.
  const measuredPaths = [
    'src/ai/index.ts',
    'src/ai/tiers.ts',
    'src/ai/trade.ts',
    'src/ai/trade-history.ts',
    'src/ai/planner.ts',
    'src/ai/mcts.ts',
    'src/ai/placement.ts',
    'src/ai/frontier.ts',
    'src/ai/time.ts',
    'src/ai/features.ts',
    'src/ai/value.ts',
    'src/ai/weights/fitted.json',
    'src/ui/driver.ts',
    'src/ui/worker.ts',
    'src/ui/workerProtocol.ts',
    'src/ui/aiPort.ts',
  ];
  const sourceSha256 = Object.fromEntries(
    await Promise.all(
      measuredPaths.map(async (path) => [
        path,
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      ]),
    ),
  );
  const metadata = {
    sourceSha256,
    startedAt: new Date().toISOString(),
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    mode: 'Vite6 development transform; real Chromium module worker, not production/minified build',
    browserRuntime:
      'Default Chromium launch: no JITless flag, CPU resource limits or page throttling. Published tier budgets and actual worker runtime caps remain enabled.',
    browser: browser.version(),
    node: process.version,
    platform: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    loadAverageAtStart: loadavg(),
    backgroundComputeNote: process.argv.includes('--background-note')
      ? process.argv[process.argv.indexOf('--background-note') + 1]
      : null,
    page: await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
    })),
    corpus: corpusPath,
    tiers: TIERS,
    tradeHistory:
      'All real turn actions use applyWithTradeHistory; serialized aiTradeHistory travels through the actual WorkerDriver. Corpus turn starts precede any acceptance in that individual turn. Warmups only choose a forced roll and never apply it.',
    method:
      'Same30 natural greedy-selfplay roll-start positions for every tier. Worker reused within seed/tier; one forced roll warmup per seed/tier excluded. First main decision includes serialized worker roundtrip. Whole turn runs roll through endTurn/winner, including all pending off-turn choices by that same tier, all worker roundtrips and applyWithTradeHistory transitions. No budget overrides. Median is midpoint; p95 nearest rank.',
  };
  for (const tier of selectedTiers) {
    for (const position of selectedPositions) {
      const key = `${position.seed}:${tier.name}`;
      if (!warmed.has(key)) {
        const ms = await page.evaluate(
          ({ position, tier }) => window.workerTiming.warm(position, tier),
          { position, tier: tier.name },
        );
        warmRequests.push({ tier: tier.name, seed: position.seed, ms });
        warmed.add(key);
      }
      const row = await page.evaluate(
        ({ position, tier }) => window.workerTiming.run(position, tier),
        { position, tier: tier.name },
      );
      rows.push(row);
      await appendFile(`${prefix}.csv`, csv(row));
      await writeFile(
        `${prefix}.partial.json`,
        JSON.stringify({ metadata, warmRequests, rows }, null, 2),
      );
      console.log(
        `${tier.name} ${rows.filter((r) => r.tier === tier.name).length}/${selectedPositions.length}: first main ${row.decisionMs.toFixed(1)}ms, whole turn ${row.turnMs.toFixed(1)}ms`,
      );
    }
  }
  const responsiveness = await page.evaluate(
    (position) => window.workerTiming.responsiveness(position),
    selectedPositions.reduce((a, b) =>
      a.sourceMainLegalActions > b.sourceMainLegalActions ? a : b,
    ),
  );
  const summaries = selectedTiers.map((tier) => {
    const subset = rows.filter((r) => r.tier === tier.name);
    const decisionTarget = tier.name === 'Sarpedon' ? 300 : tier.name === 'Hector' ? 2000 : null;
    const turnTarget = tier.name === 'Hector' ? 6000 : null;
    return {
      tier: tier.name,
      budget: tier.budget,
      tradeGuards: tier.tradeGuards === true,
      positions: subset.length,
      firstMainDecisionMs: summary(subset.map((r) => r.decisionMs)),
      wholeTurnMs: summary(subset.map((r) => r.turnMs)),
      allMainDecisionMs: summary(subset.flatMap((r) => r.mainDecisionTimesMs)),
      allDecisionMs: summary(subset.flatMap((r) => r.decisionTimesMs)),
      decisionTargetMs: decisionTarget,
      firstDecisionTargetMisses:
        decisionTarget === null ? null : subset.filter((r) => r.decisionMs > decisionTarget).length,
      allMainDecisionTargetMisses:
        decisionTarget === null
          ? null
          : subset.flatMap((r) => r.mainDecisionTimesMs).filter((ms) => ms > decisionTarget).length,
      turnTargetMs: turnTarget,
      wholeTurnTargetMisses:
        turnTarget === null ? null : subset.filter((r) => r.turnMs > turnTarget).length,
    };
  });
  await writeFile(
    `${prefix}.json`,
    JSON.stringify(
      {
        metadata,
        finishedAt: new Date().toISOString(),
        loadAverageAtFinish: loadavg(),
        summaries,
        responsiveness,
        warmRequests,
        rows,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ summaries, responsiveness }, null, 2));
  await page.evaluate(() => window.workerTiming.dispose());
} finally {
  await browser.close();
  await server.close();
}
