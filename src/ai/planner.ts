/** Bounded best-first search over one player's atomic turn, stopping at complete turns. */
import {
  apply,
  cloneState,
  legalActions,
  randomizeHidden,
  stateHash,
  Card,
  CONFIG,
  renown,
  handSize,
  CARD_COUNT,
  type Action,
  type GameState,
} from '../engine/index.js';
import { evaluate } from './value.js';
import type { SearchRequest, SearchResult } from './types.js';
import { IndexedFrontier } from './frontier.js';
import { withDecisionDeadline, deadlineExpired } from './time.js';
interface Node {
  state: GameState;
  path: Action[];
  score: number;
  depth: number;
  endEvaluated: boolean;
}
/** Prefer score-changing decisions early; full search still considers every generated legal move. */
function actionPriority(action: Action): number {
  if (action.type === 'upgrade' || action.type === 'buildSteading') return 5;
  if (action.type === 'playCard') return action.card === Card.Caravan ? 4 : 3;
  if (action.type === 'buyCard' || action.type === 'muster') return 2;
  if (action.type === 'marketBuy') return 1;
  return 0;
}
/** Return a complete-turn utility, optionally averaging the next mandatory roll's eleven outcomes. */
function endValue(request: SearchRequest, state: GameState): number {
  if (!request.config.lookahead || state.phase !== 'roll')
    return evaluate(request.board, state, request.config.weights)[request.player];
  let result = 0;
  // A started expectation is one bounded evaluation. Finish all eleven outcomes;
  // a partial weighted sum would systematically undervalue late dice totals.
  for (let total = CONFIG.dice.count; total <= CONFIG.dice.count * CONFIG.dice.sides; total++) {
    const copy = cloneState(state);
    apply(request.board, copy, { type: 'roll' }, total);
    const probability =
      (CONFIG.dice.sides - Math.abs(CONFIG.dice.lean - total)) /
      CONFIG.dice.sides ** CONFIG.dice.count;
    result += probability * evaluate(request.board, copy, request.config.weights)[request.player];
  }
  return result;
}
/** Search a sanitized clone only. Returning a plan lets a bot reuse deterministic work within its turn. */
export function planTurn(request: SearchRequest): SearchResult {
  request = withDecisionDeadline(request);
  const { board, player, config } = request;
  const root = cloneState(request.state);
  randomizeHidden(root, request.seed);
  const legal = legalActions(board, root);
  if (!legal.length) throw new Error('Cannot plan a finished game');
  const fallback = legal.find((a) => a.type === 'endTurn') ?? legal[0];
  let best: SearchResult = {
    action: fallback,
    plan: [fallback],
    value: -Infinity,
    nodes: 0,
    won: false,
  };
  if (deadlineExpired(request.deadline)) return { ...best, candidates: [] };
  const frontier = new IndexedFrontier<Node>([
    {
      state: root,
      path: [],
      score: evaluate(board, root, config.weights)[player],
      depth: 0,
      endEvaluated: false,
    },
  ]);
  const candidates = new Map<string, { action: Action; plan: Action[]; value: number }>();
  const consider = (state: GameState, path: Action[]) => {
    const value = endValue(request, state);
    const key = JSON.stringify(path[0]);
    const previous = candidates.get(key);
    if (!previous || value > previous.value)
      candidates.set(key, { action: path[0], plan: path, value });
    if (value > best.value + 1e-12)
      best = { ...best, action: path[0], plan: path, value, won: state.winnerId === player };
    return value;
  };
  const seen = new Set<string>([stateHash(root)]);
  const budget = Math.max(1, Math.floor(config.budget));
  while (frontier.length && best.nodes < budget && !deadlineExpired(request.deadline)) {
    const node = frontier.pop()!;
    if (node.state.phase === 'gameOver') {
      if (node.state.winnerId === player)
        return { ...best, action: node.path[0], plan: node.path, value: 1, won: true };
      continue;
    }
    if (node.state.active !== player || node.state.toAct !== player) continue;
    // Ending every visited main position supplies a real terminal candidate, even under a tiny budget.
    if (node.state.phase === 'main' && !node.endEvaluated) {
      const ending = cloneState(node.state);
      apply(board, ending, { type: 'endTurn' });
      const path = [...node.path, { type: 'endTurn' } as Action];
      consider(ending, path);
    }
    const actions = legalActions(board, node.state)
      .filter((a) => a.type !== 'endTurn')
      .sort((a, b) => actionPriority(b) - actionPriority(a));
    for (const action of actions) {
      if (best.nodes >= budget || deadlineExpired(request.deadline)) break;
      const child = cloneState(node.state);
      apply(board, child, action);
      best.nodes++;
      const path = [...node.path, action];
      if (child.winnerId === player)
        return { action: path[0], plan: path, value: 1, nodes: best.nodes, won: true };
      const hash = stateHash(child);
      if (seen.has(hash)) continue;
      seen.add(hash);
      let value: number;
      if (child.phase === 'main') {
        const ending = cloneState(child);
        apply(board, ending, { type: 'endTurn' });
        value = consider(ending, [...path, { type: 'endTurn' }]);
      } else value = evaluate(board, child, config.weights)[player];
      // A terminal outside-main decision is useful to the caller, but only main roots are cached as whole turns.
      if (request.state.phase !== 'main' && value > best.value + 1e-12)
        best = { ...best, action: path[0], plan: path, value, won: false };
      if (child.active === player && child.toAct === player)
        frontier.push({
          state: child,
          path,
          score: value - node.depth * 1e-6,
          depth: node.depth + 1,
          endEvaluated: child.phase === 'main',
        });
    }
  }
  return { ...best, candidates: [...candidates.values()] };
}
/** Quick tactical guard for trades: exhaustive immediate score moves plus a bounded turn plan. */
export function canWinThisTurn(request: SearchRequest): boolean {
  if (renown(request.board, request.state, request.player) >= CONFIG.renown.target) return true;
  return planTurn({
    ...request,
    config: {
      ...request.config,
      noise: 0,
      budget: Math.max(128, request.config.budget),
      lookahead: false,
    },
  }).won;
}

/** A deliberately generous upper bound: every new Renown costs at least two goods,
 * except a possible Warlord transfer. Include the largest playable bank/tithe gain
 * and both possible plunders, ignore their costs, allow every site to be a shrine,
 * and grant the maximum net goods from every still-legal player trade.
 * Falling below the target proves a trade cannot finish; reaching it proves nothing.
 */
export function turnRenownUpperBound(request: SearchRequest): number {
  const { state, player, board } = request;
  const offset = player * CARD_COUNT;
  const ready = (card: Card) => state.cards[offset + card] > state.freshCards[offset + card];
  const cardGoods = state.played
    ? 0
    : Math.max(
        ready(Card.Caravan) ? CONFIG.cards.caravanGoods : 0,
        ready(Card.Tithe) ? CONFIG.cards.titheGoods * (state.players - 1) : 0,
      );
  const futureTrades =
    (CONFIG.trade.maxUnits - CONFIG.trade.minUnits) *
    Math.max(0, CONFIG.trade.maxProposals - state.proposals);
  const potentialGoods =
    handSize(state, player) + cardGoods + CONFIG.muster.plunderGoods * 2 + futureTrades;
  const title = state.warlord === player ? 0 : CONFIG.renown.warlord;
  return renown(board, state, player) + Math.floor(potentialGoods / 2) + title;
}
/** A bounded search can prove a win, but a failed search cannot prove safety. */
export function finishingRisk(request: SearchRequest): 'impossible' | 'found' | 'unresolved' {
  // The final turn can win below twelve through the cap tiebreak, so no Renown-only proof applies.
  if (request.state.turn >= CONFIG.turnCap) return canWinThisTurn(request) ? 'found' : 'unresolved';
  if (turnRenownUpperBound(request) < CONFIG.renown.target) return 'impossible';
  return canWinThisTurn(request) ? 'found' : 'unresolved';
}
