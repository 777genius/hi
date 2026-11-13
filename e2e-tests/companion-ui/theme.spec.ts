import { expect, mic, snapshotData, stt, test, textContrast } from './support';

// WCAG AA для обычного текста.
const MIN_CONTRAST = 4.5;

test('стили светлой темы не протекают на <html>: в CSS нет правил ".theme-light { color/background… }"', async ({ companion, page }) => {
  await companion.open();
  // Vue 3.5 компилирует ":global(.theme-light) .x" в ".theme-light", и свойства элемента ложатся на корень.
  // Допустимы только CSS-переменные темы из style.css.
  const leaked = await page.evaluate(() => {
    const result: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of Array.from(rules)) {
        if (!(rule instanceof CSSStyleRule)) continue;
        const selectors = rule.selectorText.split(',').map((part) => part.trim());
        if (!selectors.includes('.theme-light')) continue;
        const properties = Array.from(rule.style).filter((property) => !property.startsWith('--'));
        if (properties.length > 0) result.push(`${rule.selectorText} { ${properties.join(', ')} }`);
      }
    }
    return result;
  });
  expect(leaked).toEqual([]);
});

for (const colorScheme of ['dark', 'light'] as const) {
  test.describe(`Читаемость статусов и подсказок (${colorScheme} тема)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme });
    });

    test('предупреждение о неподтверждённой отправке читается сверху и в composer', async ({ companion, page }) => {
      await companion.reset(snapshotData([stt(1, 'Вопрос')]));
      await companion.configure({ actionOverrides: { '/api/context/clear': { dropAfterHeaders: true, applyAction: true } } });
      await companion.open();
      await page.getByTitle('Очистить AI контекст').click();
      await expect(companion.status).toContainText('Не удалось подтвердить отправку');
      expect(await textContrast(page, '.top-connection-status')).toBeGreaterThanOrEqual(MIN_CONTRAST);

      await companion.openComposer();
      await expect(companion.composerStatus).toContainText('Не удалось подтвердить отправку');
      expect(await textContrast(page, '.ask-card .ask-status')).toBeGreaterThanOrEqual(MIN_CONTRAST);
    });

    test('удалённое сообщение приглушено, но различимо', async ({ companion, page }) => {
      await companion.reset(snapshotData([stt(1, 'Вопрос'), mic(2, 'Сообщение удалено', { deleted: true })]));
      await companion.open();
      // Намеренно бледный текст: ниже AA, но не сливается с фоном.
      expect(await textContrast(page, '[data-msg-id="mic:2"] .chat-text-deleted')).toBeGreaterThanOrEqual(2);
    });

    test('ошибка устаревшей ссылки читается', async ({ companion, page }) => {
      await companion.configure({ stateOverride: { status: 403, body: 'Forbidden', times: 100 } });
      await companion.open({ waitConnected: false });
      await expect(companion.status).toContainText('Ссылка устарела');
      expect(await textContrast(page, '.top-connection-status')).toBeGreaterThanOrEqual(MIN_CONTRAST);
    });

    test('подсказка установки PWA читается', async ({ companion, page }) => {
      // Обычная фикстура скрывает подсказку: здесь она нужна.
      await page.addInitScript(() => {
        sessionStorage.setItem('__companionUiKeepPwaHint', '1');
        localStorage.removeItem('companionPwaInstallHintDismissed');
      });
      await companion.reset(snapshotData([stt(1, 'Вопрос')]));
      await companion.open();
      await expect(page.locator('.pwa-notice-title')).toHaveText('Открыто как вкладка');
      for (const selector of ['.pwa-notice-title', '.pwa-notice-text', '.pwa-notice-button']) {
        expect(await textContrast(page, selector), selector).toBeGreaterThanOrEqual(MIN_CONTRAST);
      }
      await page.getByTitle('Скрыть').click();
      await expect(page.locator('.pwa-notice')).toHaveCount(0);
    });
  });
}
