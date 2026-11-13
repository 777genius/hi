import { expect, snapshotData, stt, test } from './support';

test.describe('Нижняя панель управления', () => {
  for (const width of [320, 360, 375, 390, 414, 430]) {
    test(`все кнопки дока помещаются на экране шириной ${width}px`, async ({ companion, page }, info) => {
      test.skip(info.project.name === 'tablet', 'ширина телефона проверяется в телефонных профилях');
      await page.setViewportSize({ width, height: 844 });
      await companion.reset(snapshotData([stt(1, 'Вопрос')]));
      await companion.open();
      // Выделение добавляет ещё одну кнопку в левую группу.
      await page.locator('[data-msg-id="stt:1"] .chat-bubble').click();
      await expect(page.locator('.selection-clear')).toBeVisible();

      const buttons = page.locator('.controls-dock button');
      const count = await buttons.count();
      expect(count).toBe(8);
      for (let index = 0; index < count; index += 1) {
        const box = await buttons.nth(index).boundingBox();
        const title = await buttons.nth(index).getAttribute('title');
        expect(box, String(title)).not.toBeNull();
        expect(box!.x, `${title}: левый край`).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width, `${title}: правый край`).toBeLessThanOrEqual(width);
        // Кнопка не сплющена в узкую полоску.
        expect(box!.width, `${title}: ширина`).toBeGreaterThanOrEqual(32);
      }
      // Кнопка composer реально нажимается.
      await page.locator('.controls-center .dock-circle-button').last().click();
      await expect(page.locator('.ask-card')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    });
  }

  test('кнопка «вниз» не перекрыта панелью и нажимается', async ({ companion, page }) => {
    const timeline = Array.from({ length: 60 }, (_, i) => stt(i + 1, `Вопрос ${i}`));
    await companion.reset(snapshotData(timeline));
    await companion.open();
    await companion.userScrollTo(0);
    const button = page.locator('.scroll-to-bottom-button');
    await expect(button).toBeVisible();
    const box = (await button.boundingBox())!;
    const hit = await page.evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y);
      return !!element?.closest('.scroll-to-bottom-button');
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    expect(hit, 'кнопка «вниз» перекрыта другим элементом').toBe(true);
    await button.click();
    await expect.poll(async () => (await companion.scrollMetrics()).remaining).toBeLessThanOrEqual(2);
    await expect(button).toBeHidden();
  });
});
