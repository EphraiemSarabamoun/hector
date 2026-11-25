/** Atomic decisions. Proposals are validated separately because their combinations are unbounded by topology. */
import type { Card, Good } from './config.js';
export type Goods = readonly number[];
export type Action =
  | { type: 'placeSteading'; v: number }
  | { type: 'placeTrack'; e: number }
  | { type: 'roll' }
  | { type: 'discard'; good: Good }
  | { type: 'moveWarband'; hex: number }
  | { type: 'plunder'; victim: number; good: Good }
  | { type: 'skip' }
  | { type: 'buildTrack'; e: number }
  | { type: 'buildSteading'; v: number }
  | { type: 'upgrade'; v: number }
  | { type: 'marketBuy'; pay: Good; get: Good }
  | { type: 'buyCard'; slot: number }
  | { type: 'playCard'; card: Card.Caravan; goods: readonly [Good, Good] }
  | { type: 'playCard'; card: Card.Surveyors | Card.Raid }
  | { type: 'playCard'; card: Card.Tithe; good: Good }
  | { type: 'freeTrack'; e: number }
  | { type: 'endSurveyors' }
  | { type: 'muster' }
  | { type: 'proposeTrade'; to: number; give: Goods; get: Goods }
  | { type: 'respondTrade'; accept: boolean }
  | { type: 'endTurn' };
/** Events describe actual changes, with IDs into the immutable board. */
export interface GameEvent {
  type: string;
  player?: number;
  [key: string]: unknown;
}
