/** Click through human setup and three full rounds; catch runtime errors and prove exact save resume. */
import { expect, test } from '@playwright/test';
test('a human founds a house, plays three rounds and resumes the same state', async ({ page }) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  expect(await page.evaluate(() => '__DARDANIA_TEST__' in window)).toBe(false);
  await page.getByLabel('Map seed', { exact: false }).fill('coastal-smoke-24');
  await page.getByRole('button', { name: 'Start new game' }).click();
  await page.getByLabel('Rival pace').selectOption('instant');
  const game = page.getByTestId('game');
  // Information is public before the first roll, while the shuffled first bot is placing.
  await expect(page.getByTestId('public-market')).toBeVisible();
  await expect(page.getByTestId('public-stratagems')).toBeVisible();
  await expect(game).toHaveAttribute('data-turn', '0');
  await expect(page.getByTestId('public-stratagems').getByRole('article')).toHaveCount(3);
  let placements = 0;
  let ended = 0;
  let acted = false;
  let iterations = 0;
  let noticesSeen = 0;
  const acknowledgeNotice = async () => {
    noticesSeen++;
    if (noticesSeen === 1) {
      const hash = await game.getAttribute('data-hash');
      await page.waitForTimeout(150);
      await expect(game).toHaveAttribute('data-hash', hash!);
      await page.reload();
      await page.getByRole('button', { name: 'Resume saved game' }).click();
      await expect(game).toHaveAttribute('data-hash', hash!);
      await expect(page.getByTestId('critical-notice')).toBeVisible();
    }
    await page.getByTestId('acknowledge-notice').click();
  };
  while (ended < 3 && iterations++ < 500) {
    if (await page.getByTestId('acknowledge-notice').count()) {
      await acknowledgeNotice();
      continue;
    }
    if ((await game.getAttribute('data-actor')) !== '0') {
      await page.waitForTimeout(40);
      continue;
    }
    const phase = await game.getAttribute('data-phase');
    if (phase === 'setupSteading' || phase === 'setupTrack') {
      await page.getByTestId('board-choice').first().click();
      placements++;
    } else if (phase === 'roll') {
      acted = false;
      await page.getByTestId('roll').click();
    } else if (phase === 'main') {
      const build = page.getByTestId('build-choice');
      const legal = page.getByTestId('legal-action').filter({ visible: true });
      if (!acted && (await build.count())) {
        await build.first().click();
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('board-choice')).toHaveCount(0);
        await build.first().click();
        await page.getByTestId('board-choice').first().click();
        acted = true;
      } else if (!acted && (await legal.count())) {
        await legal.first().click();
        acted = true;
      } else {
        await page.getByTestId('end-turn').click();
        ended++;
      }
    } else if (phase === 'moveWarband' || phase === 'surveyors') {
      const targets = page.getByTestId('board-choice');
      if (await targets.count()) await targets.first().click();
      else await page.getByTestId('legal-action').first().click();
    } else if (phase === 'discard' || phase === 'plunder' || phase === 'tradeResponse') {
      await page.getByTestId('legal-action').filter({ visible: true }).first().click();
    } else throw new Error(`Unexpected human phase: ${phase}`);
  }
  expect(placements).toBe(4);
  expect(ended).toBe(3);
  // Complete the rivals' reply to the third human turn, acknowledging persistent notices.
  for (let i = 0; i < 300; i++) {
    if (await page.getByTestId('acknowledge-notice').count()) {
      await acknowledgeNotice();
      continue;
    }
    const actor = await game.getAttribute('data-actor');
    const phase = await game.getAttribute('data-phase');
    if (actor === '0' && phase === 'roll') break;
    if (actor === '0' && ['discard', 'tradeResponse'].includes(phase!))
      await page.getByTestId('legal-action').filter({ visible: true }).first().click();
    else await page.waitForTimeout(40);
  }
  await expect(game).toHaveAttribute('data-actor', '0');
  await expect(game).toHaveAttribute('data-phase', 'roll');
  expect(workers.some((url) => /worker-.*\.js/.test(url))).toBe(true);
  expect(noticesSeen).toBeGreaterThanOrEqual(1);
  const hash = await game.getAttribute('data-hash');
  const persistedHash = await page.evaluate(
    () => JSON.parse(localStorage.getItem('dardania.save.v1')!).hash,
  );
  expect(persistedHash).toBe(hash);
  await page.reload();
  await page.getByRole('button', { name: 'Resume saved game' }).click();
  await expect(game).toHaveAttribute('data-hash', hash!);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Rules', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Dardania rules' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Dardania rules' })).toHaveCount(0);
  // Check displayed text, including scaled SVG tokens, rather than hidden modal/template copy.
  const auditText = () =>
    page.evaluate(() => {
      const failures: string[] = [];
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let text = walk.nextNode(); text; text = walk.nextNode()) {
        if (!text.textContent?.trim()) continue;
        const el = text.parentElement!;
        if (el.closest('title,desc,option,script,style')) continue;
        const range = document.createRange();
        range.selectNode(text);
        if (!range.getBoundingClientRect().width || !range.getBoundingClientRect().height) continue;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        let size = parseFloat(style.fontSize);
        if (el instanceof SVGGraphicsElement) {
          const matrix = el.getScreenCTM();
          if (matrix) size *= Math.hypot(matrix.c, matrix.d);
        }
        if (size < 11.99)
          failures.push(
            `${el.getAttribute('class') ?? el.tagName}: ${size.toFixed(2)}px ${text.textContent.trim().slice(0, 35)}`,
          );
      }
      return failures;
    });
  expect(await auditText()).toEqual([]);
  await page.getByRole('button', { name: /^Expand/ }).click();
  expect(await auditText()).toEqual([]);
  const placeEvent = page
    .locator('.chronicle-event')
    .filter({ hasText: 'moved the Warband' })
    .last();
  if (await placeEvent.count()) {
    await placeEvent.hover();
    await expect(page.locator('.highlighted-hex')).toHaveCount(1);
  }
  await page.getByRole('button', { name: /^Collapse/ }).click();
  const fit = await page.locator('.board-svg').evaluate((el) => {
    const svg = el as SVGSVGElement;
    const matrix = svg.getScreenCTM()!;
    const scale = Math.hypot(matrix.a, matrix.b);
    const landWidth = Number(svg.dataset.landWidth) * scale;
    const landHeight = Number(svg.dataset.landHeight) * scale;
    const panel = svg.getBoundingClientRect();
    return Math.max(landWidth / panel.width, landHeight / panel.height);
  });
  expect(fit).toBeGreaterThanOrEqual(0.9);
  for (const id of ['public-market', 'public-stratagems']) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(720);
  }
  await page.mouse.move(10, 10);
  await page.screenshot({ path: 'runs/browser-smoke-1280x720.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.mouse.move(10, 10);
  await page.screenshot({ path: 'runs/browser-smoke-1440x900.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.mouse.move(10, 10);
  await page.screenshot({ path: 'runs/browser-smoke.png', fullPage: true });
  expect(errors).toEqual([]);
});
