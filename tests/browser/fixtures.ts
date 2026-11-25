/** Small serialized positions exercise infrequent UI paths while preserving ordinary engine rules. */
import assert from 'node:assert/strict';
import {
  createAIBot,
  applyWithTradeHistory,
  tradeDeclineReason,
  type TradeDeclineReason,
} from '../../src/ai/index.js';
import type { Tier } from '../../src/ui/aiPort.js';
import {
  Building,
  Card,
  apply,
  cloneState,
  isLegal,
  legalActions,
  nextRandom,
  renown,
  type Action,
} from '../../src/engine/index.js';
import { gameReducer, newSession, type Session } from '../../src/ui/game.js';

/** Play legal snake setup before isolating a human main phase; fixtures keep real map spacing and supply. */
export function fixtureSession(harbour = false, seed = 'rare-dialog-coast-24'): Session {
  let session = newSession({
    name: 'Browser house',
    colour: '#b84448',
    tiers: ['Aeneas', 'Hector'],
    seed,
    speed: 'slow',
  });
  session.state.turnOrder.set([0, 1, 2]);
  session.state.active = session.state.toAct = 0;
  while (session.state.turn === 0) {
    let action: Action | undefined;
    if (session.state.phase === 'setupSteading') {
      action = legalActions(session.board, session.state).find((a) => {
        if (a.type !== 'placeSteading') return false;
        const vertex = session.board.vertices[a.v];
        return (
          !vertex.shrine &&
          (session.state.toAct !== 0 ||
            (session.state.setupStep === 0 ? vertex.harbour === harbour : !vertex.harbour))
        );
      });
    } else action = legalActions(session.board, session.state)[0];
    assert(action, 'Fixture map must admit the requested legal setup');
    session = gameReducer(session, action);
  }
  session.state.phase = 'main';
  session.state.lastRoll = 6;
  session.notices = [];
  return session;
}

/** Set bank-supplied goods; the bank is unlimited and storage applies only during a seven. */
export function setHand(session: Session, player: number, goods: readonly number[]): void {
  session.state.hands.set(goods, player * 5);
}

/** Move an existing supply card to the human hand, preserving the deck's per-kind population. */
export function giveOldCard(session: Session, card: Card): void {
  const state = session.state;
  const deckIndex = [...state.deck.slice(0, state.deckCount)].indexOf(card);
  if (deckIndex >= 0) {
    state.deck.copyWithin(deckIndex, deckIndex + 1, state.deckCount);
    state.deck[--state.deckCount] = 0;
  } else {
    const rowIndex = [...state.row.slice(0, state.rowCount)].indexOf(card);
    assert(rowIndex >= 0, 'Requested card must remain in the public supply');
    state.row.copyWithin(rowIndex, rowIndex + 1, state.rowCount);
    state.row[--state.rowCount] = -1;
    if (state.deckCount) {
      state.row[state.rowCount++] = state.deck[0];
      state.deck.copyWithin(0, 1, state.deckCount);
      state.deck[--state.deckCount] = 0;
    }
  }
  state.cards[card]++;
}

/** Swap a requested kind into the first face-up slot without creating or deleting a card. */
export function showCard(session: Session, card: Card): void {
  const state = session.state;
  const rowIndex = [...state.row.slice(0, state.rowCount)].indexOf(card);
  if (rowIndex >= 0) {
    [state.row[0], state.row[rowIndex]] = [state.row[rowIndex], state.row[0]];
    return;
  }
  const deckIndex = [...state.deck.slice(0, state.deckCount)].indexOf(card);
  assert(deckIndex >= 0, 'Requested kind must be in the original deck');
  [state.row[0], state.deck[deckIndex]] = [state.deck[deckIndex], state.row[0]];
}

/** Select a normal RNG state whose next unforced two-dice roll is seven; the browser still rolls normally. */
export function nextRollSeven(session: Session): void {
  for (let seed = 0; seed < 1000; seed++) {
    const random = { rng: seed };
    const total = Math.floor(nextRandom(random) * 6) + Math.floor(nextRandom(random) * 6) + 2;
    if (total === 7) {
      session.state.rng = seed;
      session.state.phase = 'roll';
      return;
    }
  }
  throw new Error('No seven-producing RNG fixture found');
}

/** Place a non-adjacent fixture building and give it one incident Track, respecting piece limits. */
function installBuilding(session: Session, vertex: number, player: number, kind: Building): void {
  const { board, state } = session;
  assert(
    state.vertexOwner[vertex] < 0 &&
      board.vertices[vertex].neighbours.every((v) => state.vertexOwner[v] < 0),
    'Fixture buildings must respect spacing',
  );
  state.vertexOwner[vertex] = player;
  state.vertexKind[vertex] = kind;
  const edge = board.vertices[vertex].edges.find((e) => state.edgeOwner[e] < 0);
  assert(edge !== undefined, 'Fixture building needs an available incident Track');
  state.edgeOwner[edge] = player;
}

/** Clear only the fixture's own generated pieces before arranging a specifically spaced midgame position. */
function clearPieces(session: Session): void {
  session.state.vertexOwner.fill(-1);
  session.state.vertexKind.fill(Building.Empty);
  session.state.edgeOwner.fill(-1);
}

/** Find an empty legal site away from shrines so the fixture's score depends only on its specified pieces. */
function openSite(session: Session, player: number): number {
  const { board, state } = session;
  const site = board.vertices.find(
    (v) =>
      !v.shrine &&
      state.vertexOwner[v.id] < 0 &&
      v.neighbours.every((n) => state.vertexOwner[n] < 0),
  );
  assert(site, `Fixture map has room for house ${player}`);
  return site.id;
}

/** Arrange two separated rival sites on one destination and keep other buildings off that hex. */
export function warbandFixture(victims: 0 | 1 | 2): { session: Session; hex: number } {
  const session = fixtureSession();
  const { board, state } = session;
  clearPieces(session);
  const target = board.hexes.find(
    (h) => h.id !== state.warband && h.vertices.every((v) => !board.vertices[v].shrine),
  )!;
  assert(target, 'Fixture needs an ordinary Warband destination');
  installBuilding(
    session,
    target.vertices[0],
    1,
    victims >= 1 ? Building.Steading : Building.Citadel,
  );
  installBuilding(session, target.vertices[3], 2, victims >= 2 ? Building.Town : Building.Citadel);
  for (const player of [0, 0, 1, 2]) {
    const site = board.vertices.find(
      (v) =>
        !target.vertices.includes(v.id) &&
        !v.shrine &&
        state.vertexOwner[v.id] < 0 &&
        v.neighbours.every((n) => state.vertexOwner[n] < 0),
    );
    assert(site, 'Fixture needs ordinary non-target settlements');
    installBuilding(session, site.id, player, Building.Steading);
  }
  setHand(session, 0, [1, 1, 1, 1, 1]);
  setHand(session, 1, [1, 0, 0, 0, 0]);
  setHand(session, 2, [0, 1, 0, 0, 0]);
  nextRollSeven(session);
  return { session, hex: target.id };
}

/** Approach or fill the Track supply through paid actions, retaining a normally connected road network. */
export function trackLimitFixture(limit: 14 | 15 = 15): Session {
  let session = fixtureSession();
  setHand(session, 0, [30, 30, 0, 0, 0]);
  while (session.state.edgeOwner.filter((owner) => owner === 0).length < limit) {
    const action = legalActions(session.board, session.state).find((a) => a.type === 'buildTrack');
    assert(action, 'Fixture must extend its network to fifteen legal Tracks');
    session = gameReducer(session, action);
  }
  setHand(session, 0, [3, 3, 3, 3, 3]);
  return session;
}

/** Build eleven Renown with physical pieces, then expose a legal Town-to-Citadel upgrade worth the twelfth. */
export function winFixture(): { session: Session; action: Action } {
  const session = fixtureSession();
  clearPieces(session);
  const kinds = [
    Building.Citadel,
    Building.Town,
    Building.Town,
    Building.Town,
    Building.Steading,
    Building.Steading,
  ];
  for (const kind of kinds) installBuilding(session, openSite(session, 0), 0, kind);
  for (const player of [1, 1, 2, 2])
    installBuilding(session, openSite(session, player), player, Building.Steading);
  setHand(session, 0, [1, 2, 0, 3, 0]);
  const vertex = session.board.vertices.find(
    (v) =>
      session.state.vertexOwner[v.id] === 0 && session.state.vertexKind[v.id] === Building.Town,
  )!;
  const action: Action = { type: 'upgrade', v: vertex.id };
  assert.equal(renown(session.board, session.state, 0), 11);
  assert(isLegal(session.board, session.state, action));
  const after = cloneState(session.state);
  apply(session.board, after, action);
  assert.equal(after.winnerId, 0);
  return { session, action };
}

/** Arrange a real-policy accept/decline case; this UI fixture does not prescribe the AI's policy.
 * Seeded candidates make final model updates mechanical while both response controls remain covered.
 */
export function realTradeFixture(accept: boolean): {
  session: Session;
  proposal: Extract<Action, { type: 'proposeTrade' }>;
  response: Action;
} {
  const random = { rng: 743125 };
  for (let attempt = 0; attempt < 3000; attempt++) {
    const session = fixtureSession();
    const hand0 =
      attempt === 0
        ? accept
          ? [0, 1, 0, 3, 0]
          : [3, 0, 0, 0, 0]
        : Array.from({ length: 5 }, () => Math.floor(nextRandom(random) * 4));
    const hand1 =
      attempt === 0
        ? accept
          ? [0, 1, 2, 0, 1]
          : [0, 3, 0, 0, 0]
        : Array.from({ length: 5 }, () => Math.floor(nextRandom(random) * 4));
    setHand(session, 0, hand0);
    setHand(session, 1, hand1);
    const pay = Math.floor(nextRandom(random) * 5),
      get = (pay + 1 + Math.floor(nextRandom(random) * 4)) % 5;
    const give = Array(5).fill(0),
      receive = Array(5).fill(0);
    give[pay] = 1 + Math.floor(nextRandom(random) * 3);
    receive[get] = 1 + Math.floor(nextRandom(random) * 3);
    const proposal: Extract<Action, { type: 'proposeTrade' }> =
      attempt === 0
        ? {
            type: 'proposeTrade',
            to: 1,
            give: accept ? [0, 0, 0, 3, 0] : [1, 0, 0, 0, 0],
            get: accept ? [0, 0, 2, 0, 0] : [0, 2, 0, 0, 0],
          }
        : { type: 'proposeTrade', to: 1, give, get: receive };
    if (!isLegal(session.board, session.state, proposal)) continue;
    const offered = gameReducer(session, proposal);
    const response = createAIBot(
      session.settings.tiers[0],
      `${session.settings.seed}:ai:1`,
    ).chooseAction(session.board, offered.state, 1);
    if (response.type === 'respondTrade' && response.accept === accept)
      return { session, proposal, response };
  }
  throw new Error(
    `No real-policy ${accept ? 'accepted' : 'declined'} offer found in seeded UI fixture candidates`,
  );
}

/** Real fixed-policy responses use the same fresh per-player seed as a newly loaded browser worker. */
export function realTradeResponse(
  session: Session,
  proposal: Extract<Action, { type: 'proposeTrade' }>,
): Action {
  const state = cloneState(session.state);
  applyWithTradeHistory(session.board, state, proposal);
  return createAIBot(
    session.settings.tiers[proposal.to - 1],
    `${session.settings.seed}:ai:${proposal.to}`,
    { humanPlayers: [0] },
  ).chooseAction(session.board, state, proposal.to);
}

/** Legal setup and explicit bank goods expose table-wide history without changing any tier policy. */
export function guardedTradeSequence(
  tier: Tier,
  firstTier: Tier = tier,
): {
  session: Session;
  first: Extract<Action, { type: 'proposeTrade' }>;
  firstResponse: Action;
  second: Extract<Action, { type: 'proposeTrade' }>;
  secondResponse: Action;
} {
  const session = fixtureSession();
  session.settings.tiers = [firstTier, tier];
  setHand(session, 0, [0, 1, 0, 3, 0]);
  setHand(session, 1, [0, 1, 2, 0, 1]);
  setHand(session, 2, [0, 1, 0, 3, 1]);
  const first: Extract<Action, { type: 'proposeTrade' }> = {
    type: 'proposeTrade',
    to: 1,
    give: [0, 0, 0, 3, 0],
    get: [0, 0, 2, 0, 0],
  };
  const firstResponse = realTradeResponse(session, first);
  assert.deepEqual(
    firstResponse,
    { type: 'respondTrade', accept: true },
    `${firstTier} must accept the first actual offer`,
  );
  const after = { ...session, state: cloneState(session.state) };
  applyWithTradeHistory(after.board, after.state, first);
  applyWithTradeHistory(after.board, after.state, firstResponse);
  const second: Extract<Action, { type: 'proposeTrade' }> = {
    type: 'proposeTrade',
    to: 2,
    give: [0, 1, 0, 0, 0],
    get: [0, 0, 0, 1, 0],
  };
  const secondResponse = realTradeResponse(after, second);
  assert.deepEqual(
    secondResponse,
    ['Astyanax', 'Paris'].includes(tier)
      ? { type: 'respondTrade', accept: true }
      : { type: 'respondTrade', accept: false, reason: 'already traded this turn' },
  );
  return { session, first, firstResponse, second, secondResponse };
}

/** Exact ordinary-policy declines, including an offer that supplies the twelfth Renown upgrade. */
export function explainedTradeFixture(
  reason: Exclude<TradeDeclineReason, 'already traded this turn'>,
): {
  session: Session;
  proposal: Extract<Action, { type: 'proposeTrade' }>;
  response: Action;
} {
  const session = reason === 'would let you win' ? winFixture().session : fixtureSession();
  session.settings.tiers = ['Hector', 'Hector'];
  setHand(session, 0, reason === 'would let you win' ? [1, 2, 1, 2, 0] : [3, 0, 0, 0, 0]);
  setHand(session, 1, reason === 'would let you win' ? [0, 0, 0, 1, 0] : [0, 3, 0, 0, 0]);
  const proposal: Extract<Action, { type: 'proposeTrade' }> =
    reason === 'would let you win'
      ? { type: 'proposeTrade', to: 1, give: [0, 0, 1, 0, 0], get: [0, 0, 0, 1, 0] }
      : {
          type: 'proposeTrade',
          to: 1,
          give: [1, 0, 0, 0, 0],
          get: [0, reason === 'too many goods for too few' ? 3 : 1, 0, 0, 0],
        };
  const response = realTradeResponse(session, proposal);
  assert.equal(tradeDeclineReason(response), reason);
  if (reason === 'would let you win') {
    const hypothetical = cloneState(session.state);
    apply(session.board, hypothetical, proposal);
    apply(session.board, hypothetical, { type: 'respondTrade', accept: true });
    const upgrade = legalActions(session.board, hypothetical).find(
      (action) => action.type === 'upgrade',
    );
    assert(upgrade, 'Acceptance must enable an immediate winning upgrade');
    apply(session.board, hypothetical, upgrade);
    assert.equal(hypothetical.winnerId, 0);
  }
  return { session, proposal, response };
}
