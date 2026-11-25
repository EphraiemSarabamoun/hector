/** Public-position features in natural units: no player ID, hidden deck order or RNG is read.
 * Production is goods per two-dice roll (pips / 36), counts are unscaled, and path
 * lengths count new Tracks rather than existing Tracks. Upgrade counts are potential
 * targets capped by destination-piece supply, with affordability represented separately. Unreachable distances are
 * CONFIG.pieces.track + 1. Deficits count missing build goods after the best direct
 * market shopping plan using surplus goods; each purchase respects changing stock,
 * one-good payment, reserved build costs and the harbour floor. This deliberately
 * values immediate buying power rather than hypothetical future trades or production.
 */
import {
  Building,
  Card,
  CARD_COUNT,
  CONFIG,
  GOOD_COUNT,
  type Board,
  type GameState,
} from '../engine/index.js';

/** Stable schema shared by inference, training and the weights provenance.
 * - Score: Renown, nonnegative gap to target, and flag at target minus two or above.
 * - Production: Timber..Horses expectation, sum, positive-good count, and minimum.
 * - Hand: Timber..Horses counts, their sum, then excess over Granary-adjusted storage.
 * - Deficits: missing goods after market shopping for Track, Steading, Town,
 *   Citadel, Stratagem and Muster, independent of placement or piece availability.
 * - Sites: distance-rule-legal empty vertices touching the existing network, best
 *   raw touching-hex pips among them, and fewest new Tracks to any open site.
 * - Upgrades: potential Steading/Town targets capped by destination piece supply.
 * - Supply: remaining Tracks, Steadings, Towns, Citadels, counting pieces in use.
 * - Coast: any harbour held, occupied shrines, and new Tracks to a legal free shrine.
 * - Cards: mature Caravan/Surveyors/Tithe/Raid counts (fresh copies excluded),
 *   then Monuments and Granaries; maturity is separate from the one-play turn cap.
 * - Conflict: any own building touching the Warband hex, muster count, title flag,
 *   and own musters minus the largest opponent count, even before title eligibility.
 * - Tempo/rivals: own active-turn flag, strongest rival Renown, own-minus-rival gap.
 * Sites measure topology without affordability; path distances respect remaining
 * Track supply. Every value uses the natural units described above, without scaling.
 */
export const FEATURE_NAMES = [
  'renown',
  'distanceToWin',
  'withinTwoOfWinning',
  'productionTimber',
  'productionClay',
  'productionGrain',
  'productionBronze',
  'productionHorses',
  'productionTotal',
  'productionDiversity',
  'productionMinimum',
  'handTimber',
  'handClay',
  'handGrain',
  'handBronze',
  'handHorses',
  'handTotal',
  'storageExcess',
  'deficitTrack',
  'deficitSteading',
  'deficitTown',
  'deficitCitadel',
  'deficitCard',
  'deficitMuster',
  'reachableSteadingSites',
  'bestReachableSitePips',
  'tracksToOpenSite',
  'steadingUpgrades',
  'townUpgrades',
  'tracksLeft',
  'steadingsLeft',
  'townsLeft',
  'citadelsLeft',
  'harbourHeld',
  'shrinesHeld',
  'tracksToFreeShrine',
  'readyCaravans',
  'readySurveyors',
  'readyTithes',
  'readyRaids',
  'monuments',
  'granaries',
  'warbandOnOwnHex',
  'musters',
  'warlordHeld',
  'musterLead',
  'activePlayer',
  'strongestOpponentRenown',
  'renownLead',
] as const;

export type FeatureSign = -1 | 0 | 1;
/** Control-value priors: direct score sources, production, access and development options may
 * not be penalized. Costs still missing, travel distance, spoilage, blockade and rival score
 * may not be rewarded. These coefficient directions constrain predictive confounding; they
 * do not prove global monotonicity because other correlated features remain free.
 * In particular distanceToWin, hand counts and every unlisted feature are unconstrained.
 */
const NONNEGATIVE_FEATURES = new Set<(typeof FEATURE_NAMES)[number]>([
  'renown',
  'productionTimber',
  'productionClay',
  'productionGrain',
  'productionBronze',
  'productionHorses',
  'productionTotal',
  'productionDiversity',
  'productionMinimum',
  'harbourHeld',
  'shrinesHeld',
  'monuments',
  'granaries',
  'warlordHeld',
  'reachableSteadingSites',
  'bestReachableSitePips',
  'steadingUpgrades',
  'townUpgrades',
]);
const NONPOSITIVE_FEATURES = new Set<(typeof FEATURE_NAMES)[number]>([
  'deficitTrack',
  'deficitSteading',
  'deficitTown',
  'deficitCitadel',
  'deficitCard',
  'deficitMuster',
  'tracksToOpenSite',
  'tracksToFreeShrine',
  'storageExcess',
  'warbandOnOwnHex',
  'strongestOpponentRenown',
]);
/** One home for fit and direct-strength tuning constraints, aligned exactly with FEATURE_NAMES. */
export const FEATURE_SIGNS: readonly FeatureSign[] = Object.freeze(
  FEATURE_NAMES.map((name): FeatureSign =>
    NONNEGATIVE_FEATURES.has(name) ? 1 : NONPOSITIVE_FEATURES.has(name) ? -1 : 0,
  ),
);
/** Project finite raw coefficients onto the fixed coordinate-wise sign constraints without mutation. */
export function projectWeights(rawWeights: readonly number[]): number[] {
  if (
    !Array.isArray(rawWeights) ||
    rawWeights.length !== FEATURE_NAMES.length ||
    rawWeights.some((w) => !Number.isFinite(w))
  )
    throw new Error('Invalid weights for sign projection');
  return rawWeights.map((weight, j) =>
    FEATURE_SIGNS[j] === 1
      ? Math.max(0, weight)
      : FEATURE_SIGNS[j] === -1
        ? Math.min(0, weight)
        : weight,
  );
}

/** The contiguous hand block is the only feature slice changed by a goods-only player trade. */
export const HAND_FEATURE_OFFSET = FEATURE_NAMES.indexOf('handTimber');
const HAND_FEATURE_LENGTH = FEATURE_NAMES.indexOf('reachableSteadingSites') - HAND_FEATURE_OFFSET;
const HARBOUR_FEATURE = FEATURE_NAMES.indexOf('harbourHeld');
const HAND_COSTS = [
  CONFIG.costs.track,
  CONFIG.costs.steading,
  CONFIG.costs.town,
  CONFIG.costs.citadel,
  CONFIG.costs.card,
  CONFIG.costs.muster,
] as const;

interface Topology {
  pips: number[];
}
const topologyCache = new WeakMap<Board, Topology>();
/** Cache only immutable map facts; state-dependent occupancy is always recomputed. */
function topology(board: Board): Topology {
  let result = topologyCache.get(board);
  if (!result) {
    result = {
      pips: board.vertices.map((v) => v.hexes.reduce((sum, h) => sum + board.hexes[h].pips, 0)),
    };
    topologyCache.set(board, result);
  }
  return result;
}
interface Summary {
  production: number[][];
  hands: number[][];
  scores: number[];
  counts: number[][];
  tracks: number[];
  harbours: boolean[];
  shrines: number[];
  blocked: boolean[];
  seeds: number[][];
  open: boolean[];
}
/** Gather all seats in one board pass so vector evaluation does not repeat scans. */
function summarize(board: Board, state: GameState): Summary {
  const rows = () => Array.from({ length: state.players }, () => Array<number>(GOOD_COUNT).fill(0));
  const summary: Summary = {
    production: rows(),
    hands: rows(),
    scores: Array(state.players).fill(0),
    counts: Array.from({ length: state.players }, () => [0, 0, 0, 0]),
    tracks: Array(state.players).fill(0),
    harbours: Array(state.players).fill(false),
    shrines: Array(state.players).fill(0),
    blocked: Array(state.players).fill(false),
    seeds: Array.from({ length: state.players }, () => []),
    open: Array(board.vertices.length).fill(false),
  };
  const buildingValues = [0, CONFIG.renown.steading, CONFIG.renown.town, CONFIG.renown.citadel];
  const diceOutcomes = CONFIG.dice.sides ** CONFIG.dice.count;
  for (let p = 0; p < state.players; p++) {
    summary.scores[p] =
      state.cards[p * CARD_COUNT + Card.Monument] * CONFIG.renown.monument +
      (state.warlord === p ? CONFIG.renown.warlord : 0);
    for (let g = 0; g < GOOD_COUNT; g++) summary.hands[p][g] = state.hands[p * GOOD_COUNT + g];
  }
  for (const vertex of board.vertices) {
    const p = state.vertexOwner[vertex.id];
    if (p < 0) {
      summary.open[vertex.id] = vertex.neighbours.every((v) => state.vertexOwner[v] < 0);
      continue;
    }
    const kind = state.vertexKind[vertex.id];
    summary.counts[p][kind]++;
    summary.scores[p] += buildingValues[kind] + (vertex.shrine ? CONFIG.renown.shrine : 0);
    summary.harbours[p] ||= vertex.harbour;
    summary.shrines[p] += Number(vertex.shrine);
    summary.seeds[p].push(vertex.id);
    for (const id of vertex.hexes) {
      const hex = board.hexes[id];
      if (id === state.warband) summary.blocked[p] = true;
      if (hex.good < 0 || (id === state.warband && kind !== Building.Citadel)) continue;
      const yieldCount =
        kind === Building.Steading
          ? CONFIG.production.steading
          : kind === Building.Town
            ? CONFIG.production.town
            : CONFIG.production.citadel;
      summary.production[p][hex.good] += (yieldCount * hex.pips) / diceOutcomes;
    }
  }
  for (const edge of board.edges) {
    const p = state.edgeOwner[edge.id];
    if (p < 0) continue;
    summary.tracks[p]++;
    for (const v of edge.vertices)
      if (state.vertexOwner[v] < 0 || state.vertexOwner[v] === p) summary.seeds[p].push(v);
  }
  return summary;
}
/** New-track distances from the whole existing network; rival buildings stop traversal. */
function trackDistances(
  board: Board,
  state: GameState,
  player: number,
  seeds: readonly number[],
  tracksLeft: number,
): number[] {
  const unreachable = CONFIG.pieces.track + 1;
  const distances = Array<number>(board.vertices.length).fill(unreachable);
  let frontier: number[] = [];
  for (const v of seeds)
    if (distances[v] !== 0) {
      distances[v] = 0;
      frontier.push(v);
    }
  for (let distance = 0; distance <= tracksLeft && frontier.length; distance++) {
    const next: number[] = [];
    for (let i = 0; i < frontier.length; i++) {
      const v = frontier[i];
      if (distances[v] < distance) continue;
      for (const e of board.vertices[v].edges) {
        const owner = state.edgeOwner[e];
        if (owner >= 0 && owner !== player) continue;
        const endpoints = board.edges[e].vertices;
        const to = endpoints[0] === v ? endpoints[1] : endpoints[0];
        if (state.vertexOwner[to] >= 0 && state.vertexOwner[to] !== player) continue;
        const candidate = distance + Number(owner < 0);
        if (candidate <= tracksLeft && candidate < distances[to]) {
          distances[to] = candidate;
          if (owner === player) frontier.push(to);
          else next.push(to);
        }
      }
    }
    frontier = next;
  }
  return distances;
}
/** Price depends on the wanted stock and whether this player owns any harbour. */
function price(stock: number, harbour: boolean): number {
  const base =
    stock <= CONFIG.market.lowStock
      ? CONFIG.market.lowPrice
      : stock <= CONFIG.market.midStock
        ? CONFIG.market.midPrice
        : CONFIG.market.highPrice;
  return harbour ? Math.max(CONFIG.market.minPrice, base - CONFIG.market.harbourDiscount) : base;
}
/** Check whether tiny shopping lists fit into separate single-good payment pools. */
function canPack(items: readonly number[], capacities: number[], index = 0): boolean {
  if (index === items.length) return true;
  const item = items[index];
  let previous = -1;
  for (let i = 0; i < capacities.length; i++) {
    const capacity = capacities[i];
    if (capacity < item || capacity === previous) continue;
    previous = capacity;
    capacities[i] -= item;
    if (canPack(items, capacities, index + 1)) {
      capacities[i] += item;
      return true;
    }
    capacities[i] += item;
  }
  return false;
}
/** Find the maximum number of missing goods affordable through direct market buys. */
function deficit(
  hand: readonly number[],
  stock: Uint8Array,
  cost: readonly number[],
  harbour: boolean,
): number {
  let missing = 0;
  const purchases: number[] = [];
  const capacities: number[] = [];
  for (let g = 0; g < GOOD_COUNT; g++) {
    const need = Math.max(0, cost[g] - hand[g]);
    missing += need;
    const surplus = Math.max(0, hand[g] - cost[g]);
    if (surplus) capacities.push(surplus);
    for (let n = 0; n < Math.min(need, stock[g]); n++) purchases.push(price(stock[g] - n, harbour));
  }
  if (!missing || !capacities.length) return missing;
  purchases.sort((a, b) => a - b);
  capacities.sort((a, b) => b - a);
  const budget = capacities.reduce((a, b) => a + b, 0);
  for (let count = purchases.length; count > 0; count--) {
    const items = purchases.slice(0, count).reverse();
    if (items.reduce((a, b) => a + b, 0) <= budget && canPack(items, capacities))
      return missing - count;
  }
  return missing;
}
/** Keep ordinary extraction and cached trade valuation on the same hand/storage/market calculation. */
function handFeatures(
  state: GameState,
  player: number,
  hand: readonly number[],
  harbour: boolean,
): number[] {
  const total = hand.reduce((a, b) => a + b, 0);
  const granaries = state.cards[player * CARD_COUNT + Card.Granary];
  return [
    ...hand,
    total,
    Math.max(0, total - CONFIG.storage.base - CONFIG.storage.granary * granaries),
    ...HAND_COSTS.map((cost) => deficit(hand, state.market, cost, harbour)),
  ];
}
/** Refresh a feature row after a hand-only exchange. Map, cards, market, and active player must match
 * the source row; this deliberately avoids repeating unchanged production and network searches.
 */
export function withHandFeatures(
  source: readonly number[],
  state: GameState,
  player: number,
  hand: readonly number[],
): number[] {
  const result = [...source];
  result.splice(
    HAND_FEATURE_OFFSET,
    HAND_FEATURE_LENGTH,
    ...handFeatures(state, player, hand, Boolean(source[HARBOUR_FEATURE])),
  );
  return result;
}
/** Assemble one player's vector from the shared dynamic board summary. */
function vector(board: Board, state: GameState, player: number, summary: Summary): number[] {
  const production = summary.production[player],
    hand = summary.hands[player],
    score = summary.scores[player],
    counts = summary.counts[player];
  const tracksLeft = CONFIG.pieces.track - summary.tracks[player];
  const distances = trackDistances(board, state, player, summary.seeds[player], tracksLeft);
  const staticMap = topology(board);
  let reachable = 0,
    bestPips = 0,
    siteDistance = CONFIG.pieces.track + 1,
    shrineDistance = CONFIG.pieces.track + 1;
  for (const vertex of board.vertices)
    if (summary.open[vertex.id]) {
      const d = distances[vertex.id];
      siteDistance = Math.min(siteDistance, d);
      if (d === 0) {
        reachable++;
        bestPips = Math.max(bestPips, staticMap.pips[vertex.id]);
      }
      if (vertex.shrine) shrineDistance = Math.min(shrineDistance, d);
    }
  const cardOffset = player * CARD_COUNT,
    granaries = state.cards[cardOffset + Card.Granary];
  const ready = [Card.Caravan, Card.Surveyors, Card.Tithe, Card.Raid].map((c) =>
    Math.max(0, state.cards[cardOffset + c] - state.freshCards[cardOffset + c]),
  );
  let opponentScore = 0,
    opponentMusters = 0;
  for (let p = 0; p < state.players; p++)
    if (p !== player) {
      opponentScore = Math.max(opponentScore, summary.scores[p]);
      opponentMusters = Math.max(opponentMusters, state.musters[p]);
    }
  return [
    score,
    Math.max(0, CONFIG.renown.target - score),
    Number(score >= CONFIG.renown.target - 2),
    ...production,
    production.reduce((a, b) => a + b, 0),
    production.filter((n) => n > 0).length,
    Math.min(...production),
    ...handFeatures(state, player, hand, summary.harbours[player]),
    reachable,
    bestPips,
    siteDistance,
    Math.min(counts[Building.Steading], CONFIG.pieces.town - counts[Building.Town]),
    Math.min(counts[Building.Town], CONFIG.pieces.citadel - counts[Building.Citadel]),
    tracksLeft,
    CONFIG.pieces.steading - counts[Building.Steading],
    CONFIG.pieces.town - counts[Building.Town],
    CONFIG.pieces.citadel - counts[Building.Citadel],
    Number(summary.harbours[player]),
    summary.shrines[player],
    shrineDistance,
    ...ready,
    state.cards[cardOffset + Card.Monument],
    granaries,
    Number(summary.blocked[player]),
    state.musters[player],
    Number(state.warlord === player),
    state.musters[player] - opponentMusters,
    Number(state.active === player),
    opponentScore,
    score - opponentScore,
  ];
}
/** Goods per roll from current buildings, respecting the Warband and Citadel immunity. */
export function expectedProduction(board: Board, state: GameState, player: number): number[] {
  return summarize(board, state).production[player];
}
/** One player's natural-unit features in FEATURE_NAMES order; does not mutate state. */
export function features(board: Board, state: GameState, player: number): number[] {
  return vector(board, state, player, summarize(board, state));
}
/** Extract every player's features with shared board scans for fast vector evaluation. */
export function allFeatures(board: Board, state: GameState): number[][] {
  const summary = summarize(board, state);
  return Array.from({ length: state.players }, (_, p) => vector(board, state, p, summary));
}
