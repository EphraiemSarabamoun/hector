/** Play complete games through DOM controls; the offer-cap witness declines every rival trade. */
import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { GreedyBot } from '../../src/bots/index.js';
import { applyWithTradeHistory } from '../../src/ai/index.js';
import { Building, Card, CONFIG, createGame, marketPrice, renown } from '../../src/engine/index.js';
import { executeAction, readPosition, settleHuman } from './dom-driver.js';

interface GameSummary {
  seed: string;
  turns: number;
  winner: number;
  renown: number[];
  humanActions: number;
  humanTradePolicy: 'greedy' | 'always decline';
  actions: Record<string, number>;
  naturalCases: string[];
  trades: { humanOffers: number; secondOffersToBot: number };
}
const results: GameSummary[] = [];
test.use({ trace: 'off', screenshot: 'off' });

/** Keep a small, reproducible action/case record rather than large traces of successful games. */
test.afterAll(async () => {
  await mkdir('runs', { recursive: true });
  await writeFile('runs/dom-games.json', JSON.stringify({ games: results }, null, 2) + '\n');
});

/** A failed long game leaves a compact decision diagnostic without a screenshot or browser trace. */
test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  const position = await readPosition(page).catch(() => null);
  await mkdir('runs', { recursive: true });
  await writeFile(
    'runs/dom-game-failure.json',
    JSON.stringify(
      {
        test: info.title,
        errors: info.errors.map((error) => error.message),
        position: position && {
          seed: position.settings.seed,
          turn: position.state.turn,
          phase: position.state.phase,
          actor: position.state.toAct,
          historyLength: position.historyLength,
          lastAction: position.lastAction,
          lastEvents: position.lastEvents,
          notices: position.notices,
        },
      },
      null,
      2,
    ) + '\n',
  );
});

for (let index = 1; index <= 5; index++) {
  const seed = index === 3 ? 'final-dom-trade-3' : `dom-game-${index}`;
  test(`a human finishes the whole game on ${seed}`, async ({ page }) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto('/?test=1');
    await page.getByLabel('Your name', { exact: true }).fill('DOM house');
    await page.getByLabel('Map seed', { exact: false }).fill(seed);
    await page.getByRole('button', { name: 'Start new game', exact: false }).click();
    await page.getByLabel('Rival pace', { exact: true }).selectOption('instant');
    const human = new GreedyBot();
    const actions: Record<string, number> = {};
    const cases = new Set<string>();
    let steps = 0;
    let position = await settleHuman(page);
    while (position && position.state.phase !== 'gameOver' && steps < 4000) {
      const { board, state } = position;
      let action = human.chooseAction(board, state, 0);
      if (index === 3 && action.type === 'respondTrade')
        action = { type: 'respondTrade', accept: false };
      if (state.phase === 'discard') cases.add('discard');
      if (action.type === 'marketBuy') {
        const discount = board.vertices.some((v) => state.vertexOwner[v.id] === 0 && !!v.harbour);
        cases.add(`market-${discount ? 'with' : 'without'}-harbour`);
        expect(marketPrice(board, state, 0, action.get)).toBeGreaterThan(0);
      }
      if (action.type === 'upgrade')
        cases.add(state.vertexKind[action.v] === Building.Steading ? 'town' : 'citadel');
      if (action.type === 'buyCard') cases.add(`buy-${Card[state.row[action.slot]]}`);
      if (action.type === 'playCard') cases.add(`play-${Card[action.card]}`);
      if (action.type === 'muster') cases.add('paid-muster');
      if (action.type === 'moveWarband' && state.lastRoll === 7) cases.add('warband-after-seven');
      if (action.type === 'plunder') cases.add('plunder');
      if (action.type === 'freeTrack') cases.add('free-track');
      actions[action.type] = (actions[action.type] ?? 0) + 1;
      await executeAction(page, action);
      steps++;
      position = await settleHuman(page);
    }
    expect(position, 'The active game must remain available').not.toBeNull();
    expect(position!.state.phase, `No winner after ${steps} human inputs`).toBe('gameOver');
    await expect(page.getByRole('dialog', { name: 'Game result', exact: true })).toBeVisible();
    cases.add('win-screen');
    const end = await readPosition(page);
    // Replay every action, including rival moves between human decisions, to audit full turns.
    const replay = createGame(seed, 3);
    const humanOffers = new Map<string, number>();
    const ownOffers = new Map<string, number>();
    let secondOffersToBot = 0;
    for (const action of end.history) {
      const key = `${replay.state.turn}:${replay.state.active}`;
      if (action.type === 'proposeTrade' && replay.state.active !== 0) {
        const ordinal = (ownOffers.get(key) ?? 0) + 1;
        ownOffers.set(key, ordinal);
        if (action.to === 0) {
          const count = (humanOffers.get(key) ?? 0) + 1;
          humanOffers.set(key, count);
          expect(count, `Repeated human offer from bot turn ${key}`).toBeLessThanOrEqual(1);
        } else if (ordinal === 2) secondOffersToBot++;
      }
      applyWithTradeHistory(replay.board, replay.state, action);
    }
    expect(end.settings.tiers).toContain('Hector');
    if (index === 3) {
      // Require a real human offer in this full game; the focused fixture proves the second-bot path.
      expect([...humanOffers.values()].length).toBeGreaterThan(0);
    }
    results.push({
      seed,
      turns: end.state.turn,
      winner: end.state.winnerId,
      renown: Array.from({ length: 3 }, (_, player) => renown(end.board, end.state, player)),
      humanActions: steps,
      humanTradePolicy: index === 3 ? 'always decline' : 'greedy',
      trades: {
        humanOffers: [...humanOffers.values()].reduce((a, b) => a + b, 0),
        secondOffersToBot,
      },
      actions,
      naturalCases: [...cases].sort(),
    });
    if (index === 1) {
      await page.getByRole('button', { name: 'Rematch on this map', exact: true }).click();
      await expect(page.getByTestId('game')).toHaveAttribute('data-turn', '0');
      expect((await readPosition(page)).settings.seed).toBe(seed);
      cases.add('rematch-same-map');
    } else if (index === 2) {
      await page.getByRole('button', { name: 'New game', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: 'Found your house', exact: true }),
      ).toBeVisible();
      expect(await page.evaluate(() => window.__DARDANIA_TEST__?.snapshot())).toBeNull();
      cases.add('new-game');
    }
    results[results.length - 1].naturalCases = [...cases].sort();
    expect(errors).toEqual([]);
  });
}
