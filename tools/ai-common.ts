/** Node-only tournament helpers: reproducible jobs, bounded processes and file-safe output. */
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { CONFIG, createGame, renown } from '../src/engine/index.js';
import { createBot, type Bot } from '../src/bots/index.js';
import { applyWithTradeHistory, createAIBot, tierByName } from '../src/ai/index.js';
import { TraderBot, TRADER_POLICY, traderBaseConfig } from './trader.js';
import { FEATURE_NAMES } from '../src/ai/features.js';
import type { SearchConfig } from '../src/ai/tiers.js';

export type BotOptions = Partial<SearchConfig>;
export interface Entrant {
  name: string;
  overrides?: BotOptions;
  /** Trader delegates non-proposal decisions to this ordinary tier. */
  normalBase?: string;
}
export interface PlayedGame {
  /** False only when a caller's cooperative deadline interrupts the game. */
  completed?: boolean;
  game: number;
  seed: number;
  winner: number;
  winnerTurnPosition: number;
  turnOrder: number[];
  turns: number;
  capped: boolean;
  actions: number;
  renown: number[];
  bots: string[];
  decisionMs: number[];
  turnMs: number[];
  decisionMsByPlayer: number[][];
  turnMsByPlayer: number[][];
}
/** Baselines and search players use private streams, independent of the game's RNG. */
export function makeBot(
  entrant: Entrant,
  seed: number | string,
  partnerConfig?: (to: number) => SearchConfig,
): Bot {
  if (entrant.name.toLowerCase() === 'trader')
    return new TraderBot(
      entrant.normalBase ?? 'Aeneas',
      seed,
      { ...entrant.overrides, timeLimitMs: 0 },
      partnerConfig,
    );
  return ['random', 'greedy'].includes(entrant.name.toLowerCase())
    ? createBot(entrant.name.toLowerCase(), seed)
    : createAIBot(entrant.name, seed, resolvedTierConfig(entrant)!);
}
/** Resolve only public policies and weights; no controller or private random stream is consulted. */
export function resolvedTierConfig(entrant: Entrant): SearchConfig | null {
  if (['random', 'greedy'].includes(entrant.name.toLowerCase())) return null;
  if (entrant.name.toLowerCase() === 'trader')
    return traderBaseConfig(entrant.normalBase ?? 'Aeneas', {
      ...entrant.overrides,
      timeLimitMs: 0,
    });
  const name =
    entrant.name.toLowerCase() === 'trader' ? (entrant.normalBase ?? 'Aeneas') : entrant.name;
  // Measurement tools always use fixed work budgets; browser timing metadata is opt-in elsewhere.
  return { ...tierByName(name), humanPlayers: [], ...entrant.overrides, timeLimitMs: 0 };
}
/** Record the actual normal policy and the proxy's extra search, rather than calling Trader a tier. */
export function resolvedEntrant(entrant: Entrant) {
  const config = resolvedTierConfig(entrant);
  if (!config) return { ...entrant };
  return entrant.name.toLowerCase() === 'trader'
    ? {
        name: 'Trader',
        normalBase: tierByName(entrant.normalBase ?? 'Aeneas').name,
        baseConfig: config,
        trader: TRADER_POLICY,
      }
    : { name: entrant.name, config };
}
/** Measure decisions and complete turns; capture positions exactly once before each roll. */
export function playGame(
  game: number,
  seed: number,
  entrants: readonly Entrant[],
  onTurn?: (
    board: ReturnType<typeof createGame>['board'],
    state: ReturnType<typeof createGame>['state'],
  ) => void,
  deadline?: number,
): PlayedGame {
  const { board, state } = createGame(seed, entrants.length);
  const configs = entrants.map(resolvedTierConfig);
  const bots = entrants.map((e, p) =>
    makeBot(e, `${seed}:bot:${p}`, (to) => {
      const config = configs[to];
      if (!config)
        throw new Error(
          'Trader partner models require tier opponents; random/greedy have distinct baseline answer policies',
        );
      return config;
    }),
  );
  const turnOrder = Array.from(state.turnOrder);
  const decisionMs: number[] = [],
    turnMs: number[] = [];
  const decisionMsByPlayer = bots.map(() => [] as number[]),
    turnMsByPlayer = bots.map(() => [] as number[]);
  let actions = 0,
    capped = false,
    captured = -1,
    turn = state.turn,
    turnTime = 0,
    active = state.active;
  while (state.phase !== 'gameOver') {
    if (deadline !== undefined && Date.now() >= deadline) break;
    if (state.phase === 'roll' && captured !== state.turn) {
      captured = state.turn;
      onTurn?.(board, state);
    }
    const p = state.toAct;
    const start = performance.now();
    const action = bots[p].chooseAction(board, state, p);
    // A synchronous search cannot be interrupted safely. Discard a late decision
    // rather than letting a game completed after the cutoff count toward a gate.
    if (deadline !== undefined && Date.now() >= deadline) break;
    const elapsed = performance.now() - start;
    decisionMs.push(elapsed);
    decisionMsByPlayer[p].push(elapsed);
    if (state.turn > 0) turnTime += elapsed;
    const events = applyWithTradeHistory(board, state, action);
    capped ||= events.some((e) => e.type === 'winner' && e.reason === 'turnCap');
    actions++;
    if (state.turn !== turn || state.winnerId >= 0) {
      if (turn > 0) {
        turnMs.push(turnTime);
        turnMsByPlayer[active].push(turnTime);
      }
      turn = state.turn;
      turnTime = 0;
      active = state.active;
    }
  }
  return {
    completed: state.phase === 'gameOver' && (deadline === undefined || Date.now() < deadline),
    game,
    seed,
    winner: state.winnerId,
    winnerTurnPosition: turnOrder.indexOf(state.winnerId),
    turnOrder,
    turns: state.turn,
    capped,
    actions,
    renown: bots.map((_, p) => renown(board, state, p)),
    bots: bots.map((b) => b.name),
    decisionMs,
    turnMs,
    decisionMsByPlayer,
    turnMsByPlayer,
  };
}
/** Split contiguous game IDs without overlaps, independent of process completion order. */
export function partitions(games: number, processes: number): { start: number; games: number }[] {
  if (
    !Number.isInteger(games) ||
    games < 1 ||
    !Number.isInteger(processes) ||
    processes < 1 ||
    processes > 10
  )
    throw new Error('games must be positive and processes must be 1..10');
  let start = 0;
  return Array.from({ length: Math.min(games, processes) }, (_, i) => {
    const count =
      Math.floor(games / Math.min(games, processes)) +
      Number(i < games % Math.min(games, processes));
    const part = { start, games: count };
    start += count;
    return part;
  });
}
/** Pass structured worker input as one argument, retaining stderr on failed child processes. */
export async function runWorker<T>(script: string, config: unknown): Promise<T> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', script, '--worker-config', JSON.stringify(config)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '',
      errors = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      errors = (errors + chunk).slice(-20000);
      process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`Worker exited ${code}: ${errors}`));
      else {
        try {
          resolveResult(JSON.parse(output));
        } catch {
          reject(new Error(`Invalid worker result: ${output.slice(-1000)} ${errors}`));
        }
      }
    });
  });
}
export function isMain(url: string): boolean {
  return !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(url);
}
export function option(args: string[], name: string, fallback?: string): string | undefined {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
}
export function integerOption(args: string[], name: string, fallback: number): number {
  const value = Number(option(args, name, String(fallback)));
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}
export async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}
/** Honor stream backpressure instead of buffering an entire training generation. */
export async function writeLine(stream: Writable, line: string): Promise<void> {
  if (!stream.write(line + '\n')) await once(stream, 'drain');
}
export async function finishStream(stream: Writable): Promise<void> {
  stream.end();
  await once(stream, 'finish');
}
/** Accept raw arrays or provenance-bearing weight artifacts. */
export async function readWeights(path: string): Promise<number[]> {
  const json = JSON.parse(await readFile(path, 'utf8'));
  const weights = Array.isArray(json) ? json : json.weights;
  if (
    !Array.isArray(weights) ||
    weights.length !== FEATURE_NAMES.length ||
    weights.some((x: unknown) => typeof x !== 'number' || !Number.isFinite(x))
  )
    throw new Error(`Invalid weights in ${path}`);
  if (
    json.featureNames &&
    (json.featureNames.length !== FEATURE_NAMES.length ||
      json.featureNames.some((name: unknown, i: number) => name !== FEATURE_NAMES[i]))
  )
    throw new Error(`Feature ordering mismatch in ${path}`);
  return weights;
}
export async function entrantOptions(args: string[], prefix: string): Promise<BotOptions> {
  const overrides: BotOptions = {};
  const engine = option(args, `--${prefix}-engine`);
  if (engine) {
    if (!['greedy', 'planner', 'mcts'].includes(engine)) throw new Error('Invalid engine');
    overrides.engine = engine as SearchConfig['engine'];
  }
  const budget = option(args, `--${prefix}-budget`);
  if (budget) {
    const value = Number(budget);
    if (!Number.isInteger(value) || value < 1) throw new Error('Budget must be positive');
    overrides.budget = value;
  }
  const setupBudget = option(args, `--${prefix}-setup-budget`);
  if (setupBudget) {
    const value = Number(setupBudget);
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error('Setup budget must be nonnegative');
    overrides.setupBudget = value;
  }
  const lookahead = option(args, `--${prefix}-lookahead`);
  if (lookahead) {
    if (!['true', 'false'].includes(lookahead)) throw new Error('Lookahead must be true or false');
    overrides.lookahead = lookahead === 'true';
  }
  const weights = option(args, `--${prefix}-weights`);
  if (weights) overrides.weights = await readWeights(weights);
  const activeTrading = option(args, `--${prefix}-active-trading`);
  if (activeTrading !== undefined) {
    if (!['true', 'false'].includes(activeTrading))
      throw new Error('Active trading must be true or false');
    overrides.activeTrading = activeTrading === 'true';
  }
  const proposals = option(args, `--${prefix}-trade-proposals`);
  const tradeGuardsFlag = `--${prefix}-trade-guards`;
  if (args.includes(tradeGuardsFlag)) {
    const tradeGuards = option(args, tradeGuardsFlag);
    if (tradeGuards !== 'true' && tradeGuards !== 'false')
      throw new Error('Trade guards must be true or false');
    overrides.tradeGuards = tradeGuards === 'true';
  }
  if (proposals !== undefined) {
    const value = Number(proposals);
    if (!Number.isInteger(value) || value < 1 || value > CONFIG.trade.maxProposals)
      throw new Error('Trade proposals must be 1..4');
    overrides.tradeProposals = value;
  }
  const delta = option(args, `--${prefix}-delta`);
  if (delta !== undefined) {
    const value = Number(delta);
    if (!Number.isFinite(value) || value < 0)
      throw new Error('Delta must be nonnegative and finite');
    overrides.delta = value;
  }
  return overrides;
}
/** Nearest-rank percentile, with zero for an empty sample. */
export function percentile(values: readonly number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}
export function timingSummary(values: readonly number[]) {
  return { count: values.length, median: percentile(values, 0.5), p95: percentile(values, 0.95) };
}
