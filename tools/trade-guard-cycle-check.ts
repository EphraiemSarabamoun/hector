/** Exhaust the fixed saved positions against local AI. Importing this CLI runs no check. */
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  CARD_COUNT,
  CONFIG,
  GOOD_COUNT,
  Card,
  cloneState,
  deserializeState,
  generateBoard,
  handSize,
  isLegal,
  legalActions,
  renown,
  serializeState,
  stateHash,
  type Action,
  type Board,
  type GameState,
} from '../src/engine/index.js';
import {
  TIERS,
  acceptedTradeProposers,
  acceptsTrade,
  applyWithTradeHistory,
  assessTrade,
  evaluate,
  proposeTrade,
  type SearchConfig,
  type TradeAssessment,
} from '../src/ai/index.js';

const WORKTREE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIRECTORY = resolve(WORKTREE, 'runs/trade-guard-cycle');
const CORPUS_PATH = resolve(WORKTREE, 'tests/fixtures/trade-positions.json');
const CORPUS_SHA256 = '1047db8ff5ba456a3e057bf0c12506bf7056819d6835d412d69cc0bb24f46890';
const GUARDED_TIERS = new Set(['Aeneas', 'Sarpedon', 'Hector']);
const LEGACY_POSITIONS_WITH_CYCLE: Record<string, number> = {
  Astyanax: 12,
  Paris: 12,
  Aeneas: 9,
  Sarpedon: 9,
  Hector: 7,
};
const LEGACY_TWO_LEG_MAXIMUM: Record<string, number> = {
  Astyanax: 2,
  Paris: 2,
  Aeneas: 4,
  Sarpedon: 4,
  Hector: 4,
};
type Offer = Extract<Action, { type: 'proposeTrade' }>;
interface Position {
  seed: number;
  board: Board;
  state: GameState;
}

function requireThat(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Only contexts and owned output names vary; the corpus, sample size, branches and RNG seeds never do. */
function options(args: string[]) {
  const parsed = new Map<string, string>();
  const allowed = new Set(['--human', '--guarded', '--out', '--failures']);
  requireThat(args.length % 2 === 0, 'Each CLI flag requires a value');
  for (let i = 0; i < args.length; i += 2) {
    requireThat(
      allowed.has(args[i]) && !parsed.has(args[i]),
      `Unknown or repeated flag ${args[i]}`,
    );
    parsed.set(args[i], args[i + 1]);
  }
  const boolean = (key: string, fallback: string) => {
    const value = parsed.get(key) ?? fallback;
    requireThat(value === 'true' || value === 'false', `${key} must be true or false`);
    return value === 'true';
  };
  const human = boolean('--human', 'false'),
    guarded = boolean('--guarded', 'true');
  const label = `${human ? 'human' : 'normal'}-${guarded ? 'guarded' : 'legacy'}`;
  const destination = (key: string, extension: string) => {
    const path = resolve(parsed.get(key) ?? resolve(OUTPUT_DIRECTORY, `${label}${extension}`));
    requireThat(
      dirname(path) === OUTPUT_DIRECTORY,
      `${key} must name a direct file under runs/trade-guard-cycle/`,
    );
    return path;
  };
  const out = destination('--out', '.json'),
    failures = destination('--failures', '.failures.jsonl');
  requireThat(out !== failures, 'Report and witness/failure stream must be distinct files');
  return { human, guarded, out, failures };
}

/** Independently reproduce the original recursive 55-bundle ordering, rather than relying on AI enumeration. */
function bundles(): number[][] {
  const result: number[][] = [],
    vector = Array<number>(GOOD_COUNT).fill(0);
  const visit = (remaining: number, index: number) => {
    if (index === GOOD_COUNT - 1) {
      vector[index] = remaining;
      result.push([...vector]);
      return;
    }
    for (let n = 0; n <= remaining; n++) {
      vector[index] = n;
      visit(remaining - n, index + 1);
    }
  };
  for (let size = 1; size <= 3; size++) visit(size, 0);
  requireThat(result.length === 55, 'Expected the original 55 one-to-three-unit bundles');
  return result;
}

/** Every legal disjoint 1..3-for-1..3 offer to both rivals; no AI proposal heuristic filters this search. */
function* offers(board: Board, state: GameState, vectors: readonly number[][]): Generator<Offer> {
  for (let to = 0; to < 3; to++)
    if (to !== state.active) {
      for (const give of vectors) {
        if (give.some((n, g) => n > state.hands[state.active * GOOD_COUNT + g])) continue;
        for (const get of vectors) {
          if (get.some((n, g) => (n > 0 && give[g] > 0) || n > state.hands[to * GOOD_COUNT + g]))
            continue;
          const offer: Offer = { type: 'proposeTrade', to, give, get };
          if (isLegal(board, state, offer)) yield offer;
        }
      }
    }
}

/** Reconstruct maps for saved seeds only. No self-play, position generation, sampling or corpus rewrite is permitted. */
function loadPositions(): Position[] {
  const raw = readFileSync(CORPUS_PATH);
  requireThat(
    sha256(raw) === CORPUS_SHA256,
    'Saved position corpus SHA256 mismatch; never regenerate a replacement',
  );
  const corpus = JSON.parse(raw.toString('utf8')) as { seed: number; state: string }[];
  requireThat(
    Array.isArray(corpus) && corpus.length === 200,
    'Exactly the fixed saved 200 positions are required',
  );
  const boards = new Map<number, Board>();
  return corpus.map((row, index) => {
    requireThat(
      Number.isSafeInteger(row.seed) && typeof row.state === 'string',
      `Malformed corpus row ${index}`,
    );
    let board = boards.get(row.seed);
    if (!board) {
      board = generateBoard(row.seed);
      boards.set(row.seed, board);
    }
    const state = deserializeState(row.state);
    requireThat(
      state.players === 3 &&
        state.phase === 'main' &&
        state.active === state.toAct &&
        state.winnerId < 0,
      `Unexpected corpus phase/players at ${index}`,
    );
    return { seed: row.seed, board, state };
  });
}

/** Retain the independent generous finishing bound, intentionally overestimating future resources. */
function independentUpper(board: Board, state: GameState, player: number): number {
  const mature = (card: number) =>
    state.cards[player * CARD_COUNT + card] > state.freshCards[player * CARD_COUNT + card];
  const free = state.played
    ? 0
    : Math.max(mature(Card.Caravan) ? 2 : 0, mature(Card.Tithe) ? 2 * (state.players - 1) : 0);
  const futureTrades = 2 * Math.max(0, 4 - state.proposals),
    plunder = 2;
  return (
    renown(board, state, player) +
    Math.floor((handSize(state, player) + free + futureTrades + plunder) / 2) +
    (state.warlord === player ? 0 : 2)
  );
}

/** Actual accepted-history branches cross all public transport forms before further accepted responses are explored. */
function transportedBranch(board: Board, state: GameState, proposer: number): GameState {
  const expected = JSON.stringify(acceptedTradeProposers(board, state));
  requireThat(
    acceptedTradeProposers(board, state).includes(proposer),
    'Real acceptance did not record the proposer',
  );
  const variants = [
    cloneState(state),
    structuredClone(state),
    deserializeState(serializeState(state)),
  ];
  for (const variant of variants)
    requireThat(
      JSON.stringify(acceptedTradeProposers(board, variant)) === expected,
      'Accepted public history was lost across a state transport',
    );
  // Use a worker-style clone followed by portable serialization for actual second-leg branches.
  const branch = deserializeState(serializeState(structuredClone(cloneState(state))));
  requireThat(
    JSON.stringify(acceptedTradeProposers(board, branch)) === expected,
    'Composed state transports lost accepted public history',
  );
  return branch;
}

/** Run one all-tier corpus pass. Expected legacy farming witnesses are evidence, not invariant violations. */
function main() {
  requireThat(resolve(process.cwd()) === WORKTREE, 'Run from the repository root');
  const cli = options(process.argv.slice(2)),
    vectors = bundles(),
    positions = loadPositions();
  const frozen = JSON.parse(
    readFileSync(resolve(WORKTREE, 'tests/fixtures/tier-configs.json'), 'utf8'),
  );
  for (const tier of TIERS) {
    requireThat(
      tier.tradeGuards === GUARDED_TIERS.has(tier.name),
      `Unexpected shipped tradeGuards flag for ${tier.name}`,
    );
    const previous = frozen.tiers[tier.name].overrides as SearchConfig;
    for (const key of [
      'weights',
      'engine',
      'budget',
      'setupBudget',
      'lookahead',
      'eps',
      'delta',
      'noise',
      'randomMove',
      'openingTopK',
    ] as const)
      requireThat(
        JSON.stringify(tier[key]) === JSON.stringify(previous[key]),
        `Forbidden model/search-policy drift: ${tier.name}.${key}`,
      );
  }
  mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
  requireThat(
    realpathSync(OUTPUT_DIRECTORY) === OUTPUT_DIRECTORY &&
      OUTPUT_DIRECTORY.startsWith(realpathSync(WORKTREE) + sep),
    'Output directory must not escape the worktree through a symlink',
  );
  // Exclusive files prevent accidental overwrites of earlier measurements/witnesses.
  closeSync(openSync(cli.out, 'wx'));
  closeSync(openSync(cli.failures, 'wx'));
  const started = performance.now();
  const sourcePaths = [
    'src/ai/index.ts',
    'src/ai/trade.ts',
    'src/ai/trade-history.ts',
    'src/ai/types.ts',
    'src/ai/tiers.ts',
    'src/ai/planner.ts',
    'src/ai/value.ts',
    'src/ai/weights/fitted.json',
    'src/engine/state.ts',
    'src/engine/rules.ts',
    'src/engine/config.ts',
  ];
  const report: any = {
    status: 'running',
    startedAt: new Date().toISOString(),
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    trackedDiffSHA256: sha256(execFileSync('git', ['diff', 'HEAD', '--', 'src', 'tools'])),
    scriptSHA256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    sourceSHA256: Object.fromEntries(
      sourcePaths.map((path) => [path, sha256(readFileSync(resolve(WORKTREE, path)))]),
    ),
    corpus: {
      path: CORPUS_PATH,
      sha256: CORPUS_SHA256,
      positions: 200,
      regeneration: 'forbidden; only maps reconstructed from original saved seeds',
    },
    configurationContext: cli.human
      ? 'Explicit humanPlayers:[proposer] in every answer/proposal call'
      : 'Explicit humanPlayers:[] in every answer/proposal call',
    guarded: cli.guarded,
    guardedTiers: [...GUARDED_TIERS],
    positions: positions.length,
    maps: new Set(positions.map((p) => p.seed)).size,
    distinctPositions: new Set(positions.map((p) => `${p.seed}:${stateHash(p.state)}`)).size,
    vectors: vectors.length,
    cycleDepth: 2,
    tiers: {},
    violations: [],
    violationCount: 0,
    witnessStream: cli.failures,
    maximumDefinitions: {
      singleTrade:
        'Exact maximum scalar proposer net goods getTotal-giveTotal among all accepted legal first offers. Guarded <=1 follows G2; negative/zero gains remain reported.',
      singleTradePareto:
        'A strict componentwise proposer hand improvement from one trade; normally impossible because both nonempty sides are disjoint. Null means no such accepted offer, not an estimated zero.',
      twoLeg:
        'Exact maximum net goods for accepted two-leg sequences leaving every good at least its initial value. Not a four-offer turn maximum. Both same-rival and cross-rival second replies are examined.',
    },
  };
  const save = () => writeFileSync(cli.out, JSON.stringify(report, null, 2) + '\n');
  const evidence = (entry: unknown) => appendFileSync(cli.failures, JSON.stringify(entry) + '\n');
  const violation = (entry: any) => {
    report.violationCount++;
    if (report.violations.length < 1000) report.violations.push(entry);
    evidence({ severity: 'violation', ...entry });
  };
  try {
    for (const tier of TIERS) {
      const guard = cli.guarded && GUARDED_TIERS.has(tier.name),
        begin = performance.now();
      const stats: any = {
        positions: 0,
        tradeGuards: guard,
        enumeratedLegalOffers: 0,
        accepted: 0,
        marginChecks: 0,
        independentSafeBounds: 0,
        immediateWinChecks: 0,
        proposalsChecked: 0,
        historyTransportChecks: 0,
        cycleFirstLegs: 0,
        secondLegalOffers: 0,
        secondReplyAssessments: 0,
        g1ReasonChecks: 0,
        g1SameRivalChecks: 0,
        g1OtherRivalChecks: 0,
        secondDeclineReasons: {},
        cycleCandidates: 0,
        cycleAccepted: 0,
        cyclesParetoProfit: 0,
        positionsWithProfitableTwoLegCycle: 0,
        profitablePositionShare: 0,
        maxTwoLegNetGoods: 0,
        maxTwoLegWitness: null,
        acceptedTotalGoodsProfit: 0,
        maxSingleTradeNetGoods: null,
        maxSingleTradeWitness: null,
        acceptedSingleTradePareto: 0,
        maxSingleTradeParetoNetGoods: null,
        maxResponseMs: 0,
        seconds: 0,
        perPosition: [],
      };
      report.tiers[tier.name] = stats;
      for (let index = 0; index < positions.length; index++) {
        const { seed, board, state } = positions[index],
          proposer = state.active;
        const config: SearchConfig = {
          ...tier,
          tradeGuards: guard,
          timeLimitMs: 0,
          humanPlayers: cli.human ? [proposer] : [],
        };
        const baseHand = Array.from(
          state.hands.subarray(proposer * GOOD_COUNT, (proposer + 1) * GOOD_COUNT),
        );
        const accepted: { offer: Offer; after: GameState }[] = [];
        let positionCycles = 0,
          positionMaximum = 0;
        for (const offer of offers(board, state, vectors)) {
          stats.enumeratedLegalOffers++;
          const response = cloneState(state);
          applyWithTradeHistory(board, response, offer);
          const before = evaluate(board, response, config.weights),
            tick = performance.now();
          const accept = acceptsTrade(board, response, offer.to, config, 991 + index);
          stats.maxResponseMs = Math.max(stats.maxResponseMs, performance.now() - tick);
          if (!accept) continue;
          stats.accepted++;
          const assessment = assessTrade(board, response, offer.to, config, 991 + index);
          if (!assessment.accept)
            violation({
              kind: 'boolean-assessment-mismatch',
              tier: tier.name,
              seed,
              index,
              offer,
              assessment,
            });
          const after = cloneState(response);
          applyWithTradeHistory(board, after, { type: 'respondTrade', accept: true });
          const branch = transportedBranch(board, after, proposer);
          stats.historyTransportChecks += 4;
          accepted.push({ offer, after: branch });
          const next = evaluate(board, after, config.weights),
            mine = next[offer.to] - before[offer.to],
            theirs = next[proposer] - before[proposer];
          stats.marginChecks++;
          if (mine + 1e-12 < config.eps || theirs - mine > config.delta + 1e-12)
            violation({
              kind: 'margin-violation',
              tier: tier.name,
              seed,
              index,
              state: serializeState(state),
              offer,
              mine,
              theirs,
              eps: config.eps,
              delta: config.delta,
            });
          const net = sum(offer.get) - sum(offer.give);
          if (net > 0) stats.acceptedTotalGoodsProfit++;
          if (stats.maxSingleTradeNetGoods === null || net > stats.maxSingleTradeNetGoods) {
            stats.maxSingleTradeNetGoods = net;
            stats.maxSingleTradeWitness = {
              seed,
              positionIndex: index,
              proposer,
              offer,
              baseHand,
              finalHand: Array.from(
                after.hands.subarray(proposer * GOOD_COUNT, (proposer + 1) * GOOD_COUNT),
              ),
              netGoods: net,
            };
          }
          if (guard && net > 1)
            violation({
              kind: 'G2-excess-generosity',
              tier: tier.name,
              seed,
              index,
              offer,
              proposerNetGoods: net,
            });
          const finalHand = Array.from(
            after.hands.subarray(proposer * GOOD_COUNT, (proposer + 1) * GOOD_COUNT),
          );
          if (
            finalHand.every((n, g) => n >= baseHand[g]) &&
            finalHand.some((n, g) => n > baseHand[g])
          ) {
            stats.acceptedSingleTradePareto++;
            stats.maxSingleTradeParetoNetGoods = Math.max(
              stats.maxSingleTradeParetoNetGoods ?? -Infinity,
              net,
            );
          }
          const upper = independentUpper(board, after, proposer);
          if (upper < CONFIG.renown.target && after.turn < CONFIG.turnCap)
            stats.independentSafeBounds++;
          else
            violation({
              kind: 'accepted-without-independent-safety-proof',
              tier: tier.name,
              seed,
              index,
              state: serializeState(state),
              offer,
              upper,
            });
          for (const action of legalActions(board, after)) {
            if (
              !['upgrade', 'buildSteading', 'buyCard', 'muster', 'playCard'].includes(action.type)
            )
              continue;
            const won = cloneState(after);
            applyWithTradeHistory(board, won, action);
            stats.immediateWinChecks++;
            if (won.winnerId === proposer)
              violation({
                kind: 'accepted-immediate-win',
                tier: tier.name,
                seed,
                index,
                state: serializeState(state),
                offer,
                winningAction: action,
              });
          }
        }
        for (const first of accepted) {
          stats.cycleFirstLegs++;
          if (first.after.proposals >= 4) continue;
          for (const second of offers(board, first.after, vectors)) {
            stats.secondLegalOffers++;
            const finalHand = baseHand.map(
              (_, g) =>
                first.after.hands[proposer * GOOD_COUNT + g] + second.get[g] - second.give[g],
            );
            const pareto =
              finalHand.every((n, g) => n >= baseHand[g]) &&
              finalHand.some((n, g) => n > baseHand[g]);
            // Legacy comparison retains the original profitable-candidate filter.
            // Guarded tiers additionally prove G1 for every legal second reply, not only cycles.
            if (!guard && !pareto) continue;
            if (pareto) stats.cycleCandidates++;
            const response = cloneState(first.after);
            applyWithTradeHistory(board, response, second);
            const assessment: TradeAssessment = assessTrade(
              board,
              response,
              second.to,
              config,
              991 + index,
            );
            const accept = acceptsTrade(board, response, second.to, config, 991 + index);
            stats.secondReplyAssessments++;
            if (assessment.accept !== accept)
              violation({
                kind: 'boolean-assessment-mismatch',
                tier: tier.name,
                seed,
                index,
                offers: [first.offer, second],
                assessment,
                accept,
              });
            if (!accept)
              stats.secondDeclineReasons[assessment.reason ?? 'missing'] =
                (stats.secondDeclineReasons[assessment.reason ?? 'missing'] ?? 0) + 1;
            if (guard) {
              stats.g1ReasonChecks++;
              stats[first.offer.to === second.to ? 'g1SameRivalChecks' : 'g1OtherRivalChecks']++;
              if (accept || assessment.reason !== 'already traded this turn')
                violation({
                  kind: 'G1-second-reply-not-blocked',
                  tier: tier.name,
                  seed,
                  index,
                  state: serializeState(state),
                  offers: [first.offer, second],
                  assessment,
                  accept,
                });
            }
            if (!accept) continue;
            const final = cloneState(response);
            applyWithTradeHistory(board, final, { type: 'respondTrade', accept: true });
            if (!pareto) continue;
            stats.cycleAccepted++;
            stats.cyclesParetoProfit++;
            positionCycles++;
            const net = finalHand.reduce((total, n, g) => total + n - baseHand[g], 0);
            positionMaximum = Math.max(positionMaximum, net);
            const witness = {
              tier: tier.name,
              seed,
              positionIndex: index,
              proposer,
              state: serializeState(state),
              offers: [first.offer, second],
              baseHand,
              finalHand,
              netGoods: net,
            };
            if (net > stats.maxTwoLegNetGoods) {
              stats.maxTwoLegNetGoods = net;
              stats.maxTwoLegWitness = witness;
            }
            if (stats.cyclesParetoProfit <= 5)
              evidence({
                severity: guard ? 'violation' : 'expected-legacy-witness',
                kind: 'two-trade-pareto-profit',
                ...witness,
              });
          }
        }
        for (const proposals of [0, 1, 2, 3, 4]) {
          const candidate = cloneState(state);
          candidate.proposals = proposals;
          const proposal = proposeTrade(board, candidate, proposer, config, 491 + index);
          stats.proposalsChecked++;
          if (proposal && (!isLegal(board, candidate, proposal) || proposals >= 2))
            violation({
              kind: 'own-proposal-illegal-or-limit',
              tier: tier.name,
              seed,
              index,
              state: serializeState(candidate),
              proposal,
            });
        }
        stats.positions++;
        if (positionCycles > 0) stats.positionsWithProfitableTwoLegCycle++;
        stats.profitablePositionShare = stats.positionsWithProfitableTwoLegCycle / stats.positions;
        stats.perPosition.push({
          index,
          seed,
          turn: state.turn,
          hash: stateHash(state),
          profitableCycles: positionCycles,
          maxTwoLegNetGoods: positionMaximum,
        });
        if ((index + 1) % 10 === 0) {
          stats.seconds = (performance.now() - begin) / 1000;
          save();
          process.stdout.write(
            JSON.stringify({
              tier: tier.name,
              done: index + 1,
              positions: 200,
              legal: stats.enumeratedLegalOffers,
              accepted: stats.accepted,
              profitablePositions: stats.positionsWithProfitableTwoLegCycle,
              maxSingleTradeNetGoods: stats.maxSingleTradeNetGoods,
              violations: report.violationCount,
            }) + '\n',
          );
        }
      }
      stats.seconds = (performance.now() - begin) / 1000;
      const expectedPositions = guard ? 0 : LEGACY_POSITIONS_WITH_CYCLE[tier.name];
      const expectedMaximum = guard ? 0 : LEGACY_TWO_LEG_MAXIMUM[tier.name];
      stats.expectedPositionsWithCycle = expectedPositions;
      stats.expectedTwoLegMaximum = expectedMaximum;
      if (
        stats.positionsWithProfitableTwoLegCycle !== expectedPositions ||
        stats.maxTwoLegNetGoods !== expectedMaximum
      )
        violation({
          kind: 'cycle-regression-expectation',
          tier: tier.name,
          expectedPositions,
          actualPositions: stats.positionsWithProfitableTwoLegCycle,
          expectedMaximum,
          actualMaximum: stats.maxTwoLegNetGoods,
        });
      save();
    }
    report.status = report.violationCount ? 'failed' : 'complete';
    report.finishedAt = new Date().toISOString();
    report.seconds = (performance.now() - started) / 1000;
    report.checked = [
      'Exact SHA-pinned saved 200 positions; never regenerated',
      'All legal 55x55 disjoint 1..3 bundles to both rivals for every first offer',
      'Every legal guarded second reply blocked by G1, including both original and other recipient, after actual first acceptance and public state transports',
      'All profitable two-offer Pareto-return candidates for legacy tiers/controls',
      'Single accepted trade proposer total net goods, G2 upper bound and single-hand-Pareto statistic',
      'Original independent value margins, generous finishing bound, immediate winning actions, and own proposal legality/limit',
    ];
    report.notChecked = [
      'No full games, strengths, fits or four-offer maximum search',
      'Mixed-tier recipient combinations are not enumerated: each tier is tested as both rival acceptors, as in the fixed corpus protocol',
      'Public-history checks require hosts to apply actual actions through applyWithTradeHistory; standalone hypothetical assessments do not spend an acceptance',
      'Response timings are descriptive uncapped Node observations, not browser deadlines',
    ];
    save();
    process.stdout.write(
      JSON.stringify({
        done: true,
        status: report.status,
        seconds: report.seconds,
        violations: report.violationCount,
        out: cli.out,
      }) + '\n',
    );
    if (report.violationCount) process.exitCode = 1;
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
    report.seconds = (performance.now() - started) / 1000;
    save();
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
