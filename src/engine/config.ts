/** The single source of game numbers. Arrays use Timber, Clay, Grain, Bronze, Horses order. */
const data = {
  players: { min: 2, max: 4, default: 3 },
  map: {
    radius: 3,
    land: 22,
    productivePerTerrain: 4,
    barrens: 2,
    neighbourWeight: 2,
    minNeighbours: 2,
    maxSameTerrainNeighbours: 1,
    attempts: 200,
    shrines: 3,
    shrineDistance: 5,
    shrineHexes: 2,
    harbours: 4,
    harbourDistance: 4,
    harbourShrineDistance: 2,
    coastalHexes: 3,
    tokens: [2, 3, 3, 4, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 10, 11, 11, 12],
    hotTokens: [6, 8],
    minPips: 10,
    maxPips: 16,
  },
  pieces: { track: 15, steading: 5, town: 4, citadel: 2 },
  goods: ['Timber', 'Clay', 'Grain', 'Bronze', 'Horses'],
  terrain: ['Forest', 'Clay Hills', 'Fields', 'Mines', 'Pasture', 'Barrens'],
  costs: {
    track: [1, 1, 0, 0, 0],
    steading: [1, 1, 1, 0, 1],
    town: [0, 0, 2, 2, 1],
    citadel: [1, 2, 0, 3, 0],
    card: [0, 0, 1, 1, 1],
    muster: [0, 0, 0, 1, 1],
  },
  renown: { steading: 1, town: 2, citadel: 3, shrine: 1, monument: 1, warlord: 2, target: 12 },
  setup: { rounds: 2, production: 1 },
  dice: { sides: 6, count: 2, lean: 7 },
  production: { steading: 1, town: 2, citadel: 2 },
  storage: { base: 9, granary: 3 },
  market: {
    initial: 3,
    max: 6,
    lowStock: 2,
    midStock: 4,
    lowPrice: 4,
    midPrice: 3,
    highPrice: 2,
    harbourDiscount: 1,
    minPrice: 2,
    drift: 1,
  },
  trade: { minUnits: 1, maxUnits: 3, maxProposals: 4 },
  cards: {
    row: 3,
    counts: [5, 4, 3, 5, 4, 3],
    caravanGoods: 2,
    surveyorTracks: 2,
    titheGoods: 2,
    playsPerTurn: 1,
  },
  warlord: { minimum: 3 },
  muster: { paidPerTurn: 1, plunderGoods: 1 },
  turnCap: 600,
} as const;
/** Freeze all nested rule values so simulations cannot accidentally tune a live game. */
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export const CONFIG = freeze(data);
/** Stable public IDs used in typed arrays. These are encodings, not rule quantities. */
export enum Good {
  Timber,
  Clay,
  Grain,
  Bronze,
  Horses,
}
export enum Card {
  Caravan,
  Surveyors,
  Tithe,
  Raid,
  Monument,
  Granary,
}
export enum Building {
  Empty,
  Steading,
  Town,
  Citadel,
}
export const GOOD_COUNT = CONFIG.goods.length;
export const CARD_COUNT = CONFIG.cards.counts.length;
