/** Value-driven handling of setup and forced decisions, with seeded tie and exploration choices. */
import {
  apply,
  cloneState,
  legalActions,
  nextRandom,
  randomizeHidden,
  shuffle,
  type GameState,
  type Action,
} from '../engine/index.js';
import { evaluate } from './value.js';
import type { SearchConfig, SearchRequest, SearchResult } from './types.js';
import { withDecisionDeadline, deadlineExpired } from './time.js';
/** One API boundary for optional setup budgets; invalid values must never bypass the forecast limit. */
export function validatedSetupBudget(config: Pick<SearchConfig, 'setupBudget'>): number {
  const budget = config.setupBudget === undefined ? 0 : config.setupBudget;
  if (!Number.isSafeInteger(budget) || budget < 0)
    throw new Error('Setup budget must be a nonnegative safe integer');
  return budget;
}
/** Rank only public successor positions; a hidden-order permutation cannot change the ranking. */
export function rankedDecisions(
  request: SearchRequest,
  maxEvaluations = Infinity,
): { action: Action; value: number }[] {
  request = withDecisionDeadline(request);
  // Keep the public result's existing action/value/tie shape. The private winner
  // flag lets choosePlacement return without starting new work after a cutoff.
  return rankDecisions(request, maxEvaluations).map(({ won: _won, ...candidate }) => candidate);
}
/** Carry only fully evaluated successors, including their actual terminal status. */
function rankDecisions(request: SearchRequest, maxEvaluations = Infinity) {
  const root = cloneState(request.state);
  randomizeHidden(root, request.seed);
  const random = { rng: request.seed };
  const legal = legalActions(request.board, root);
  const actions =
    legal.length > maxEvaluations ? shuffle(random, legal).slice(0, maxEvaluations) : legal;
  const ranked: { action: Action; value: number; tie: number; won: boolean }[] = [];
  for (const action of actions) {
    if (deadlineExpired(request.deadline)) break;
    const child = cloneState(root);
    apply(request.board, child, action);
    ranked.push({
      action,
      value: evaluate(request.board, child, request.config.weights)[request.player],
      tie: nextRandom(random),
      won: child.winnerId === request.player,
    });
  }
  return ranked.sort((a, b) => b.value - a.value || a.tie - b.tie);
}
/** An expired caller still receives a legal action without pretending it was evaluated. */
function legalFallback(request: SearchRequest): SearchResult {
  const state = cloneState(request.state);
  randomizeHidden(state, request.seed);
  const action = legalActions(request.board, state)[0];
  if (!action) throw new Error('No legal decision');
  return { action, plan: [action], value: -Infinity, nodes: 0, won: false };
}
/** Setup advances deterministically; every future actor greedily maximizes its own probability. */
function isSetup(state: GameState): boolean {
  return state.phase === 'setupSteading' || state.phase === 'setupTrack';
}
/** Rank a whole future setup decision, or stop before spending an insufficient local allowance. */
function nextSetupDecision(
  request: SearchRequest,
  state: GameState,
  remaining: number,
  random: { rng: number },
) {
  const actions = legalActions(request.board, state);
  if (!actions.length || actions.length > remaining) return null;
  let best: { state: GameState; ownValue: number; rootValue: number; tie: number } | null = null;
  let nodes = 0;
  for (const action of actions) {
    if (deadlineExpired(request.deadline)) return { complete: false as const, nodes };
    const child = cloneState(state);
    apply(request.board, child, action);
    const probabilities = evaluate(request.board, child, request.config.weights);
    nodes++;
    const ownValue = probabilities[state.toAct],
      tie = nextRandom(random);
    if (!best || ownValue > best.ownValue || (ownValue === best.ownValue && tie < best.tie))
      best = { state: child, ownValue, rootValue: probabilities[request.player], tie };
  }
  return { ...best!, complete: true as const, nodes };
}
/** Complete one public setup continuation without noise, exploration, or chance rollouts. */
function forecastSetup(
  request: SearchRequest,
  action: Action,
  initialValue: number,
  allowance: number,
) {
  if (deadlineExpired(request.deadline)) return { complete: false, nodes: 0, value: initialValue };
  let state = cloneState(request.state);
  randomizeHidden(state, request.seed);
  apply(request.board, state, action);
  const random = { rng: request.seed };
  let nodes = 0,
    value = initialValue;
  while (isSetup(state)) {
    if (deadlineExpired(request.deadline)) return { complete: false, nodes, value };
    const next = nextSetupDecision(request, state, allowance - nodes, random);
    if (!next) return { complete: false, nodes, value };
    nodes += next.nodes;
    if (!next.complete) return { complete: false, nodes, value };
    state = next.state;
    value = next.rootValue;
  }
  return { complete: true, nodes, value };
}
/** Budget root ranking plus evenly allocated forecasts, considering only completed setup outcomes. */
function chooseSetupForecast(request: SearchRequest, budget: number): SearchResult {
  const ranked = rankDecisions(request, budget);
  if (!ranked.length) return legalFallback(request);
  const candidateCount = Math.min(8, ranked.length, Math.max(1, Math.floor(budget / 512)));
  const remaining = budget - ranked.length,
    each = Math.floor(remaining / candidateCount);
  let nodes = ranked.length;
  let best: { action: Action; value: number } | null = null;
  for (let i = 0; i < candidateCount; i++) {
    if (deadlineExpired(request.deadline)) break;
    const candidate = ranked[i];
    const forecast = forecastSetup(
      request,
      candidate.action,
      candidate.value,
      each + Number(i < remaining % candidateCount),
    );
    nodes += forecast.nodes;
    if (forecast.complete && (!best || forecast.value > best.value))
      best = { action: candidate.action, value: forecast.value };
  }
  const choice = best ?? ranked[0];
  return { action: choice.action, plan: [choice.action], value: choice.value, nodes, won: false };
}
/** Choose a forced/setup action with the same value model used by main search. */
export function choosePlacement(request: SearchRequest): SearchResult {
  request = withDecisionDeadline(request);
  const setupBudget = validatedSetupBudget(request.config);
  if (isSetup(request.state) && setupBudget > 0) {
    return chooseSetupForecast(request, setupBudget);
  }
  const ranked = rankDecisions(request);
  if (!ranked.length) return legalFallback(request);
  const random = { rng: request.seed };
  let selected = 0;
  if (request.config.openingTopK > 1 && request.state.phase === 'setupSteading')
    selected = Math.floor(nextRandom(random) * Math.min(request.config.openingTopK, ranked.length));
  else if (request.config.noise > 0)
    selected = softmaxIndex(
      ranked.map((r) => r.value),
      request.config.noise,
      random,
    );
  const choice = ranked[selected];
  return {
    action: choice.action,
    plan: [choice.action],
    value: choice.value,
    nodes: ranked.length,
    won: choice.won,
  };
}
/** Stable Boltzmann sampling allows controlled exploration without wall-clock randomness. */
export function softmaxIndex(
  values: readonly number[],
  temperature: number,
  random: { rng: number },
): number {
  if (temperature <= 0) return values.indexOf(Math.max(...values));
  const maximum = Math.max(...values);
  const masses = values.map((v) => Math.exp((v - maximum) / temperature));
  let draw = nextRandom(random) * masses.reduce((a, b) => a + b, 0);
  for (let i = 0; i < masses.length; i++) {
    draw -= masses[i];
    if (draw <= 0) return i;
  }
  return values.length - 1;
}
