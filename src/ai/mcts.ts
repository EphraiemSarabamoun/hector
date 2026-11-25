/** UCT search with max-n vector backups, sampled hidden futures, and learned leaf values. */
import {
  apply,
  cloneState,
  legalActions,
  nextRandom,
  randomizeHidden,
  CONFIG,
  type Action,
  type GameState,
} from '../engine/index.js';
import { evaluate } from './value.js';
import type { SearchRequest, SearchResult } from './types.js';
import { withDecisionDeadline, deadlineExpired } from './time.js';
interface Edge {
  action: Action;
  visits: number;
  values: number[];
  child: Node;
}
interface Node {
  visits: number;
  edges: Map<string, Edge>;
  outcomes: Map<string, Node>;
}
const emptyNode = (): Node => ({ visits: 0, edges: new Map(), outcomes: new Map() });
const actionKey = (action: Action) => JSON.stringify(action);
export const MCTS_SETTINGS = Object.freeze({ exploration: 0.15, depth: 40 });
/** Keep distinct observed rolls and card reveals in separate decision subtrees. */
function condition(node: Node, observation: string): Node {
  let child = node.outcomes.get(observation);
  if (!child) {
    child = emptyNode();
    node.outcomes.set(observation, child);
  }
  return child;
}
/** Back up a vector so each decision maker can prefer its own probability instead of helping the root. */
function backup(path: { node: Node; edge: Edge }[], values: number[]): void {
  for (const { node, edge } of path) {
    node.visits++;
    edge.visits++;
    for (let p = 0; p < values.length; p++) edge.values[p] += values[p];
  }
}
/** Sample chance on a sanitized position; forced rolls never inspect the real RNG or deck order. */
function chanceStep(request: SearchRequest, state: GameState, random: { rng: number }): void {
  const total = Array.from(
    { length: CONFIG.dice.count },
    () => 1 + Math.floor(nextRandom(random) * CONFIG.dice.sides),
  ).reduce((a, b) => a + b, 0);
  apply(request.board, state, { type: 'roll' }, total);
}
/** Run reproducible iterations. Leaf evaluation replaces random rollouts at every frontier. */
export function searchMCTS(request: SearchRequest): SearchResult {
  request = withDecisionDeadline(request);
  const { board, player, config } = request;
  const root = emptyNode();
  const random = { rng: request.seed };
  const sanitized = cloneState(request.state);
  randomizeHidden(sanitized, request.seed);
  const rootActions = legalActions(board, sanitized);
  if (!rootActions.length) throw new Error('Cannot search a finished game');
  if (deadlineExpired(request.deadline))
    return { action: rootActions[0], plan: [rootActions[0]], value: 0, nodes: 0, won: false };
  if (rootActions.length === 1) {
    const after = cloneState(sanitized);
    apply(board, after, rootActions[0]);
    return {
      action: rootActions[0],
      plan: [rootActions[0]],
      value: evaluate(board, after, config.weights)[player],
      nodes: 1,
      won: after.winnerId === player,
    };
  }
  let nodes = 0;
  // A proven immediate win dominates any noisy value estimate or exploration bonus.
  for (const action of rootActions) {
    if (deadlineExpired(request.deadline)) break;
    const child = cloneState(sanitized);
    apply(board, child, action);
    nodes++;
    if (child.winnerId === player) return { action, plan: [action], value: 1, nodes, won: true };
  }
  for (let iteration = 0; iteration < Math.max(1, config.budget); iteration++) {
    if (deadlineExpired(request.deadline)) break;
    const state = cloneState(request.state);
    randomizeHidden(state, Math.floor(nextRandom(random) * 4294967296));
    let node = root;
    const path: { node: Node; edge: Edge }[] = [];
    for (let depth = 0; depth < MCTS_SETTINGS.depth && state.phase !== 'gameOver'; depth++) {
      if (deadlineExpired(request.deadline)) break;
      if (state.phase === 'roll') {
        chanceStep(request, state, random);
        node = condition(node, `roll:${state.lastRoll}:${state.row.join(',')}`);
        continue;
      }
      const actions = legalActions(board, state);
      if (!actions.length) break;
      const unvisited = actions.filter((action) => !node.edges.has(actionKey(action)));
      let edge: Edge;
      let expand = false;
      if (unvisited.length) {
        // Shuffling the frontier makes player labels irrelevant while retaining seed reproducibility.
        const action = unvisited[Math.floor(nextRandom(random) * unvisited.length)];
        edge = { action, visits: 0, values: Array(state.players).fill(0), child: emptyNode() };
        node.edges.set(actionKey(action), edge);
        expand = true;
      } else {
        const actor = state.toAct;
        let best = -Infinity;
        edge = node.edges.get(actionKey(actions[0]))!;
        for (const action of actions) {
          const candidate = node.edges.get(actionKey(action))!;
          const uct =
            candidate.values[actor] / candidate.visits +
            MCTS_SETTINGS.exploration * Math.sqrt(Math.log(node.visits + 1) / candidate.visits);
          if (uct > best) {
            best = uct;
            edge = candidate;
          }
        }
      }
      path.push({ node, edge });
      apply(board, state, edge.action);
      nodes++;
      node = condition(edge.child, `cards:${state.row.join(',')}`);
      if (expand) break;
    }
    if (request.deadline !== undefined && !path.length && deadlineExpired(request.deadline)) break;
    // Finish one bounded leaf and its backup even if the final atomic move used
    // the remaining time. Every published edge value then has a full evaluation.
    backup(path, evaluate(board, state, config.weights));
  }
  const ranked = [...root.edges.values()].sort(
    (a, b) => b.visits - a.visits || b.values[player] / b.visits - a.values[player] / a.visits,
  );
  const edge = ranked[0];
  const action = edge?.action ?? rootActions[0];
  let won = false;
  if (!deadlineExpired(request.deadline)) {
    const copy = cloneState(sanitized);
    apply(board, copy, action);
    won = copy.winnerId === player;
  }
  return {
    action,
    plan: [action],
    value: edge ? edge.values[player] / edge.visits : 0,
    nodes,
    won,
  };
}
