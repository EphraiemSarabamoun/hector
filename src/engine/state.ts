/** Compact mutable position. The immutable Board is kept outside it and shared by search nodes. */
import { CONFIG, GOOD_COUNT, CARD_COUNT } from './config.js';
import type { Board } from './board.js';
import { seedValue, shuffle } from './rng.js';
export type Phase =
  | 'setupSteading'
  | 'setupTrack'
  | 'roll'
  | 'discard'
  | 'moveWarband'
  | 'plunder'
  | 'main'
  | 'surveyors'
  | 'tradeResponse'
  | 'gameOver';
export interface GameState {
  players: number;
  rng: number;
  phase: Phase;
  active: number;
  toAct: number;
  turn: number;
  turnIndex: number;
  setupStep: number;
  lastSteading: number;
  warband: number;
  warlord: number;
  winnerId: number;
  lastRoll: number;
  played: number;
  paidMuster: number;
  proposals: number;
  freeTracks: number;
  discardCursor: number;
  tradeTo: number;
  vertexOwner: Int8Array;
  vertexKind: Uint8Array;
  edgeOwner: Int8Array;
  hands: Uint16Array;
  market: Uint8Array;
  cards: Uint8Array;
  freshCards: Uint8Array;
  musters: Uint16Array;
  turnOrder: Uint8Array;
  deck: Uint8Array;
  deckCount: number;
  row: Int8Array;
  rowCount: number;
  discarded: Uint8Array;
  tradeGive: Uint8Array;
  tradeGet: Uint8Array;
}
const arrayTypes = {
  vertexOwner: Int8Array,
  vertexKind: Uint8Array,
  edgeOwner: Int8Array,
  hands: Uint16Array,
  market: Uint8Array,
  cards: Uint8Array,
  freshCards: Uint8Array,
  musters: Uint16Array,
  turnOrder: Uint8Array,
  deck: Uint8Array,
  row: Int8Array,
  discarded: Uint8Array,
  tradeGive: Uint8Array,
  tradeGet: Uint8Array,
} as const;
/** Start setup with shuffled seats and deck. Player IDs remain stable throughout the game. */
export function createState(
  board: Board,
  seed: number | string = board.seed,
  players: number = CONFIG.players.default,
): GameState {
  if (!Number.isInteger(players) || players < CONFIG.players.min || players > CONFIG.players.max)
    throw new Error('Unsupported player count');
  const random = { rng: seedValue(`${seed}:game`) };
  const turnOrder = Uint8Array.from(
    shuffle(
      random,
      Array.from({ length: players }, (_, p) => p),
    ),
  );
  const deck = Uint8Array.from(
    shuffle(
      random,
      CONFIG.cards.counts.flatMap((n, c) => Array<number>(n).fill(c)),
    ),
  );
  const row = new Int8Array(CONFIG.cards.row).fill(-1);
  row.set(deck.subarray(0, CONFIG.cards.row));
  deck.copyWithin(0, CONFIG.cards.row);
  deck.fill(0, deck.length - CONFIG.cards.row);
  return {
    players,
    rng: random.rng,
    phase: 'setupSteading',
    active: turnOrder[0],
    toAct: turnOrder[0],
    turn: 0,
    turnIndex: 0,
    setupStep: 0,
    lastSteading: -1,
    warband: board.initialWarband,
    warlord: -1,
    winnerId: -1,
    lastRoll: 0,
    played: 0,
    paidMuster: 0,
    proposals: 0,
    freeTracks: 0,
    discardCursor: 0,
    tradeTo: -1,
    vertexOwner: new Int8Array(board.vertices.length).fill(-1),
    vertexKind: new Uint8Array(board.vertices.length),
    edgeOwner: new Int8Array(board.edges.length).fill(-1),
    hands: new Uint16Array(players * GOOD_COUNT),
    market: new Uint8Array(GOOD_COUNT).fill(CONFIG.market.initial),
    cards: new Uint8Array(players * CARD_COUNT),
    freshCards: new Uint8Array(players * CARD_COUNT),
    musters: new Uint16Array(players),
    turnOrder,
    deck,
    deckCount: deck.length - CONFIG.cards.row,
    row,
    rowCount: CONFIG.cards.row,
    discarded: new Uint8Array(CARD_COUNT),
    tradeGive: new Uint8Array(GOOD_COUNT),
    tradeGet: new Uint8Array(GOOD_COUNT),
  };
}
/** Copy only scalars and typed buffers; no mutable memory is shared with the source. */
export function cloneState(state: GameState): GameState {
  return {
    ...state,
    vertexOwner: state.vertexOwner.slice(),
    vertexKind: state.vertexKind.slice(),
    edgeOwner: state.edgeOwner.slice(),
    hands: state.hands.slice(),
    market: state.market.slice(),
    cards: state.cards.slice(),
    freshCards: state.freshCards.slice(),
    musters: state.musters.slice(),
    turnOrder: state.turnOrder.slice(),
    deck: state.deck.slice(),
    row: state.row.slice(),
    discarded: state.discarded.slice(),
    tradeGive: state.tradeGive.slice(),
    tradeGet: state.tradeGet.slice(),
  };
}
/** Serialize a position as portable JSON, retaining RNG and pending decisions. */
export function serializeState(state: GameState): string {
  return JSON.stringify(state, (_key, value) =>
    ArrayBuffer.isView(value) ? Array.from(value as unknown as ArrayLike<number>) : value,
  );
}
/** Restore the compact buffers from a JSON position produced by serializeState. */
export function deserializeState(json: string): GameState {
  const raw = JSON.parse(json);
  for (const [key, Type] of Object.entries(arrayTypes)) raw[key] = Type.from(raw[key]);
  return raw as GameState;
}
/** A stable non-cryptographic fingerprint for replay checks and transposition tables. */
export function stateHash(state: GameState): string {
  let hash = 2166136261;
  // Fold fixed-order numeric fields directly. Search visits this path frequently;
  // building JSON strings and copying typed buffers costs much more than hashing.
  for (let i = 0; i < state.phase.length; i++)
    hash = Math.imul(hash ^ state.phase.charCodeAt(i), 16777619);
  for (const field of scalarFields) hash = Math.imul(hash ^ state[field], 16777619);
  for (const field of bufferFields) {
    const buffer = state[field];
    hash = Math.imul(hash ^ buffer.length, 16777619);
    for (let i = 0; i < buffer.length; i++) hash = Math.imul(hash ^ buffer[i], 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
const scalarFields = [
  'players',
  'rng',
  'active',
  'toAct',
  'turn',
  'turnIndex',
  'setupStep',
  'lastSteading',
  'warband',
  'warlord',
  'winnerId',
  'lastRoll',
  'played',
  'paidMuster',
  'proposals',
  'freeTracks',
  'discardCursor',
  'tradeTo',
  'deckCount',
  'rowCount',
] as const;
const bufferFields = Object.keys(arrayTypes) as (keyof typeof arrayTypes)[];
/** Give a search branch its own future random stream without changing its position. */
export function reseed(state: GameState, seed: number | string): void {
  state.rng = seedValue(seed);
}

/** Replace a caller-owned clone's hidden future without consulting the real deck order.
 * The visible row and holdings stay fixed. Canonical sorting before shuffling makes
 * equivalent public positions produce identical samples for the same search seed.
 */
export function randomizeHidden(state: GameState, seed: number | string): void {
  const unseen = Array.from(state.deck.subarray(0, state.deckCount)).sort((a, b) => a - b);
  const random = { rng: seedValue(`${seed}:deck`) };
  state.deck.fill(0);
  state.deck.set(shuffle(random, unseen));
  reseed(state, `${seed}:dice`);
}
