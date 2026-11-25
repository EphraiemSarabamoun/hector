/** Integration-specific promises: real tier copy, exact exchange language, and clean navigation cancellation. */
import { expect, test } from '@playwright/test';
import {
  fixtureSession,
  setHand,
  guardedTradeSequence,
  explainedTradeFixture,
} from './fixtures.js';
import { gameReducer } from '../../src/ui/game.js';
import { executeAction, loadPosition, readPosition, settleHuman } from './dom-driver.js';
import { cloneState, serializeState, type Action } from '../../src/engine/index.js';
import { applyWithTradeHistory, hasAcceptedTrade, tradeDeclineReason } from '../../src/ai/index.js';
import type { Session } from '../../src/ui/game.js';

test('real tier descriptions replace the preview and a new game cancels a rival worker', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/?test=1');
  await expect(
    page.getByText(/greedy preview|all five tiers currently use the same greedy/i),
  ).toHaveCount(0);
  await expect(page.getByLabel('Opponent 2')).toHaveValue('Hector');
  const session = fixtureSession();
  session.settings.tiers = ['Hector', 'Hector'];
  session.state.active = session.state.toAct = session.state.turnIndex = 1;
  setHand(session, 1, [4, 4, 4, 4, 4]);
  const workerAppeared = page.waitForEvent('worker');
  await loadPosition(page, session);
  await expect(page.getByTestId('thinking-time')).toBeVisible();
  await expect(page.getByTestId('thinking-time')).toContainText(/Thinking… [0-9.]+s/);
  const worker = await workerAppeared;
  const closed = worker.waitForEvent('close');
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await closed;
  await expect(page.getByRole('heading', { name: 'Found your house' })).toBeVisible();
  await page.getByLabel('Map seed', { exact: false }).fill('integration-new-after-cancel');
  await page.getByRole('button', { name: 'Start new game', exact: false }).click();
  await expect(page.getByTestId('game')).toHaveAttribute('data-turn', '0');
  await page.waitForTimeout(100);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a rival offer names exactly the goods entering and leaving the human hand', async ({
  page,
}) => {
  await page.goto('/?test=1');
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
  const dialog = page.getByRole('dialog', { name: 'Trade offer' });
  await expect(dialog).toContainText('You receive 1 Clay.');
  await expect(dialog).toContainText('You give 1 Timber.');
});

/** Arrange a natural shortage for the unchanged real Hector policy, with both legal partners. */
function hectorTradeSession() {
  const session = fixtureSession(false, 'final-human-trade-3');
  session.settings.tiers = ['Hector', 'Hector'];
  session.settings.speed = 'slow';
  session.state.active = session.state.toAct = session.state.turnIndex = 2;
  // Seeded legal setup found with the shipped tuned model; both partners can supply Timber.
  setHand(session, 0, [1, 0, 0, 3, 1]);
  setHand(session, 1, [2, 3, 2, 3, 0]);
  setHand(session, 2, [0, 2, 2, 0, 3]);
  return session;
}

/** Audit returned engine actions rather than transient dialogs, including bot-to-bot offers. */
async function expectHectorRecipients(
  page: import('@playwright/test').Page,
  session: ReturnType<typeof fixtureSession>,
) {
  await settleHuman(page);
  const after = await readPosition(page);
  const replay = cloneState(session.state);
  const recipients: number[] = [];
  for (const action of after.history.slice(session.history.length)) {
    if (replay.turn !== session.state.turn || replay.active !== session.state.active) break;
    if (action.type === 'proposeTrade') recipients.push(action.to);
    applyWithTradeHistory(session.board, replay, action);
  }
  expect(recipients).toEqual([0, 1]);
}

/** Real Hector may continue trading with its rival after the human declines its sole offer. */
test('Hector offers once to the human and can send its second offer to the other bot', async ({
  page,
}) => {
  await page.goto('/?test=1');
  const session = hectorTradeSession();
  session.settings.speed = 'instant';
  await loadPosition(page, session);
  await expect(page.getByRole('dialog', { name: 'Trade offer' })).toBeVisible();
  expect((await readPosition(page)).lastAction).toMatchObject({ type: 'proposeTrade', to: 0 });
  await executeAction(page, { type: 'respondTrade', accept: false });
  await expectHectorRecipients(page, session);
});

for (const reset of ['pace change', 'menu and resume', 'reload and resume']) {
  test(`a declined human offer stays capped after ${reset}`, async ({ page }) => {
    await page.goto('/?test=1');
    const session = hectorTradeSession();
    await loadPosition(page, session);
    await expect(page.getByRole('dialog', { name: 'Trade offer' })).toBeVisible();
    await executeAction(page, { type: 'respondTrade', accept: false });
    // Slow pacing leaves time to reset the worker after the saved decline, before its next action.
    if (reset === 'menu and resume')
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
    if (reset === 'reload and resume') await page.reload();
    if (reset !== 'pace change')
      await page.getByRole('button', { name: 'Resume saved game', exact: false }).click();
    await page.getByLabel('Rival pace', { exact: true }).selectOption('instant');
    await expectHectorRecipients(page, session);
  });
}

/** Compare the full real position and concrete response events with the wrapper, not a duplicate UI policy. */
async function expectRealBotTrade(
  page: import('@playwright/test').Page,
  before: Session,
  proposal: Extract<Action, { type: 'proposeTrade' }>,
  response: Action,
): Promise<Session> {
  const state = cloneState(before.state);
  applyWithTradeHistory(before.board, state, proposal);
  const events = applyWithTradeHistory(before.board, state, response);
  await executeAction(page, proposal);
  await settleHuman(page);
  const after = await readPosition(page);
  expect(serializeState(after.state)).toBe(serializeState(state));
  expect(after.lastAction).toEqual(response);
  expect(after.lastEvents).toEqual(events);
  const reason = tradeDeclineReason(response);
  await expect(page.getByTestId('trade-result')).toContainText(
    response.type === 'respondTrade' && response.accept
      ? 'accepted your offer'
      : 'declined your offer',
  );
  if (reason) {
    await expect(page.getByTestId('trade-result')).toContainText(reason);
    await page.getByRole('button', { name: /Expand.*entries/ }).click();
    await expect(page.getByRole('log', { name: 'Event chronicle' })).toContainText(reason);
    await page.getByRole('button', { name: /Collapse.*entries/ }).click();
  }
  return { ...before, state };
}

for (const tier of ['Aeneas', 'Sarpedon', 'Hector'] as const) {
  test(`${tier} declines a second human offer after another rival accepted this turn`, async ({
    page,
  }) => {
    await page.goto('/?test=1');
    const fixture = guardedTradeSequence(tier);
    await loadPosition(page, fixture.session);
    const accepted = await expectRealBotTrade(
      page,
      fixture.session,
      fixture.first,
      fixture.firstResponse,
    );
    expect(hasAcceptedTrade(accepted.board, accepted.state, 0)).toBe(true);
    await expectRealBotTrade(page, accepted, fixture.second, fixture.secondResponse);
  });
}

for (const tier of ['Astyanax', 'Paris'] as const) {
  test(`${tier} still accepts a useful second human offer in the same turn`, async ({ page }) => {
    await page.goto('/?test=1');
    const fixture = guardedTradeSequence(tier);
    await loadPosition(page, fixture.session);
    const accepted = await expectRealBotTrade(
      page,
      fixture.session,
      fixture.first,
      fixture.firstResponse,
    );
    await expectRealBotTrade(page, accepted, fixture.second, fixture.secondResponse);
  });
}

for (const legacy of [false, true]) {
  test(`accepted human trade remains table-wide after ${legacy ? 'legacy save' : 'current save'} reload`, async ({
    page,
  }) => {
    await page.goto('/?test=1');
    // A generous recipient's acceptance also spends the proposer's guarded allowance.
    const fixture = guardedTradeSequence('Hector', 'Astyanax');
    await loadPosition(page, fixture.session);
    const accepted = await expectRealBotTrade(
      page,
      fixture.session,
      fixture.first,
      fixture.firstResponse,
    );
    if (legacy)
      await page.evaluate(() => {
        const save = JSON.parse(localStorage.getItem('dardania.save.v1')!);
        const state = JSON.parse(save.state);
        delete state.aiTradeHistory;
        save.state = JSON.stringify(state);
        localStorage.setItem('dardania.save.v1', JSON.stringify(save));
      });
    await page.reload();
    await page.getByRole('button', { name: 'Resume saved game', exact: false }).click();
    expect(
      hasAcceptedTrade((await readPosition(page)).board, (await readPosition(page)).state, 0),
    ).toBe(true);
    await expectRealBotTrade(page, accepted, fixture.second, fixture.secondResponse);
  });
}

for (const reason of [
  'too many goods for too few',
  'does not help me',
  'would let you win',
] as const) {
  test(`a real Hector decline visibly explains: ${reason}`, async ({ page }) => {
    await page.goto('/?test=1');
    const fixture = explainedTradeFixture(reason);
    await loadPosition(page, fixture.session);
    await expectRealBotTrade(page, fixture.session, fixture.proposal, fixture.response);
  });
}
