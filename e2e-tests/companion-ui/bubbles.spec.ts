import { expect, haiku, mic, prompt, snapshotData, stt, test } from './support';

test.describe('Форма сообщений', () => {
  test('без рамки, вплотную к краю, без скругления со стороны края', async ({ companion, page }, info) => {
    await companion.reset(snapshotData([
      stt(1, 'Входящий вопрос интервьюера'),
      mic(2, 'Мой ответ голосом'),
      prompt(3, 'Мой prompt'),
      haiku(4, 'Ответ AI на вопрос', { insertAfterId: 'stt:1' }),
    ]));
    await companion.open();
    await page.screenshot({ path: `.e2e-artifacts/companion-ui/bubbles-${info.project.name}.png` });

    const measure = (id: string) => page.locator(`[data-msg-id="${id}"] .chat-bubble`).evaluate((el) => {
      const style = getComputedStyle(el);
      const scroll = el.closest('.chat-scroll')!.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      return {
        border: style.borderTopWidth,
        gapLeft: Math.round(rect.left - scroll.left),
        gapRight: Math.round(scroll.right - rect.right),
        radius: style.borderRadius,
      };
    });

    const incoming = await measure('stt:1');
    expect(incoming.border).toBe('0px');
    expect(incoming.gapLeft).toBe(0);
    expect(incoming.radius).toMatch(/^0px \d+px \d+px 0px$/);

    for (const id of ['mic:2', 'prompt:3']) {
      const outgoing = await measure(id);
      expect(outgoing.border, id).toBe('0px');
      expect(outgoing.gapRight, id).toBeLessThanOrEqual(1);
      expect(outgoing.radius, id).toMatch(/^\d+px 0px 0px \d+px$/);
    }
  });
});
