import type { Page } from '@playwright/test';
import { expect, haiku, mic, prompt, snapshotData, stt, test } from './support';

const CODE = '```ts\nconst answer = await fetch(url);\nconsole.log(answer.status);\n```';

function px(value: string | undefined | null): number {
  return Number.parseFloat(String(value ?? 'NaN'));
}

async function measureRow(page: Page, id: string) {
  return page.locator(`[data-msg-id="${id}"]`).evaluate((row) => {
    const bubble = row.querySelector<HTMLElement>('.chat-bubble')!;
    const pre = row.querySelector<HTMLElement>('.code-block pre');
    const code = row.querySelector<HTMLElement>('pre code');
    const style = (element: Element | null) => (element ? getComputedStyle(element) : null);
    const preStyle = style(pre);
    return {
      rowWidth: row.getBoundingClientRect().width,
      bubbleWidth: bubble.getBoundingClientRect().width,
      bubbleFont: style(bubble)!.fontSize,
      preFont: preStyle?.fontSize ?? null,
      codeFont: style(code)?.fontSize ?? null,
      prePadding: preStyle
        ? [preStyle.paddingTop, preStyle.paddingRight, preStyle.paddingBottom, preStyle.paddingLeft]
        : null,
    };
  });
}

test.describe('Размеры сообщений и кода', () => {
  test.beforeEach(async ({ companion }) => {
    await companion.reset(snapshotData([
      stt(1, 'Вопрос интервьюера обычным текстом, достаточно длинный, чтобы занять строку'),
      stt(2, `Вопрос с кодом:\n${CODE}`),
      mic(3, 'Мой ответ голосом, тоже достаточно длинный, чтобы занять строку ленты'),
      prompt(4, `Prompt с кодом\n${CODE}`),
      haiku(5, 'Обычный ответ AI без кода, но длинный, чтобы занять всю доступную ширину пузыря.'),
      haiku(6, `Ответ с кодом:\n\n${CODE}\n\nи \`inline\` код`),
      stt(7, 'function demo() {\n  return 42;\n}', { id: 'focus-copy:1' }),
      message8(),
    ]));
    await companion.open();
    // Код в не-AI сообщениях подсвечивает shiki асинхронно.
    await expect(companion.page.locator('[data-msg-id="focus-copy:1"] .code-block pre')).toBeVisible();
    await expect(companion.page.locator('[data-msg-id="stt:2"] .code-block pre')).toBeVisible();
    await expect(companion.page.locator('[data-msg-id="prompt:4"] .code-block pre')).toBeVisible();
  });

  test('текст всех пузырей 17px, код того же размера, отступы блока кода не больше 2px', async ({ companion }) => {
    for (const id of ['stt:1', 'stt:2', 'mic:3', 'prompt:4', 'haiku:5', 'haiku:6', 'focus-copy:1', 'signal:8']) {
      const metrics = await measureRow(companion.page, id);
      expect(px(metrics.bubbleFont), `${id}: шрифт пузыря`).toBe(17);
      if (metrics.preFont !== null) {
        expect(px(metrics.preFont), `${id}: шрифт pre`).toBe(17);
        expect(px(metrics.codeFont), `${id}: шрифт pre code`).toBe(17);
        for (const side of metrics.prePadding ?? []) {
          expect(px(side), `${id}: padding блока кода`).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  test('пузырь с блоком кода на всю ширину ленты, обычный ответ AI около 80%', async ({ companion }) => {
    for (const id of ['stt:2', 'prompt:4', 'haiku:6', 'focus-copy:1']) {
      const metrics = await measureRow(companion.page, id);
      expect(metrics.bubbleWidth, `${id}: блок кода на всю ширину`).toBeGreaterThanOrEqual(metrics.rowWidth - 8);
    }
    const plain = await measureRow(companion.page, 'haiku:5');
    const ratio = plain.bubbleWidth / plain.rowWidth;
    expect(ratio).toBeGreaterThan(0.74);
    expect(ratio).toBeLessThan(0.83);
    // Длинные обычные сообщения тоже не шире ~80% ленты.
    for (const id of ['stt:1', 'mic:3']) {
      const metrics = await measureRow(companion.page, id);
      expect(metrics.bubbleWidth / metrics.rowWidth, id).toBeLessThanOrEqual(0.82);
    }
  });
});

function message8() {
  return stt(8, 'Сообщение из Signal: напомни про дедлайн', { kind: 'signal', role: 'incoming' });
}
