/** Rule validation and atomic transitions. All hidden chance comes from the position's RNG. */
import { CONFIG, Good, Card, Building, GOOD_COUNT, CARD_COUNT } from './config.js';
import type { Board } from './board.js';
import type { Action, GameEvent } from './actions.js';
import type { GameState } from './state.js';
import { nextRandom } from './rng.js';
const goods = Array.from({ length: GOOD_COUNT }, (_, g) => g as Good);
const inRange = (x: number, n: number) => Number.isInteger(x) && x >= 0 && x < n;
/** Eleven possible dice totals and their exact two-dice probabilities. */
export const DICE_OUTCOMES = Object.freeze(
  Array.from({ length: CONFIG.dice.sides * CONFIG.dice.count - 1 }, (_, i) => {
    const total = i + CONFIG.dice.count;
    return Object.freeze({
      total,
      probability:
        (CONFIG.dice.sides - Math.abs(CONFIG.dice.lean - total)) /
        CONFIG.dice.sides ** CONFIG.dice.count,
    });
  }),
);
/** Count pieces currently on the board; upgrades return the replaced piece to supply. */
export function pieceCount(state: GameState, player: number, kind: Building | 'track'): number {
  let count = 0;
  const owners = kind === 'track' ? state.edgeOwner : state.vertexOwner;
  for (let i = 0; i < owners.length; i++)
    if (owners[i] === player && (kind === 'track' || state.vertexKind[i] === kind)) count++;
  return count;
}
/** Total goods held, used for storage and the turn-cap tiebreaker. */
export function handSize(state: GameState, player: number): number {
  let n = 0;
  for (const g of goods) n += state.hands[player * GOOD_COUNT + g];
  return n;
}
/** Storage includes all permanent Granaries already bought. */
export function storageLimit(state: GameState, player: number): number {
  return (
    CONFIG.storage.base + CONFIG.storage.granary * state.cards[player * CARD_COUNT + Card.Granary]
  );
}
/** Recount Renown from buildings, shrine occupation, permanent cards and the current title. */
export function renown(board: Board, state: GameState, player: number): number {
  let score =
    state.cards[player * CARD_COUNT + Card.Monument] * CONFIG.renown.monument +
    (state.warlord === player ? CONFIG.renown.warlord : 0);
  const values = [0, CONFIG.renown.steading, CONFIG.renown.town, CONFIG.renown.citadel];
  for (const v of board.vertices)
    if (state.vertexOwner[v.id] === player)
      score += values[state.vertexKind[v.id]] + (v.shrine ? CONFIG.renown.shrine : 0);
  return score;
}
/** Return the winner's stable player ID, or null while play continues. */
export function winner(_board: Board, state: GameState): number | null {
  return state.winnerId < 0 ? null : state.winnerId;
}
function canPay(state: GameState, player: number, cost: readonly number[]): boolean {
  return goods.every((g) => state.hands[player * GOOD_COUNT + g] >= cost[g]);
}
function spaceForBuilding(board: Board, state: GameState, v: number): boolean {
  return (
    inRange(v, board.vertices.length) &&
    state.vertexOwner[v] < 0 &&
    board.vertices[v].neighbours.every((n) => state.vertexOwner[n] < 0)
  );
}
function connectedTrack(board: Board, state: GameState, e: number, player: number): boolean {
  return (
    inRange(e, board.edges.length) &&
    state.edgeOwner[e] < 0 &&
    board.edges[e].vertices.some(
      (v) =>
        state.vertexOwner[v] === player ||
        (state.vertexOwner[v] < 0 &&
          board.vertices[v].edges.some((other) => state.edgeOwner[other] === player)),
    )
  );
}
function connectedSteading(board: Board, state: GameState, v: number, player: number): boolean {
  return (
    spaceForBuilding(board, state, v) &&
    board.vertices[v].edges.some((e) => state.edgeOwner[e] === player)
  );
}
/** Market price for one wanted good, after a harbour discount; zero means unavailable. */
export function marketPrice(board: Board, state: GameState, player: number, get: Good): number {
  return stockPrice(
    state.market[get],
    board.vertices.some((v) => v.harbour && state.vertexOwner[v.id] === player),
  );
}
/** Apply the stock policy to an already known harbour flag, shared by validation and enumeration. */
function stockPrice(stock: number, harbour: boolean): number {
  if (!stock) return 0;
  let price: number =
    stock <= CONFIG.market.lowStock
      ? CONFIG.market.lowPrice
      : stock <= CONFIG.market.midStock
        ? CONFIG.market.midPrice
        : CONFIG.market.highPrice;
  if (harbour) price = Math.max(CONFIG.market.minPrice, price - CONFIG.market.harbourDiscount);
  return price;
}
function canPlunder(board: Board, state: GameState, victim: number): boolean {
  return (
    inRange(victim, state.players) &&
    victim !== state.active &&
    handSize(state, victim) > 0 &&
    board.hexes[state.warband].vertices.some(
      (v) =>
        state.vertexOwner[v] === victim &&
        (state.vertexKind[v] === Building.Steading || state.vertexKind[v] === Building.Town),
    )
  );
}
function validProposal(
  state: GameState,
  action: Extract<Action, { type: 'proposeTrade' }>,
): boolean {
  if (
    !inRange(action.to, state.players) ||
    action.to === state.active ||
    state.proposals >= CONFIG.trade.maxProposals
  )
    return false;
  if (
    !Array.isArray(action.give) ||
    !Array.isArray(action.get) ||
    action.give.length !== GOOD_COUNT ||
    action.get.length !== GOOD_COUNT
  )
    return false;
  let give = 0,
    get = 0;
  for (const g of goods) {
    const a = action.give[g],
      b = action.get[g];
    if (
      !Number.isInteger(a) ||
      !Number.isInteger(b) ||
      a < 0 ||
      b < 0 ||
      (a > 0 && b > 0) ||
      a > state.hands[state.active * GOOD_COUNT + g] ||
      b > state.hands[action.to * GOOD_COUNT + g]
    )
      return false;
    give += a;
    get += b;
  }
  return (
    give >= CONFIG.trade.minUnits &&
    give <= CONFIG.trade.maxUnits &&
    get >= CONFIG.trade.minUnits &&
    get <= CONFIG.trade.maxUnits
  );
}
/** Validate an atomic decision, including trade proposals omitted by legalActions. */
export function isLegal(board: Board, state: GameState, action: Action): boolean {
  if (!action || typeof action !== 'object' || state.phase === 'gameOver') return false;
  const p = state.toAct;
  switch (state.phase) {
    case 'setupSteading':
      return (
        action.type === 'placeSteading' &&
        pieceCount(state, p, Building.Steading) < CONFIG.pieces.steading &&
        spaceForBuilding(board, state, action.v)
      );
    case 'setupTrack':
      return (
        action.type === 'placeTrack' &&
        inRange(action.e, board.edges.length) &&
        state.edgeOwner[action.e] < 0 &&
        board.edges[action.e].vertices.includes(state.lastSteading) &&
        pieceCount(state, p, 'track') < CONFIG.pieces.track
      );
    case 'roll':
      return action.type === 'roll';
    case 'discard':
      return (
        action.type === 'discard' &&
        inRange(action.good, GOOD_COUNT) &&
        state.hands[p * GOOD_COUNT + action.good] > 0
      );
    case 'moveWarband':
      return (
        action.type === 'moveWarband' &&
        inRange(action.hex, board.hexes.length) &&
        action.hex !== state.warband
      );
    case 'plunder':
      return (
        action.type === 'skip' ||
        (action.type === 'plunder' &&
          canPlunder(board, state, action.victim) &&
          inRange(action.good, GOOD_COUNT) &&
          state.hands[action.victim * GOOD_COUNT + action.good] > 0)
      );
    case 'surveyors':
      return (
        action.type === 'endSurveyors' ||
        (action.type === 'freeTrack' &&
          state.freeTracks > 0 &&
          pieceCount(state, p, 'track') < CONFIG.pieces.track &&
          connectedTrack(board, state, action.e, p))
      );
    case 'tradeResponse':
      return action.type === 'respondTrade' && typeof action.accept === 'boolean';
    case 'main':
      break;
  }
  switch (action.type) {
    case 'buildTrack':
      return (
        canPay(state, p, CONFIG.costs.track) &&
        pieceCount(state, p, 'track') < CONFIG.pieces.track &&
        connectedTrack(board, state, action.e, p)
      );
    case 'buildSteading':
      return (
        canPay(state, p, CONFIG.costs.steading) &&
        pieceCount(state, p, Building.Steading) < CONFIG.pieces.steading &&
        connectedSteading(board, state, action.v, p)
      );
    case 'upgrade': {
      if (!inRange(action.v, board.vertices.length) || state.vertexOwner[action.v] !== p)
        return false;
      const k = state.vertexKind[action.v];
      return k === Building.Steading
        ? canPay(state, p, CONFIG.costs.town) &&
            pieceCount(state, p, Building.Town) < CONFIG.pieces.town
        : k === Building.Town &&
            canPay(state, p, CONFIG.costs.citadel) &&
            pieceCount(state, p, Building.Citadel) < CONFIG.pieces.citadel;
    }
    case 'marketBuy':
      return (
        inRange(action.pay, GOOD_COUNT) &&
        inRange(action.get, GOOD_COUNT) &&
        action.pay !== action.get &&
        state.market[action.get] > 0 &&
        state.hands[p * GOOD_COUNT + action.pay] >= marketPrice(board, state, p, action.get)
      );
    case 'buyCard':
      return inRange(action.slot, state.rowCount) && canPay(state, p, CONFIG.costs.card);
    case 'playCard': {
      if (
        ![Card.Caravan, Card.Surveyors, Card.Tithe, Card.Raid].includes(action.card) ||
        state.played >= CONFIG.cards.playsPerTurn ||
        state.cards[p * CARD_COUNT + action.card] <= state.freshCards[p * CARD_COUNT + action.card]
      )
        return false;
      if (action.card === Card.Caravan)
        return (
          Array.isArray(action.goods) &&
          action.goods.length === CONFIG.cards.caravanGoods &&
          Array.from(action.goods).every((g) => inRange(g, GOOD_COUNT))
        );
      if (action.card === Card.Tithe) return inRange(action.good, GOOD_COUNT);
      return true;
    }
    case 'muster':
      return state.paidMuster < CONFIG.muster.paidPerTurn && canPay(state, p, CONFIG.costs.muster);
    case 'proposeTrade':
      return validProposal(state, action);
    case 'endTurn':
      return true;
    default:
      return false;
  }
}
/** Enumerate every distinct legal decision except proposeTrade, whose goods vectors are validated by isLegal. */
export function legalActions(board: Board, state: GameState): Action[] {
  const result: Action[] = [];
  const p = state.toAct;
  const add = (a: Action) => {
    if (isLegal(board, state, a)) result.push(a);
  };
  switch (state.phase) {
    case 'gameOver':
      return result;
    case 'setupSteading':
      for (const v of board.vertices)
        if (spaceForBuilding(board, state, v.id)) result.push({ type: 'placeSteading', v: v.id });
      return result;
    case 'setupTrack':
      for (const e of board.vertices[state.lastSteading].edges) add({ type: 'placeTrack', e });
      return result;
    case 'roll':
      return [{ type: 'roll' }];
    case 'discard':
      for (const good of goods)
        if (state.hands[p * GOOD_COUNT + good]) result.push({ type: 'discard', good });
      return result;
    case 'moveWarband':
      return board.hexes
        .filter((h) => h.id !== state.warband)
        .map((h) => ({ type: 'moveWarband', hex: h.id }));
    case 'plunder':
      for (let victim = 0; victim < state.players; victim++)
        if (canPlunder(board, state, victim))
          for (const good of goods)
            if (state.hands[victim * GOOD_COUNT + good])
              result.push({ type: 'plunder', victim, good });
      result.push({ type: 'skip' });
      return result;
    case 'tradeResponse':
      return [
        { type: 'respondTrade', accept: true },
        { type: 'respondTrade', accept: false },
      ];
    case 'surveyors':
      if (pieceCount(state, p, 'track') < CONFIG.pieces.track)
        for (const e of board.edges)
          if (connectedTrack(board, state, e.id, p)) result.push({ type: 'freeTrack', e: e.id });
      result.push({ type: 'endSurveyors' });
      return result;
    case 'main':
      break;
  }
  const counts = [0, 0, 0, 0];
  let harbour = false;
  for (const v of board.vertices)
    if (state.vertexOwner[v.id] === p) {
      counts[state.vertexKind[v.id]]++;
      if (v.harbour) harbour = true;
    }
  if (canPay(state, p, CONFIG.costs.track) && pieceCount(state, p, 'track') < CONFIG.pieces.track)
    for (const e of board.edges)
      if (connectedTrack(board, state, e.id, p)) result.push({ type: 'buildTrack', e: e.id });
  if (canPay(state, p, CONFIG.costs.steading) && counts[Building.Steading] < CONFIG.pieces.steading)
    for (const v of board.vertices)
      if (connectedSteading(board, state, v.id, p)) result.push({ type: 'buildSteading', v: v.id });
  const canTown = counts[Building.Town] < CONFIG.pieces.town && canPay(state, p, CONFIG.costs.town);
  const canCitadel =
    counts[Building.Citadel] < CONFIG.pieces.citadel && canPay(state, p, CONFIG.costs.citadel);
  for (const v of board.vertices)
    if (
      state.vertexOwner[v.id] === p &&
      ((state.vertexKind[v.id] === Building.Steading && canTown) ||
        (state.vertexKind[v.id] === Building.Town && canCitadel))
    )
      result.push({ type: 'upgrade', v: v.id });
  const prices = goods.map((get) => stockPrice(state.market[get], harbour));
  for (const pay of goods)
    for (const get of goods)
      if (pay !== get && prices[get] > 0 && state.hands[p * GOOD_COUNT + pay] >= prices[get])
        result.push({ type: 'marketBuy', pay, get });
  if (canPay(state, p, CONFIG.costs.card))
    for (let slot = 0; slot < state.rowCount; slot++) result.push({ type: 'buyCard', slot });
  if (state.played < CONFIG.cards.playsPerTurn)
    for (const card of [Card.Caravan, Card.Surveyors, Card.Tithe, Card.Raid] as const) {
      if (state.cards[p * CARD_COUNT + card] <= state.freshCards[p * CARD_COUNT + card]) continue;
      if (card === Card.Caravan)
        for (const first of goods)
          for (const second of goods) {
            if (second >= first) result.push({ type: 'playCard', card, goods: [first, second] });
          }
      else if (card === Card.Tithe)
        for (const good of goods) result.push({ type: 'playCard', card, good });
      else result.push({ type: 'playCard', card });
    }
  add({ type: 'muster' });
  result.push({ type: 'endTurn' });
  return result;
}
function pay(state: GameState, p: number, cost: readonly number[], events: GameEvent[]): void {
  for (const g of goods) state.hands[p * GOOD_COUNT + g] -= cost[g];
  events.push({ type: 'paid', player: p, goods: [...cost] });
}
function gain(state: GameState, p: number, good: Good, amount: number, events: GameEvent[]): void {
  if (amount) {
    state.hands[p * GOOD_COUNT + good] += amount;
    events.push({ type: 'goods', player: p, good, amount });
  }
}
function draw(state: GameState): void {
  while (state.rowCount < CONFIG.cards.row && state.deckCount > 0) {
    state.row[state.rowCount++] = state.deck[0];
    state.deck.copyWithin(0, 1, state.deckCount);
    state.deck[--state.deckCount] = 0;
  }
}
function main(state: GameState): void {
  state.phase = 'main';
  state.toAct = state.active;
}
function move(state: GameState): void {
  state.phase = 'moveWarband';
  state.toAct = state.active;
}
function title(state: GameState, p: number, events: GameEvent[]): void {
  state.musters[p]++;
  if (
    state.musters[p] >= CONFIG.warlord.minimum &&
    (state.warlord < 0 || state.musters[p] > state.musters[state.warlord])
  ) {
    const previous = state.warlord;
    state.warlord = p;
    events.push({ type: 'warlord', player: p, previous });
  }
}
function checkWin(board: Board, state: GameState, events: GameEvent[]): void {
  if (state.turn > 0 && renown(board, state, state.active) >= CONFIG.renown.target) {
    state.phase = 'gameOver';
    state.winnerId = state.active;
    state.toAct = state.active;
    events.push({ type: 'winner', player: state.active, reason: 'renown' });
  }
}
function finishLeanSeason(state: GameState, events: GameEvent[]): void {
  for (const g of goods)
    state.market[g] += Math.sign(CONFIG.market.initial - state.market[g]) * CONFIG.market.drift;
  if (state.rowCount) {
    state.deck[state.deckCount++] = state.row[0];
    state.row.copyWithin(0, 1, state.rowCount);
    state.row[--state.rowCount] = -1;
  }
  draw(state);
  events.push({ type: 'leanSeason', market: [...state.market], row: [...state.row] });
  move(state);
}
function nextDiscard(state: GameState, events: GameEvent[]): void {
  while (state.discardCursor < state.players) {
    const p = state.turnOrder[(state.turnIndex + state.discardCursor) % state.players];
    if (handSize(state, p) > storageLimit(state, p)) {
      state.toAct = p;
      state.phase = 'discard';
      return;
    }
    state.discardCursor++;
  }
  finishLeanSeason(state, events);
}
/** Apply a legal decision in place and return concrete events. A forced total enumerates chance without advancing RNG. */
export function apply(
  board: Board,
  state: GameState,
  action: Action,
  forcedDice?: number | { forcedTotal?: number },
): GameEvent[] {
  if (!isLegal(board, state, action)) throw new Error(`Illegal ${action.type} in ${state.phase}`);
  const forced = typeof forcedDice === 'number' ? forcedDice : forcedDice?.forcedTotal;
  if (
    forced !== undefined &&
    (action.type !== 'roll' || !DICE_OUTCOMES.some((o) => o.total === forced))
  )
    throw new Error('Invalid forced dice total');
  const events: GameEvent[] = [];
  const p = state.toAct;
  switch (action.type) {
    case 'placeSteading': {
      state.vertexOwner[action.v] = p;
      state.vertexKind[action.v] = Building.Steading;
      state.lastSteading = action.v;
      for (const h of board.vertices[action.v].hexes)
        if (board.hexes[h].good >= 0)
          gain(state, p, board.hexes[h].good, CONFIG.setup.production, events);
      state.phase = 'setupTrack';
      events.push({ type: 'building', player: p, v: action.v, kind: Building.Steading });
      break;
    }
    case 'placeTrack': {
      state.edgeOwner[action.e] = p;
      events.push({ type: 'track', player: p, e: action.e });
      state.setupStep++;
      if (state.setupStep === CONFIG.setup.rounds * state.players) {
        state.active = state.turnOrder[0];
        state.toAct = state.active;
        state.turnIndex = 0;
        state.turn = 1;
        state.phase = 'roll';
      } else {
        const index =
          state.setupStep < state.players
            ? state.setupStep
            : CONFIG.setup.rounds * state.players - 1 - state.setupStep;
        state.active = state.turnOrder[index];
        state.toAct = state.active;
        state.phase = 'setupSteading';
      }
      break;
    }
    case 'roll': {
      const total =
        forced ??
        Array.from(
          { length: CONFIG.dice.count },
          () => Math.floor(nextRandom(state) * CONFIG.dice.sides) + 1,
        ).reduce((a, b) => a + b, 0);
      state.lastRoll = total;
      events.push({ type: 'roll', player: p, total });
      if (total === CONFIG.dice.lean) {
        state.discardCursor = 0;
        nextDiscard(state, events);
      } else {
        for (const h of board.hexes)
          if (h.number === total && h.good >= 0)
            for (const v of h.vertices) {
              const owner = state.vertexOwner[v],
                kind = state.vertexKind[v];
              if (owner >= 0 && (h.id !== state.warband || kind === Building.Citadel))
                gain(
                  state,
                  owner,
                  h.good,
                  kind === Building.Steading
                    ? CONFIG.production.steading
                    : kind === Building.Town
                      ? CONFIG.production.town
                      : CONFIG.production.citadel,
                  events,
                );
            }
        main(state);
      }
      break;
    }
    case 'discard':
      state.hands[p * GOOD_COUNT + action.good]--;
      events.push({ type: 'discard', player: p, good: action.good });
      nextDiscard(state, events);
      break;
    case 'moveWarband':
      state.warband = action.hex;
      events.push({ type: 'warband', player: p, hex: action.hex });
      if (
        Array.from({ length: state.players }, (_, q) => q).some((q) => canPlunder(board, state, q))
      )
        state.phase = 'plunder';
      else main(state);
      break;
    case 'plunder':
      state.hands[action.victim * GOOD_COUNT + action.good] -= CONFIG.muster.plunderGoods;
      gain(state, p, action.good, CONFIG.muster.plunderGoods, events);
      events.push({ type: 'plunder', player: p, victim: action.victim, good: action.good });
      main(state);
      break;
    case 'skip':
      main(state);
      break;
    case 'buildTrack':
      pay(state, p, CONFIG.costs.track, events);
      state.edgeOwner[action.e] = p;
      events.push({ type: 'track', player: p, e: action.e });
      break;
    case 'buildSteading':
      pay(state, p, CONFIG.costs.steading, events);
      state.vertexOwner[action.v] = p;
      state.vertexKind[action.v] = Building.Steading;
      events.push({ type: 'building', player: p, v: action.v, kind: Building.Steading });
      break;
    case 'upgrade':
      pay(
        state,
        p,
        state.vertexKind[action.v] === Building.Steading ? CONFIG.costs.town : CONFIG.costs.citadel,
        events,
      );
      state.vertexKind[action.v]++;
      events.push({ type: 'building', player: p, v: action.v, kind: state.vertexKind[action.v] });
      break;
    case 'marketBuy': {
      const price = marketPrice(board, state, p, action.get);
      state.hands[p * GOOD_COUNT + action.pay] -= price;
      gain(state, p, action.get, 1, events);
      state.market[action.get]--;
      state.market[action.pay] = Math.min(CONFIG.market.max, state.market[action.pay] + 1);
      events.push({ type: 'market', player: p, pay: action.pay, get: action.get, price });
      break;
    }
    case 'buyCard': {
      pay(state, p, CONFIG.costs.card, events);
      const card = state.row[action.slot];
      state.cards[p * CARD_COUNT + card]++;
      if (card !== Card.Monument && card !== Card.Granary)
        state.freshCards[p * CARD_COUNT + card]++;
      state.row.copyWithin(action.slot, action.slot + 1, state.rowCount);
      state.row[--state.rowCount] = -1;
      draw(state);
      events.push({ type: 'cardBought', player: p, card, slot: action.slot });
      break;
    }
    case 'playCard': {
      state.cards[p * CARD_COUNT + action.card]--;
      state.discarded[action.card]++;
      state.played++;
      events.push({ type: 'cardPlayed', player: p, card: action.card });
      if (action.card === Card.Caravan) for (const g of action.goods) gain(state, p, g, 1, events);
      else if (action.card === Card.Tithe) {
        for (let q = 0; q < state.players; q++)
          if (q !== p) {
            const n = Math.min(CONFIG.cards.titheGoods, state.hands[q * GOOD_COUNT + action.good]);
            state.hands[q * GOOD_COUNT + action.good] -= n;
            gain(state, p, action.good, n, events);
          }
      } else if (action.card === Card.Surveyors) {
        state.freeTracks = CONFIG.cards.surveyorTracks;
        state.phase = 'surveyors';
      } else {
        title(state, p, events);
        move(state);
      }
      break;
    }
    case 'freeTrack':
      state.edgeOwner[action.e] = p;
      state.freeTracks--;
      events.push({ type: 'track', player: p, e: action.e, free: true });
      if (!state.freeTracks) main(state);
      break;
    case 'endSurveyors':
      state.freeTracks = 0;
      main(state);
      break;
    case 'muster':
      pay(state, p, CONFIG.costs.muster, events);
      state.paidMuster++;
      title(state, p, events);
      move(state);
      break;
    case 'proposeTrade':
      state.proposals++;
      state.tradeTo = action.to;
      state.tradeGive.set(action.give);
      state.tradeGet.set(action.get);
      state.toAct = action.to;
      state.phase = 'tradeResponse';
      events.push({
        type: 'tradeProposed',
        player: p,
        to: action.to,
        give: [...action.give],
        get: [...action.get],
      });
      break;
    case 'respondTrade': {
      if (action.accept)
        for (const g of goods) {
          const n = state.tradeGet[g] - state.tradeGive[g];
          state.hands[state.active * GOOD_COUNT + g] += n;
          state.hands[p * GOOD_COUNT + g] -= n;
        }
      events.push({ type: 'tradeResponse', player: p, accept: action.accept });
      state.tradeTo = -1;
      state.tradeGive.fill(0);
      state.tradeGet.fill(0);
      main(state);
      break;
    }
    case 'endTurn': {
      if (state.turn >= CONFIG.turnCap) {
        const ranking = [...state.turnOrder].sort(
          (a, b) =>
            renown(board, state, b) - renown(board, state, a) ||
            handSize(state, b) - handSize(state, a) ||
            [...state.turnOrder].indexOf(a) - [...state.turnOrder].indexOf(b),
        );
        state.winnerId = ranking[0];
        state.phase = 'gameOver';
        state.toAct = ranking[0];
        events.push({ type: 'winner', player: ranking[0], reason: 'turnCap' });
        return events;
      }
      state.freshCards.fill(0, p * CARD_COUNT, (p + 1) * CARD_COUNT);
      state.turn++;
      state.turnIndex = (state.turnIndex + 1) % state.players;
      state.active = state.turnOrder[state.turnIndex];
      state.toAct = state.active;
      state.played = 0;
      state.paidMuster = 0;
      state.proposals = 0;
      state.phase = 'roll';
      events.push({ type: 'turn', player: state.active, turn: state.turn });
      break;
    }
  }
  checkWin(board, state, events);
  return events;
}
