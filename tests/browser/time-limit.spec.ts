/** Compare exact Hector work with and without its production browser-only deadline. */
import { chromium, expect, test } from '@playwright/test';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpus, loadavg } from 'node:os';
import { build } from 'vite';
import { fixtureSession, giveOldCard, setHand } from './fixtures.js';
import {
  apply,
  Card,
  CARD_COUNT,
  isLegal,
  legalActions,
  serializeState,
  type Action,
} from '../../src/engine/index.js';
import { TIERS } from '../../src/ai/index.js';
import type { DecisionRequest, DecisionResponse } from '../../src/ui/workerProtocol.js';

/** Archives and snapshots without a first commit have no Git HEAD; timing evidence still applies. */
function currentRevision(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** The setup and card population remain legal; bank-supplied goods create a broad late-turn tree.
 * These are explicit stress-fixture edits, separate from the natural timing-table corpus.
 */
function richPosition() {
  const session = fixtureSession();
  session.state.active = session.state.toAct = session.state.turnIndex = 1;
  setHand(session, 1, [30, 30, 0, 0, 0]);
  while (session.state.edgeOwner.filter((owner) => owner === 1).length < 15) {
    const track = legalActions(session.board, session.state).find(
      (action) => action.type === 'buildTrack',
    );
    if (!track) throw new Error('Stress fixture could not extend fifteen legal tracks');
    apply(session.board, session.state, track);
  }
  setHand(session, 1, [12, 12, 0, 0, 0]);
  for (const card of [Card.Caravan, Card.Tithe, Card.Surveyors, Card.Raid]) {
    giveOldCard(session, card);
    session.state.cards[card]--;
    session.state.cards[CARD_COUNT + card]++;
  }
  return session;
}

/** Bundle the same protocol and exact tier, changing only the optional wall clock to disabled.
 * The capped side uses Vite's already-built production worker asset without replacement code.
 */
async function uncappedWorkerBundle(): Promise<string> {
  const entry = 'runs/browser-cap-uncapped-worker.ts';
  await writeFile(
    entry,
    `import { createAIBot } from '../src/ai/index.js';
import { createDecisionComputer } from '../src/ui/workerProtocol.js';
const compute = createDecisionComputer((tier, seed, options) =>
  createAIBot(tier, seed, { ...options, timeLimitMs: 0 }));
globalThis.onmessage = (event) => {
  const start = performance.now();
  const response = compute(event.data);
  globalThis.postMessage({ ...response, workerComputeMs: performance.now() - start });
};
`,
  );
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: true,
      lib: { entry: resolve(entry), formats: ['es'] },
    },
  });
  const outputs = Array.isArray(result)
    ? result.flatMap((r) => r.output)
    : 'output' in result
      ? result.output
      : [];
  const chunk = outputs.find((output) => output.type === 'chunk' && output.isEntry);
  if (!chunk || chunk.type !== 'chunk') throw new Error('Uncapped worker bundle was not generated');
  return chunk.code;
}

test('production Hector deadline binds in a documented JITless browser with unchanged tier budgets', async ({
  baseURL,
}, testInfo) => {
  test.setTimeout(180000);
  await mkdir('runs', { recursive: true });
  const loadAtStart = loadavg();
  const session = richPosition();
  const state = serializeState(session.state);
  const warm = serializeState({ ...session.state, phase: 'roll' });
  const tier = TIERS.find((t) => t.name === 'Hector')!;
  expect(tier.browserTimeLimitMs).toBe(3000);
  const assets = (await readdir('dist/assets')).filter((name) => /^worker-[^.]+\.js$/.test(name));
  expect(assets).toHaveLength(1);
  const workerAsset = `assets/${assets[0]}`;
  const productionCode = await readFile(`dist/${workerAsset}`);
  const uncappedCode = await uncappedWorkerBundle();
  // Use the real production worker in a deliberately slower interpreter-only Chromium.
  // The same exact node budgets run on both sides; only the optional AI wall clock differs.
  const controlledBrowser = await chromium.launch({
    headless: true,
    args: ['--js-flags=--jitless'],
  });
  try {
    const page = await controlledBrowser.newPage();
    await page.goto(baseURL!);
    const timings = await page.evaluate(
      async ({ workerAsset, uncappedCode, state, warm, seed }) => {
        // One request per worker at a time; warm the map/module before recording round-trip latency.
        async function measure(url: string) {
          const worker = new Worker(url, { type: 'module' });
          let nextId = 0;
          let workerComputeMs: number | undefined;
          const decide = (serializedState: string) =>
            new Promise<Action>((resolveAction, reject) => {
              const request: DecisionRequest = {
                requestId: ++nextId,
                boardSeed: seed,
                serializedState,
                player: 1,
                tier: 'Hector',
                botSeed: `${seed}:cap-stress:1`,
              };
              worker.onmessage = (event: MessageEvent<DecisionResponse>) => {
                workerComputeMs = (event.data as DecisionResponse & { workerComputeMs?: number })
                  .workerComputeMs;
                if ('error' in event.data) reject(new Error(event.data.error));
                else resolveAction(event.data.action);
              };
              worker.onerror = (event) => reject(new Error(event.message));
              worker.postMessage(request);
            });
          try {
            await decide(warm);
            const start = performance.now();
            const action = await decide(state);
            return { ms: performance.now() - start, workerComputeMs, action };
          } finally {
            worker.terminate();
          }
        }
        const url = URL.createObjectURL(new Blob([uncappedCode], { type: 'text/javascript' }));
        try {
          const uncapped = await measure(url);
          const capped = await measure(new URL(workerAsset, location.href).href);
          return { uncapped, capped, userAgent: navigator.userAgent };
        } finally {
          URL.revokeObjectURL(url);
        }
      },
      { workerAsset, uncappedCode, state, warm, seed: session.settings.seed },
    );
    const result = {
      controlledRuntime: {
        mechanism: 'Chromium launch argument --js-flags=--jitless',
        jitDisabled: true,
        appliesTo:
          'Only this test-owned Chromium, including dedicated workers; no CPU resource limits or page-only throttle',
        workerComputeClock:
          'Unmodified performance.now() inside dedicated worker around compute(request)',
        note: 'Binding proof applies to this explicitly slower interpreter-only runtime; native fixtures remained below the cap.',
      },
      revision: currentRevision(),
      capturedAt: new Date().toISOString(),
      browser: page.context().browser()!.version(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      loadAtStart,
      loadAtFinish: loadavg(),
      backgroundComputeNote: 'Shared host; other processes may be running; no CPU isolation.',
      fixture: {
        profile: 'fifteen legal paid tracks; four mature playable card kinds; hand=[12,12,0,0,0]',
        source:
          'tests/browser/time-limit.spec.ts richPosition + fixtures.ts legal snake setup/card transfer helpers',
        seed: session.settings.seed,
        serializedState: state,
        legalActions: legalActions(session.board, session.state).length,
        stateSha256: createHash('sha256').update(state).digest('hex'),
      },
      tier,
      capMs: tier.browserTimeLimitMs,
      transportAllowanceMs: 500,
      productionWorker: {
        asset: workerAsset,
        sha256: createHash('sha256').update(productionCode).digest('hex'),
      },
      uncappedWorker: {
        clockOverride: 0,
        sha256: createHash('sha256').update(uncappedCode).digest('hex'),
      },
      ...timings,
      uncappedLegal: isLegal(session.board, session.state, timings.uncapped.action),
      cappedLegal: isLegal(session.board, session.state, timings.capped.action),
    };
    await writeFile('runs/browser-cap-result.json', JSON.stringify(result, null, 2));
    await writeFile('runs/browser-cap-controlled-jitless.json', JSON.stringify(result, null, 2));
    await testInfo.attach('browser-cap-result', {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    });
    expect(result.uncappedLegal).toBe(true);
    expect(result.cappedLegal).toBe(true);
    expect(
      result.uncapped.workerComputeMs ?? result.uncapped.ms,
      'The actual uncapped workload must exceed the browser cap',
    ).toBeGreaterThan(3000);
    expect(
      result.capped.ms,
      'Production worker clock plus bounded cooperative/transport allowance',
    ).toBeLessThanOrEqual(3500);
  } finally {
    await controlledBrowser.close();
  }
});
