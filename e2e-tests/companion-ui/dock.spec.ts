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

  for (const colorScheme of ['dark', 'light'] as const) {
    test(`иконки дока контрастны фону дока (${colorScheme} тема)`, async ({ companion, page }) => {
      await page.emulateMedia({ colorScheme });
      await companion.reset(snapshotData([stt(1, 'Вопрос')]));
      await companion.open();
      await expect(page.locator('html')).toHaveClass(colorScheme === 'light' ? /theme-light/ : /^(?!.*theme-light)/);
      // Относительная яркость по WCAG: фон дока тёмный, значит иконки должны быть светлыми.
      const luminance = await page.evaluate(() => {
        const channel = (value: number) => {
          const srgb = value / 255;
          return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
        };
        const parse = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(Number);
        const relative = (color: string) => {
          const [r, g, b] = parse(color).map(channel);
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        return {
          dock: relative(getComputedStyle(document.querySelector('.controls-center')!).backgroundColor),
          icons: Array.from(document.querySelectorAll('.controls-dock button:not(.dock-record-button)'))
            .map((button) => [button.getAttribute('title'), relative(getComputedStyle(button).color)] as const),
        };
      });
      for (const [title, icon] of luminance.icons) {
        const contrast = (Math.max(icon, luminance.dock) + 0.05) / (Math.min(icon, luminance.dock) + 0.05);
        expect(contrast, `${title}: контраст иконки`).toBeGreaterThanOrEqual(4.5);
      }
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
