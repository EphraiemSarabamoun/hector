# Evaluation

The measurements are transcribed from the project's evaluation records, which are not included here.

All strength results below are uncapped Node games: one challenger against two copies of the listed opponent, with one-third win probability as parity. Challenger identities rotate and turn order is randomized. Intervals are marginal Wilson 95% score intervals unless explicitly described otherwise. Seed ranges include both endpoints. These measurements do not measure human strength or win rates with the browser's time limit.

The current release enables trade guards for Aeneas, Sarpedon and Hector. Astyanax and Paris keep the more generous policy. The guarded policy accepts at most one trade from a proposer across the whole table in an individual turn, and gives no more than one additional unit beyond what it receives. These policies change trade answers, not the rules or search coefficients.

## Current guarded policy

| Match | Games | Wins | Win rate | Wilson 95% | Seeds |
| --- | --- | --- | --- | --- | --- |
| Hector vs Aeneas | 600 | 259 | 43.17% | 39.26% to 47.16% | 12010000–12010599 |
| Sarpedon vs Aeneas | 600 | 275 | 45.83% | 41.89% to 49.83% | 12020000–12020599 |
| Plain Aeneas vs Hector | 600 | 187 | 31.17% | 27.59% to 34.98% | 12000000–12000599 |
| Trader/Aeneas vs Hector | 600 | 158 | 26.33% | 22.97% to 30.00% | 12000000–12000599 |

Hector did not reach the 55% target against two Aeneas opponents. The current Hector and Sarpedon intervals overlap in their separate comparisons against Aeneas; these data do not establish an ordering between the top two tiers. There is no current guarded direct Hector–Sarpedon result here.

Compared with the historical unguarded policy on separate seeds, Hector's change was +2.667 percentage points, with independent difference 95% interval [−2.908, +8.218] points; Sarpedon's was +4.333 points, interval [−1.276, +9.904]. Neither interval excludes zero. This does not establish improvement, equivalence, or absence of a small regression.

The current matched trade comparison uses the same seeds and rival settings for the plain and Trader variants. The Trader retains ordinary Aeneas play, replacing proposals with exhaustive beneficial offers. Both comparisons use the same simulated-human offer context; no human participated.

| Paired outcome | Games |
| --- | --- |
| Both win | 97 |
| Plain only | 90 |
| Trader only | 61 |
| Neither wins | 352 |

Trader minus plain is -4.833 percentage points; paired bootstrap 95% [-8.833, -0.833] points. The specified maximum-five-point gain criterion passes. This compares two fixed strategies and is not a proof against every trading exploit.


## Historical unguarded policy

The following measurements used the same retained coefficients and fixed-work search settings before the current trade guards. They describe that earlier trade policy and are not fresh measurements of every current tier matchup.

| Match | Games | Challenger wins | Win rate | Wilson 95% | Seeds |
| --- | --- | --- | --- | --- | --- |
| Paris-Astyanax | 600 | 528 | 88.00% | 85.16% to 90.36% | 6010000–6010599 |
| Aeneas-Paris | 600 | 445 | 74.17% | 70.52% to 77.51% | 6020000–6020599 |
| Sarpedon-Aeneas | 600 | 249 | 41.50% | 37.62% to 45.48% | 6030000–6030599 |
| Hector-Sarpedon | 600 | 227 | 37.83% | 34.04% to 41.78% | 6040000–6040599 |
| Hector-Aeneas | 600 | 243 | 40.50% | 36.64% to 44.48% | 6050000–6050599 |
| Hector-Astyanax | 600 | 596 | 99.33% | 98.30% to 99.74% | 6060000–6060599 |
| farm-plain | 600 | 171 | 28.50% | 25.03% to 32.24% | 8000000–8000599 |
| farm-trader | 600 | 180 | 30.00% | 26.47% to 33.78% | 8000000–8000599 |
| symmetric-Aeneas | 3000 | 975 | 32.50% | 30.85% to 34.20% | 9000000–9002999 |

In the symmetric Aeneas row every participant uses Aeneas. Its designated-challenger count is shown for completeness; the identity and starting-order breakdown below is the relevant balance check.

Adjacent historical comparisons have Wilson lower bounds above one third. The separate Hector–Aeneas 55% target failed at 40.50%; the Hector–Astyanax 95% target passed at 99.33%. These are different criteria. The historical matched Trader comparison was 180 wins versus 171 plain wins out of 600 each: +1.500 percentage points, paired bootstrap 95% [−2.500, +5.667] points. Its point criterion passed, while its interval extended above five points.

| Match | Mean turns | Median turns | Rule-cap endings |
| --- | --- | --- | --- |
| Paris-Astyanax | 132.398 | 128 | 0/600 |
| Aeneas-Paris | 91.040 | 88.5 | 0/600 |
| Sarpedon-Aeneas | 100.843 | 99 | 0/600 |
| Hector-Sarpedon | 98.587 | 97 | 0/600 |
| Hector-Aeneas | 101.938 | 100 | 0/600 |
| Hector-Astyanax | 65.288 | 62 | 0/600 |
| farm-plain | 99.867 | 98 | 0/600 |
| farm-trader | 101.765 | 100 | 0/600 |
| symmetric-Aeneas | 102.655 | 101 | 0/3000 |

## Starting-order balance

The historical symmetric Aeneas experiment used 3,000 independent games. Each game has one winner; counts in each breakdown sum to 3,000.

| Identity or order | Wins / 3,000 | Win rate | Wilson 95% |
| --- | --- | --- | --- |
| Player identity 0 | 1025 | 34.17% | 32.49% to 35.88% |
| Player identity 1 | 954 | 31.80% | 30.16% to 33.49% |
| Player identity 2 | 1021 | 34.03% | 32.36% to 35.75% |
| Turn-order position 0 | 1080 | 36.00% | 34.30% to 37.73% |
| Turn-order position 1 | 939 | 31.30% | 29.67% to 32.98% |
| Turn-order position 2 | 981 | 32.70% | 31.04% to 34.40% |

The first turn won 36.00% of games. Starting-order equality has chi-square 10.482 with two degrees of freedom, p=0.005295. Player-identity equality has chi-square 3.182, p=0.203722; this is not proof of exact equality. The starting-order result is a game-balance limitation. No guarded symmetric rerun is reported.

## Training and coefficient selection

The shipped model is `tuned-checkpoint-4`, with 49 natural-unit coefficients. Its coefficient-array SHA-256 is:

```text
0e5b3d911505d2db874447d3eadc3922362bd47467bf652285084443801a1802
```

Two supervised candidates failed their separate W0 strength comparisons. CEM optimization instead started from W0. CEM used training-only RMS coordinates, 16 candidates on 120 shared-seed games per iteration, four selected candidates per update, and a 600-game checkpoint comparison every fifth iteration. Checkpoint acceptance used point rate above one third; the final shipping comparison required its Wilson lower bound above one third. Rejected results remain below.

| Coefficient comparison | Games | Wins | Win rate | Wilson 95% | Seeds | Result |
| --- | --- | --- | --- | --- | --- | --- |
| Unconstrained supervised candidate vs W0 | 600 | 35 | 5.83% | 4.22% to 8.00% | 1000000–1000599 | Rejected |
| Constrained supervised candidate vs W0 | 600 | 180 | 30.00% | 26.47% to 33.78% | 1200000–1200599 | Rejected |
| checkpoint-0 vs w0 | 600 | 247 | 41.17% | 37.30% to 45.15% | 4000000–4000599 | Accepted |
| checkpoint-1 vs checkpoint-0 | 600 | 221 | 36.83% | 33.07% to 40.77% | 4001000–4001599 | Accepted |
| checkpoint-2 vs checkpoint-1 | 600 | 194 | 32.33% | 28.71% to 36.18% | 4002000–4002599 | Rejected |
| checkpoint-3 vs checkpoint-1 | 600 | 263 | 43.83% | 39.91% to 47.83% | 4003000–4003599 | Accepted |
| checkpoint-4 vs checkpoint-3 | 600 | 216 | 36.00% | 32.26% to 39.92% | 4004000–4004599 | Accepted |
| Retained checkpoint vs W0 | 600 | 300 | 50.00% | 46.01% to 53.99% | 6000000–6000599 | Accepted |

CEM completed 53,831 match evaluations using 6,840 distinct completed board seeds; candidates within an iteration shared seeds. That total includes rejected candidates and later candidates that were not promoted. Training/RMS data comprised 5,000 games, split into 4,500 training and 500 held-out games; the coefficient file retains all scales, sign constraints, seed windows and numeric gates.

The retained coefficients have poor exploratory calibration on the frozen 500-game W0 holdout: cross-entropy 1.628318 versus uniform ln(3)=1.098612. In the highest probability bin, mean predicted win probability was 97.79% and the observed winner rate was 65.43%. This diagnostic was computed after selection, without a temperature fit. Correlated turns and participants and the off-policy data limit interpretation. Treat outputs as search scores rather than calibrated forecasts.

## Search configuration comparison

This historical development comparison used 60 games against Aeneas on seeds 57000–57059 and 60 against Sarpedon on 58000–58059 for each configuration. These seeds are separate from the final arenas.

| Configuration | Games | Wins | Win rate | Wilson 95% |
| --- | --- | --- | --- | --- |
| planner32768 | 120 | 49 | 40.83% | 32.46% to 49.78% |
| chance2048 | 120 | 47 | 39.17% | 30.90% to 48.11% |
| planner8192 | 120 | 46 | 38.33% | 30.12% to 47.27% |
| mcts2048 | 120 | 31 | 25.83% | 18.84% to 34.33% |

These small development results selected a configuration; they are not independent final strength measurements. Paired differences between planner configurations include zero.

## Trade-cycle coverage

The fixed corpus contains 200 positions from 41 maps. It exhaustively checks legal disjoint one-to-three-unit bundles, both possible recipients, and accepted two-offer cycles that leave every good at least at its starting value. Each tier is used for both receiving opponents. The same corpus was checked with and without the simulated-human offer context.

| Current receiving tier | Positions with profitable two-offer cycle / 200 | Maximum cycle net goods | Maximum single-trade net goods |
| --- | --- | --- | --- |
| Astyanax | 12 | 2 | 1 |
| Paris | 12 | 2 | 1 |
| Aeneas | 0 | 0 | 1 |
| Sarpedon | 0 | 0 | 1 |
| Hector | 0 | 0 | 1 |

The upper three tiers accepted no profitable two-offer cycles in this corpus. Astyanax and Paris still each admitted 49 profitable cycles in 12 positions, with maximum net gain two goods. This is not exhaustive coverage of mixed-tier combinations, four-offer turns, or all full-game exploits.

## Decision times

All values below are milliseconds. These are observed wall times, not worst-case bounds. Node arenas disable browser clocks. Decision samples include setup; active-turn sums exclude setup and include responses by other participants. Parallel games and runtime conditions affect these observations.

| Current guarded arena | Decisions | Decision median | Decision p95 | Decision max | Turn median | Turn p95 | Turn max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| farm-plain | 87819 | 0.063 | 8.386 | 113.853 | 6.408 | 12.094 | 114.312 |
| farm-trader | 90763 | 0.772 | 14.661 | 152.414 | 12.830 | 36.617 | 185.681 |
| hector-aeneas | 87510 | 0.067 | 172.310 | 2679.990 | 12.230 | 1450.703 | 3873.244 |
| sarpedon-aeneas | 87913 | 0.062 | 145.920 | 386.885 | 11.926 | 224.574 | 609.030 |

Historically pooled over Hector's three final unguarded matchups, 236,594 decisions had median/p95 0.067/222.310 ms and maximum 3641.470 ms; 53,408 active-turn totals had median/p95 16.861/1799.192 ms and maximum 6415.754 ms. These are pooled observations, not averages of per-match percentiles.


A historical Chromium timing corpus used 30 naturally reached mid-game positions per tier, excluding setup and module/map warmup. Hector's browser cap was enabled. These browser observations predate the current guards and do not measure their playing strength.

| Historical browser tier | First-main median / p95 / max | Whole-turn median / p95 / max |
| --- | --- | --- |
| Astyanax | 1.35 / 5.10 / 6.10 | 4.40 / 8.80 / 9.00 |
| Paris | 21.40 / 45.80 / 50.90 | 26.30 / 52.00 / 54.10 |
| Aeneas | 22.80 / 51.00 / 51.20 | 27.85 / 53.60 / 58.30 |
| Sarpedon | 24.40 / 287.00 / 312.50 | 30.25 / 291.50 / 314.40 |
| Hector | 39.45 / 1045.20 / 1521.50 | 40.90 / 1048.50 / 1529.50 |

Hector's 3,000 ms browser limit is cooperative. Completed bounded work may overrun it, and slower devices or more complex positions can behave differently. No measured strength claim is made for that clock-limited browser policy or against human players.

## Reproduction

Install dependencies with `npm ci`. Run arenas through the shared real-action history boundary; hypothetical search transitions must not create accepted-trade history. Node arena clocks are disabled by the tools. The following commands use current guarded policies and unchanged retained coefficients:

```sh
npx tsx tools/arena.ts --games 600 --seed 12010000 --processes 4 --challenger Hector --opponent Aeneas --challenger-trade-guards true --opponent-trade-guards true --out runs/guarded-hector-aeneas.csv
npx tsx tools/arena.ts --games 600 --seed 12020000 --processes 4 --challenger Sarpedon --opponent Aeneas --challenger-trade-guards true --opponent-trade-guards true --out runs/guarded-sarpedon-aeneas.csv
npx tsx tools/arena.ts --games 600 --seed 12000000 --processes 4 --challenger Aeneas --opponent Hector --human-challenger true --out runs/guarded-plain.csv
npx tsx tools/arena.ts --games 600 --seed 12000000 --processes 4 --challenger Trader --trader-base Aeneas --opponent Hector --human-challenger true --out runs/guarded-trader.csv
npx tsx tools/measure.ts runs/guarded-hector-aeneas.csv runs/guarded-sarpedon-aeneas.csv runs/guarded-plain.csv runs/guarded-trader.csv
```

For historical tier comparisons, explicitly disable both guards and use the table's first seed and game count. For example:

```sh
npx tsx tools/arena.ts --games 600 --seed 6010000 --processes 4 --challenger Paris --opponent Astyanax --challenger-trade-guards false --opponent-trade-guards false --out runs/historical-paris-astyanax.csv
```

The historical farm rows use Aeneas or Trader/Aeneas against Hector, with `--human-challenger true` and both guard flags false. The symmetric row uses Aeneas against Aeneas. Historical supervised and checkpoint coefficients are not all included in this release; their aggregate gates describe the coefficient-selection procedure rather than guaranteeing that a newly timed optimization recreates every candidate. `src/ai/weights/fitted.json` retains the numeric coefficient provenance. See [the code guide](../Human.md) for collecting a fresh training generation, fitting, tuning and comparing a new model.

```sh
npx tsx tools/trade-guard-cycle-check.ts --human false --guarded false
npx tsx tools/trade-guard-cycle-check.ts --human true --guarded false
npx tsx tools/trade-guard-cycle-check.ts --human false --guarded true
npx tsx tools/trade-guard-cycle-check.ts --human true --guarded true
```

These four contexts share the shipped corpus and write separate context-labelled results under `runs/trade-guard-cycle/`.

```sh
npx tsx tools/browser-timing.ts
npm run build
npx playwright test tests/browser/time-limit.spec.ts
```

Remeasure browser timing after changing policies, coefficients, search budgets or runtime conditions. Keep uncapped arena strength, clock-limited deployment timing, and explicit stress tests separate.
