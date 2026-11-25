/** Human-readable public information. Deliberately never reads state.deck or the RNG. */
import {
  Building,
  Card,
  CARD_COUNT,
  CONFIG,
  pieceCount,
  type Action,
  type Board,
  type GameEvent,
  type GameState,
} from '../engine/index.js';
import type { Settings } from './game.js';
import { edgeName, vertexName, hexName } from './places.js';
import { tradeDeclineReason } from '../ai/index.js';
export const PALETTE = ['#b84448', '#e9b84e', '#6762b8'];
export const CARD_NAMES = ['Caravan', 'Surveyors', 'Tithe', 'Raid', 'Monument', 'Granary'];
export const CARD_HELP = [
  'Take any two goods.',
  'Build up to two free Tracks.',
  'Each rival gives up to two of a named good.',
  'Move and plunder; counts as a muster.',
  'Permanent: one Renown.',
  'Permanent: three extra storage.',
];
export const GOOD_MARKS = ['♣', '▲', '≋', '▱', '♞'];
/** Names and palette remain keyed by stable player ID, even when turn order is shuffled. */
export function playerNames(settings: Settings): string[] {
  return [settings.name || 'Your house', ...settings.tiers];
}
export function playerColours(settings: Settings): string[] {
  return [settings.colour, ...PALETTE.filter((c) => c !== settings.colour)];
}
/** Explain scoring from public buildings and permanent holdings. */
export function scoreBreakdown(board: Board, state: GameState, p: number): string {
  const structures = [Building.Steading, Building.Town, Building.Citadel].map(
    (kind, i) =>
      `${pieceCount(state, p, kind)} ${['steadings', 'towns', 'citadels'][i]}: ${pieceCount(state, p, kind) * (i + 1)}`,
  );
  const shrines = board.vertices.filter((v) => v.shrine && state.vertexOwner[v.id] === p).length;
  return [
    ...structures,
    `Shrines: ${shrines}`,
    `Monuments: ${state.cards[p * CARD_COUNT + Card.Monument]}`,
    `Warlord: ${state.warlord === p ? CONFIG.renown.warlord : 0}`,
  ].join(' · ');
}
/** Label atomic choices without exposing implementation names to the player. */
export function actionLabel(a: Action, names: string[]): string {
  switch (a.type) {
    case 'roll':
      return 'Roll dice';
    case 'endTurn':
      return 'End turn';
    case 'discard':
      return `Discard ${CONFIG.goods[a.good]}`;
    case 'plunder':
      return `Take ${CONFIG.goods[a.good]} from ${names[a.victim]}`;
    case 'skip':
      return 'Skip plunder';
    case 'endSurveyors':
      return 'Finish Surveyors';
    case 'muster':
      return 'Muster';
    case 'respondTrade':
      return a.accept ? 'Accept trade' : 'Decline trade';
    case 'buyCard':
      return `Buy slot ${a.slot + 1}`;
    case 'playCard':
      return `Play ${CARD_NAMES[a.card]}${'goods' in a ? `: ${a.goods.map((g) => CONFIG.goods[g]).join(' + ')}` : 'good' in a ? `: ${CONFIG.goods[a.good]}` : ''}`;
    case 'marketBuy':
      return `Pay ${CONFIG.goods[a.pay]} for ${CONFIG.goods[a.get]}`;
    default:
      return a.type;
  }
}
/** Use the AI's reason whitelist in both the immediate answer and the saved Chronicle. */
export function tradeResponseLabel(
  event: GameEvent,
  names: string[],
  subject = 'the trade',
): string {
  const response = {
    type: 'respondTrade' as const,
    accept: event.accept === true,
    reason: event.reason,
  };
  const reason = tradeDeclineReason(response);
  return `${names[Number(event.player)]} ${response.accept ? 'accepted' : 'declined'} ${subject}${reason ? `: ${reason}` : ''}`;
}
/** Only actual apply events populate the log; costs and production retain their quantities. */
export function eventLabel(e: GameEvent, names: string[], board: Board): string {
  const who = e.player === undefined ? '' : names[e.player];
  const good = (n: unknown) => CONFIG.goods[Number(n)];
  const bundle = (v: unknown) =>
    Array.isArray(v)
      ? v
          .map((n, g) => (n ? `${n} ${CONFIG.goods[g]}` : ''))
          .filter(Boolean)
          .join(', ')
      : '';
  switch (e.type) {
    case 'paid':
      return `${who} paid ${bundle(e.goods)}`;
    case 'goods':
      return `${who} gained ${e.amount} ${good(e.good)}`;
    case 'building':
      return `${who} built a ${['', 'Steading', 'Town', 'Citadel'][Number(e.kind)]} at ${vertexName(board, Number(e.v))}`;
    case 'track':
      return `${who} laid a ${e.free ? 'free ' : ''}${edgeName(board, Number(e.e))}`;
    case 'roll':
      return `${who} rolled ${e.total}`;
    case 'leanSeason':
      return 'Lean season: spoilage, market drift and Stratagem turnover';
    case 'discard':
      return `${who} discarded one ${good(e.good)}`;
    case 'warband':
      return `${who} moved the Warband to ${hexName(board, Number(e.hex))}`;
    case 'plunder':
      return `${who} took ${good(e.good)} from ${names[Number(e.victim)]}`;
    case 'market':
      return `${who} bought ${good(e.get)} with ${e.price} ${good(e.pay)}`;
    case 'cardBought':
      return `${who} bought ${CARD_NAMES[Number(e.card)]}`;
    case 'cardPlayed':
      return `${who} played ${CARD_NAMES[Number(e.card)]}`;
    case 'tradeProposed':
      return `${who} offered ${bundle(e.give)} to ${names[Number(e.to)]} for ${bundle(e.get)}`;
    case 'tradeResponse':
      return tradeResponseLabel(e, names);
    case 'warlord':
      return `${who} claimed Warlord`;
    case 'turn':
      return `${who} begins turn ${e.turn}`;
    case 'winner':
      return `${who} wins${e.reason === 'turnCap' ? ' at the 600-turn limit' : ' with 12 Renown'}`;
    default:
      return `${who}: ${e.type}`;
  }
}
