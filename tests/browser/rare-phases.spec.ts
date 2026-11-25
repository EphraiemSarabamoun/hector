/** Every tested decision uses visible controls; serialized loads arrange only the rare starting positions. */
import { expect, test, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  Building,
  Card,
  isLegal,
  legalActions,
  marketPrice,
  renown,
  serializeState,
  stateHash,
  type Action,
} from '../../src/engine/index.js';
import { gameReducer, type Session } from '../../src/ui/game.js';
import { actionLabel, playerNames } from '../../src/ui/presentation.js';
import { executeAction, loadPosition, readPosition, settleHuman } from './dom-driver.js';
import {
  fixtureSession,
  realTradeFixture,
  giveOldCard,
  nextRollSeven,
  setHand,
  showCard,
  trackLimitFixture,
  warbandFixture,
  winFixture,
} from './fixtures.js';

const browserErrors = new WeakMap<Page, string[]>();
interface CaseResult {
  title: string;
  source: 'loaded position';
  status: string;
  errors: string[];
}
// Worker replacements share their Playwright runner parent; a separate CLI invocation gets a new parent.
const runId = process.env.DARDANIA_BROWSER_RUN_ID ?? `playwright-${process.ppid}`;

/** Mirror one choice offline, then require the actual DOM transition to match its exact history, events and state. */
async function actAndCheck(page: Page, session: Session, action: Action): Promise<Session> {
  expect(isLegal(session.board, session.state, action), JSON.stringify(action)).toBe(true);
  const expected = gameReducer(session, action);
  await executeAction(page, action);
  await expect
    .poll(async () => serializeState((await readPosition(page)).state))
    .toBe(serializeState(expected.state));
  const actual = await readPosition(page);
  expect(actual.historyLength).toBe(expected.history.length);
  expect(actual.lastAction).toEqual(action);
  expect(actual.lastEvents).toEqual(expected.log.at(-1)!.events);
  return expected;
}

/** Finish the movement subphase with legal highlighted choices and optional plunder through a button. */
async function completeWarband(page: Page, session: Session): Promise<Session> {
  const action = legalActions(session.board, session.state).find((a) => a.type === 'moveWarband')!;
  session = await actAndCheck(page, session, action);
  if (session.state.phase === 'plunder')
    session = await actAndCheck(page, session, { type: 'skip' });
  expect(session.state.phase).toBe('main');
  return session;
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/?test=1');
});

/** Keep compact case evidence, including failures, and reject browser errors even when controls appeared to work. */
test.afterEach(async ({ page }, info) => {
  const errors = browserErrors.get(page) ?? [];
  // Preserve replacement-worker records, but never carry case rows from an earlier runner invocation.
  let cases: CaseResult[] = [];
  try {
    const previous = JSON.parse(await readFile('runs/dom-cases.json', 'utf8'));
    if (previous.runId === runId && Array.isArray(previous.cases)) cases = previous.cases;
  } catch {
    cases = [];
  }
  cases = cases.filter((result) => result.title !== info.title);
  cases.push({
    title: info.title,
    source: 'loaded position',
    status: errors.length ? 'failed' : (info.status ?? 'unknown'),
    errors,
  });
  await mkdir('runs', { recursive: true });
  await writeFile('runs/dom-cases.json', JSON.stringify({ runId, cases }, null, 2) + '\n');
  expect(errors, 'Rare-phase interactions must not produce page or console errors').toEqual([]);
});

test('the discard dialog resumes the identical saved state after a reload', async ({ page }) => {
  let session = fixtureSession();
  setHand(session, 0, [10, 0, 0, 0, 0]);
  setHand(session, 1, [0, 0, 0, 0, 0]);
  setHand(session, 2, [0, 0, 0, 0, 0]);
  nextRollSeven(session);
  session = gameReducer(session, { type: 'roll' });
  expect(session.state.phase).toBe('discard');
  await loadPosition(page, session);
  await expect(page.getByRole('dialog', { name: 'Discard goods' })).toBeVisible();
  const before = stateHash(session.state);
  await page.reload();
  await page.getByRole('button', { name: /^Resume saved game/ }).click();
  await expect(page.getByRole('dialog', { name: 'Discard goods' })).toBeVisible();
  expect(stateHash((await readPosition(page)).state)).toBe(before);
  expect((await readPosition(page)).historyLength).toBe(session.history.length);
  session = await actAndCheck(page, session, { type: 'discard', good: 0 });
  expect(session.state.hands[0]).toBe(9);
  expect(session.state.phase).toBe('moveWarband');
  await expect(page.getByRole('dialog', { name: 'Discard goods' })).toHaveCount(0);
});

for (const accept of [true, false]) {
  test(`answer a rival offer through the modal: ${accept ? 'accept' : 'decline'}`, async ({
    page,
  }) => {
    let session = fixtureSession();
    session.state.active = session.state.toAct = session.state.turnIndex = 1;
    setHand(session, 0, [2, 0, 0, 0, 0]);
    setHand(session, 1, [0, 2, 0, 0, 0]);
    session = gameReducer(session, {
      type: 'proposeTrade',
      to: 0,
      give: [0, 1, 0, 0, 0],
      get: [1, 0, 0, 0, 0],
    });
    await loadPosition(page, session);
    await expect(page.getByRole('dialog', { name: 'Trade offer' })).toBeVisible();
    session = await actAndCheck(page, session, { type: 'respondTrade', accept });
    expect([...session.state.hands.slice(0, 5)]).toEqual(
      accept ? [1, 1, 0, 0, 0] : [2, 0, 0, 0, 0],
    );
    await expect(page.getByRole('dialog', { name: 'Trade offer' })).toHaveCount(0);
  });
}

for (const accept of [true, false]) {
  test(`propose a trade that the normal rival worker ${accept ? 'accepts' : 'declines'}`, async ({
    page,
  }) => {
    const { session, proposal, response } = realTradeFixture(accept);
    const expected = gameReducer(gameReducer(session, proposal), response);
    await loadPosition(page, session);
    await page.evaluate(() => {
      document.addEventListener('click', (event) => {
        if ((event.target as HTMLElement).textContent === 'Propose exchange')
          document.body.dataset.tradeStarted = String(performance.now());
      });
    });
    await executeAction(page, proposal);
    await settleHuman(page);
    const responseMs = await page.evaluate(
      () => performance.now() - Number(document.body.dataset.tradeStarted),
    );
    expect(responseMs, 'Trade answers bypass the slow1350ms animation delay').toBeLessThan(1000);
    await expect(page.getByTestId('trade-result')).toContainText(
      accept ? 'accepted your offer' : 'declined your offer',
    );
    const actual = await readPosition(page);
    expect(serializeState(actual.state)).toBe(serializeState(expected.state));
    expect(actual.historyLength).toBe(session.history.length + 2);
    expect(actual.lastAction).toEqual(response);
    expect(actual.lastEvents).toEqual(expected.log.at(-1)!.events);
    expect(actual.state.proposals).toBe(1);
  });
}

for (const harbour of [false, true]) {
  test(`buy at the market ${harbour ? 'with' : 'without'} a harbour`, async ({ page }) => {
    let session = fixtureSession(harbour);
    setHand(session, 0, [0, 4, 0, 0, 0]);
    expect(
      session.board.vertices.some((v) => v.harbour && session.state.vertexOwner[v.id] === 0),
    ).toBe(harbour);
    expect(marketPrice(session.board, session.state, 0, 2)).toBe(harbour ? 2 : 3);
    await loadPosition(page, session);
    session = await actAndCheck(page, session, { type: 'marketBuy', pay: 1, get: 2 });
    expect([...session.state.hands.slice(0, 5)]).toEqual([0, harbour ? 2 : 1, 1, 0, 0]);
  });
}

for (const card of [
  Card.Caravan,
  Card.Surveyors,
  Card.Tithe,
  Card.Raid,
  Card.Monument,
  Card.Granary,
]) {
  test(`buy card kind ${card} from the public row`, async ({ page }) => {
    let session = fixtureSession();
    showCard(session, card);
    setHand(session, 0, [0, 0, 1, 1, 1]);
    await loadPosition(page, session);
    session = await actAndCheck(page, session, { type: 'buyCard', slot: 0 });
    expect(session.state.cards[card]).toBe(1);
    expect(session.state.freshCards[card]).toBe(
      card === Card.Monument || card === Card.Granary ? 0 : 1,
    );
    expect([...session.state.hands.slice(0, 5)]).toEqual([0, 0, 0, 0, 0]);
  });
}

test('play Caravan with an explicit pair of chosen goods', async ({ page }) => {
  let session = fixtureSession();
  giveOldCard(session, Card.Caravan);
  setHand(session, 0, [0, 0, 0, 0, 0]);
  await loadPosition(page, session);
  session = await actAndCheck(page, session, {
    type: 'playCard',
    card: Card.Caravan,
    goods: [0, 4],
  });
  expect([...session.state.hands.slice(0, 5)]).toEqual([1, 0, 0, 0, 1]);
});

test('play Tithe against a full and a partial rival holding', async ({ page }) => {
  let session = fixtureSession();
  giveOldCard(session, Card.Tithe);
  setHand(session, 0, [0, 0, 0, 0, 0]);
  setHand(session, 1, [0, 0, 0, 2, 0]);
  setHand(session, 2, [0, 0, 0, 1, 0]);
  await loadPosition(page, session);
  session = await actAndCheck(page, session, { type: 'playCard', card: Card.Tithe, good: 3 });
  expect(session.state.hands[3]).toBe(3);
  expect(session.state.hands[8]).toBe(0);
  expect(session.state.hands[13]).toBe(0);
});

test('play Raid and finish its highlighted Warband move', async ({ page }) => {
  let session = fixtureSession();
  giveOldCard(session, Card.Raid);
  await loadPosition(page, session);
  session = await actAndCheck(page, session, { type: 'playCard', card: Card.Raid });
  expect(session.state.musters[0]).toBe(1);
  expect(session.state.paidMuster).toBe(0);
  await completeWarband(page, session);
});

test('pay for a Muster and finish its highlighted Warband move', async ({ page }) => {
  let session = fixtureSession();
  setHand(session, 0, [0, 0, 0, 1, 1]);
  await loadPosition(page, session);
  session = await actAndCheck(page, session, { type: 'muster' });
  expect(session.state.musters[0]).toBe(1);
  expect(session.state.paidMuster).toBe(1);
  await completeWarband(page, session);
});

for (const tracks of [2, 1, 0]) {
  test(`Surveyors with ${tracks === 0 ? 'no legal Tracks' : tracks === 1 ? 'one Track then early finish' : 'two free Tracks'}`, async ({
    page,
  }) => {
    let session = tracks === 0 ? trackLimitFixture() : fixtureSession();
    giveOldCard(session, Card.Surveyors);
    await loadPosition(page, session);
    session = await actAndCheck(page, session, { type: 'playCard', card: Card.Surveyors });
    for (let i = 0; i < tracks; i++) {
      const action = legalActions(session.board, session.state).find(
        (a) => a.type === 'freeTrack',
      )!;
      session = await actAndCheck(page, session, action);
    }
    if (tracks < 2) {
      if (tracks === 0) await expect(page.getByTestId('board-choice')).toHaveCount(0);
      session = await actAndCheck(page, session, { type: 'endSurveyors' });
    }
    expect(session.state.phase).toBe('main');
    expect(session.state.freeTracks).toBe(0);
  });
}

for (const victims of [2, 1, 0] as const) {
  test(`a rolled seven moves to a hex with ${victims} eligible plunder victims`, async ({
    page,
  }) => {
    const fixture = warbandFixture(victims);
    let session = fixture.session;
    await loadPosition(page, session);
    session = await actAndCheck(page, session, { type: 'roll' });
    expect(session.state.lastRoll).toBe(7);
    expect(session.state.phase).toBe('moveWarband');
    session = await actAndCheck(page, session, { type: 'moveWarband', hex: fixture.hex });
    const plunder = legalActions(session.board, session.state).filter((a) => a.type === 'plunder');
    expect(new Set(plunder.map((a) => (a.type === 'plunder' ? a.victim : -1))).size).toBe(victims);
    await expect(page.getByRole('button', { name: /^Take .+ from / })).toHaveCount(plunder.length);
    for (const action of plunder)
      await expect(
        page.getByRole('button', {
          name: actionLabel(action, playerNames(session.settings)),
          exact: true,
        }),
      ).toBeVisible();
    if (victims) session = await actAndCheck(page, session, plunder[0]);
    expect(session.state.phase).toBe('main');
    expect([...session.state.musters]).toEqual([0, 0, 0]);
  });
}

for (const target of [Building.Town, Building.Citadel]) {
  test(`upgrade a building to kind ${target}`, async ({ page }) => {
    let session = fixtureSession();
    const vertex = session.board.vertices.find((v) => session.state.vertexOwner[v.id] === 0)!;
    if (target === Building.Citadel) session.state.vertexKind[vertex.id] = Building.Town;
    setHand(session, 0, target === Building.Town ? [0, 0, 2, 2, 1] : [1, 2, 0, 3, 0]);
    await loadPosition(page, session);
    session = await actAndCheck(page, session, { type: 'upgrade', v: vertex.id });
    expect(session.state.vertexKind[vertex.id]).toBe(target);
    expect([...session.state.hands.slice(0, 5)]).toEqual([0, 0, 0, 0, 0]);
  });
}

test('the Track build control disables at the physical fifteen-piece limit', async ({ page }) => {
  let session = trackLimitFixture(14);
  await loadPosition(page, session);
  expect(session.state.edgeOwner.filter((owner) => owner === 0).length).toBe(14);
  const action = legalActions(session.board, session.state).find((a) => a.type === 'buildTrack')!;
  session = await actAndCheck(page, session, action);
  expect(session.state.edgeOwner.filter((owner) => owner === 0).length).toBe(15);
  await expect(page.getByRole('button', { name: 'Track', exact: true })).toBeDisabled();
  expect((await readPosition(page)).historyLength).toBe(session.history.length);
  expect(legalActions(session.board, session.state).some((a) => a.type === 'buildTrack')).toBe(
    false,
  );
});

test('win through an upgrade, Rematch on the identical map, and return to New game', async ({
  page,
}) => {
  const fixture = winFixture();
  await loadPosition(page, fixture.session);
  const won = await actAndCheck(page, fixture.session, fixture.action);
  expect(renown(won.board, won.state, 0)).toBe(12);
  await expect(page.getByRole('dialog', { name: 'Game result' })).toBeVisible();
  await page.getByRole('button', { name: 'Rematch on this map', exact: true }).click();
  const rematch = await readPosition(page);
  expect(rematch.settings.seed).toBe(fixture.session.settings.seed);
  expect(rematch.board.hexes).toEqual(fixture.session.board.hexes);
  expect(rematch.state.turn).toBe(0);
  expect(rematch.historyLength).toBe(0);
  await loadPosition(page, won);
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start new game', exact: false })).toBeVisible();
  expect(await page.evaluate(() => window.__DARDANIA_TEST__?.snapshot())).toBeNull();
});
