/** Read-only position inspection and real-control input shared by browser acceptance tests. */
import { expect, type Page } from '@playwright/test';
import {
  CONFIG,
  deserializeState,
  generateBoard,
  isLegal,
  marketPrice,
  serializeState,
  type Action,
  type Board,
  type GameState,
} from '../../src/engine/index.js';
import { encodeSave, type Session } from '../../src/ui/game.js';
import { actionLabel, playerNames } from '../../src/ui/presentation.js';
import type { TestSnapshot } from '../../src/ui/testBridge.js';

export interface Position extends Omit<TestSnapshot, 'state'> {
  board: Board;
  state: GameState;
}
const boards = new Map<string, Board>();

/** Decode the inspected position in Node; cache immutable maps without reading future browser state. */
export async function readPosition(page: Page): Promise<Position> {
  const snapshot = await page.evaluate(() => window.__DARDANIA_TEST__?.snapshot());
  if (!snapshot) throw new Error('No active test-enabled Dardania session');
  let board = boards.get(snapshot.settings.seed);
  if (!board) {
    board = generateBoard(snapshot.settings.seed);
    boards.set(snapshot.settings.seed, board);
  }
  return { ...snapshot, board, state: deserializeState(snapshot.state) };
}

/** Select spatial targets using the same highlighted SVG controls available to a human. */
async function choosePlace(page: Page, action: Action, target: number): Promise<void> {
  await page
    .locator(`[data-testid="board-choice"][data-action="${action.type}"][data-target="${target}"]`)
    .click();
}

/** Translate one engine choice to visible buttons, selects and fields, never to direct state mutation. */
export async function executeAction(page: Page, action: Action): Promise<void> {
  const before = await readPosition(page);
  expect(before.state.toAct, 'A human control is required for each scripted action').toBe(0);
  expect(isLegal(before.board, before.state, action), JSON.stringify(action)).toBe(true);
  switch (action.type) {
    case 'placeSteading':
      await choosePlace(page, action, action.v);
      break;
    case 'placeTrack':
    case 'freeTrack':
      await choosePlace(page, action, action.e);
      break;
    case 'moveWarband':
      await choosePlace(page, action, action.hex);
      break;
    case 'buildTrack':
    case 'buildSteading':
    case 'upgrade': {
      const label = { buildTrack: 'Track', buildSteading: 'Steading', upgrade: 'Upgrade' }[
        action.type
      ];
      await page.getByRole('button', { name: label, exact: true }).click();
      await choosePlace(page, action, 'e' in action ? action.e : action.v);
      break;
    }
    case 'marketBuy': {
      const market = page.getByTestId('public-market');
      await market
        .getByRole('button', { name: `Buy ${CONFIG.goods[action.get]}.`, exact: false })
        .click();
      const price = marketPrice(before.board, before.state, 0, action.get);
      await market
        .getByRole('button', { name: `${price} ${CONFIG.goods[action.pay]}`, exact: true })
        .click();
      break;
    }
    case 'buyCard':
      await page
        .getByTestId('public-stratagems')
        .getByRole('article')
        .nth(action.slot)
        .getByRole('button', { name: 'Buy', exact: true })
        .click();
      break;
    case 'playCard': {
      const details = page
        .locator('details')
        .filter({ has: page.locator('summary', { hasText: 'Your Stratagems' }) });
      if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open)))
        await details.locator('summary').click();
      await page.getByLabel('Choose Stratagem play').selectOption(JSON.stringify(action));
      await page.getByRole('button', { name: 'Play chosen Stratagem', exact: true }).click();
      break;
    }
    case 'proposeTrade': {
      const details = page
        .locator('details')
        .filter({ has: page.locator('summary', { hasText: 'Trade with a rival' }) });
      if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open)))
        await details.locator('summary').click();
      await details
        .getByRole('combobox', { name: 'Rival', exact: true })
        .selectOption(String(action.to));
      for (let good = 0; good < CONFIG.goods.length; good++) {
        await details
          .getByLabel(`Give ${CONFIG.goods[good]}`, { exact: true })
          .fill(String(action.give[good]));
        await details
          .getByLabel(`Get ${CONFIG.goods[good]}`, { exact: true })
          .fill(String(action.get[good]));
      }
      await details.getByRole('button', { name: 'Propose exchange', exact: true }).click();
      break;
    }
    default:
      await page
        .getByRole('button', {
          name: actionLabel(action, playerNames(before.settings)),
          exact: true,
        })
        .click();
  }
  await expect
    .poll(async () => (await readPosition(page)).history[before.historyLength], {
      message: `Visible control must apply ${JSON.stringify(action)}`,
    })
    .toEqual(action);
}

/** Acknowledge visible notices and wait for rival workers, stopping at the next human decision. */
export async function settleHuman(page: Page): Promise<Position | null> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const snapshot = await page.evaluate(() => window.__DARDANIA_TEST__?.snapshot());
    if (!snapshot) return null;
    const state = deserializeState(snapshot.state);
    // Trade/discard dialogs are modal; answering their controls handles the trade notice itself.
    if (state.toAct === 0 && ['discard', 'tradeResponse'].includes(state.phase))
      return readPosition(page);
    // The finish dialog takes precedence over notices left by the winning transition.
    if (state.phase === 'gameOver') return readPosition(page);
    const acknowledge = page.getByTestId('acknowledge-notice');
    if (snapshot.notices.length > 0) {
      await acknowledge.click();
      continue;
    }
    if (state.toAct === 0) return readPosition(page);
    await page.waitForTimeout(20);
  }
  const position = await readPosition(page);
  throw new Error(
    `Rivals did not settle: ${position.state.phase}, actor ${position.state.toAct}, turn ${position.state.turn}`,
  );
}

/** Load an exact serialized fixture only for case setup, then require its full position to match. */
export async function loadPosition(page: Page, session: Session): Promise<void> {
  const save = encodeSave(session);
  await page.evaluate((serialized) => {
    if (!window.__DARDANIA_TEST__) throw new Error('Test hook is unavailable');
    window.__DARDANIA_TEST__.load(serialized);
  }, save);
  await expect
    .poll(async () => serializeState((await readPosition(page)).state))
    .toBe(serializeState(session.state));
}
