/** Derive visible roll feedback and persistent notices from actual transitions and public board facts. */
import {
  Building,
  CONFIG,
  GOOD_COUNT,
  renown,
  type Board,
  type GameEvent,
  type GameState,
} from '../engine/index.js';
import { playerNames } from './presentation.js';
import type { Settings } from './game.js';
import { hexName } from './places.js';
export interface Notice {
  id: string;
  kind: 'plunder' | 'trade' | 'warband' | 'renown';
  message: string;
}
export interface RollFeedback {
  produced: number[];
  gains: number[][];
  at: number;
}
/** Only hexes that actually yielded to an occupied corner flash; blocked ordinary buildings do not. */
export function rollFeedback(
  board: Board,
  state: GameState,
  events: GameEvent[],
  at: number,
): RollFeedback | null {
  const roll = events.find((e) => e.type === 'roll');
  if (!roll) return null;
  const gains = Array.from({ length: state.players }, () => Array<number>(GOOD_COUNT).fill(0));
  for (const e of events)
    if (e.type === 'goods' && e.player !== undefined && Number(e.amount) > 0)
      gains[e.player][Number(e.good)] += Number(e.amount);
  const produced =
    Number(roll.total) === CONFIG.dice.lean
      ? []
      : board.hexes
          .filter(
            (h) =>
              h.number === roll.total &&
              h.vertices.some(
                (v) =>
                  state.vertexOwner[v] >= 0 &&
                  (state.warband !== h.id || state.vertexKind[v] === Building.Citadel),
              ),
          )
          .map((h) => h.id);
  return { produced, gains, at };
}
/** Critical changes remain in a queue until acknowledged; a human trade answer acknowledges its offer. */
export function transitionNotices(
  board: Board,
  before: GameState,
  after: GameState,
  events: GameEvent[],
  settings: Settings,
  decision: number,
): Notice[] {
  const names = playerNames(settings);
  const result: Notice[] = [];
  const add = (kind: Notice['kind'], message: string) =>
    result.push({ id: `${decision}-${kind}-${result.length}`, kind, message });
  for (const e of events) {
    if (e.type === 'plunder' && e.victim === 0)
      add(
        'plunder',
        `${names[Number(e.player)]} plundered your ${CONFIG.goods[Number(e.good)]}. Your stores have changed.`,
      );
    if (e.type === 'tradeProposed' && e.to === 0)
      add('trade', `${names[Number(e.player)]} has offered you a trade. Your answer is needed.`);
    if (
      e.type === 'warband' &&
      board.hexes[Number(e.hex)].vertices.some((v) => after.vertexOwner[v] === 0)
    )
      add(
        'warband',
        `The Warband has reached your land at ${hexName(board, Number(e.hex))}. Only Citadels can produce there.`,
      );
  }
  for (let p = 1; p < after.players; p++)
    if (renown(board, before, p) < 10 && renown(board, after, p) >= 10)
      add(
        'renown',
        `${names[p]} has reached ${renown(board, after, p)} Renown. The winning target is 12.`,
      );
  return result;
}
