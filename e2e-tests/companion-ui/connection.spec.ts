import type { Page } from '@playwright/test';
import { expect, snapshotData, stt, test } from './support';

async function setPageVisibility(page: Page, state: 'visible' | 'hidden'): Promise<void> {
  await page.evaluate((next) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => next });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => next === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

test.describe('Связь с компьютером', () => {
  test('обрыв SSE: статус переподключения, затем resync с пропущенными сообщениями', async ({ companion, page }) => {
    await companion.reset(snapshotData([stt(1, 'До обрыва')]));
    await companion.open();
    await expect.poll(async () => (await companion.log()).openStreams).toBe(1);
    const before = await companion.log();

    // Компьютер недоступен: поток оборван, /api/state не отвечает.
    await companion.configure({ stateOverride: { drop: true, times: 2 } });
    await companion.dropStreams();
    await expect(companion.status).toContainText(/переподключ|восстановить связь|Не удалось подключиться/);
    await expect(companion.recordButton).toBeDisabled();
    // Пока связи нет, на компьютере появились новые сообщения.
    await companion.update((data) => { data.timeline.push(stt(2, 'Пока телефон был без связи')); });

    await expect(page.locator('[data-msg-id="stt:2"]')).toBeVisible({ timeout: 20_000 });
    await companion.waitConnected();
    await expect(companion.status).toBeHidden();
    const after = await companion.log();
    expect(after.streamsOpened).toBeGreaterThan(before.streamsOpened);
    expect(after.openStreams).toBe(1);
    expect(after.stateGets).toBeGreaterThan(before.stateGets);
  });

  for (const status of [401, 403]) {
    test(`${status} от сервера: ссылка устарела, без бесконечных повторов`, async ({ companion }) => {
      await companion.configure({ stateOverride: { status, body: status === 401 ? 'Missing token' : 'Forbidden', times: 100 } });
      await companion.open({ waitConnected: false });
      await expect(companion.status).toContainText('Ссылка устарела');
      await expect(companion.recordButton).toBeDisabled();
      const first = await companion.log();
      await companion.page.waitForTimeout(4_000);
      const later = await companion.log();
      // PWA-диагностика делает один свой GET /api/state; повторов переподключения нет.
      expect(later.stateGets - first.stateGets).toBeLessThanOrEqual(1);
      expect(later.openStreams).toBe(0);
    });
  }

  test('токен отозвали во время работы: поток закрыт, телефон перестаёт стучаться', async ({ companion }) => {
    await companion.reset(snapshotData([stt(1, 'Вопрос')]));
    await companion.open();
    await companion.configure({ authorized: false });
    await companion.dropStreams();
    await expect(companion.status).toContainText('Ссылка устарела', { timeout: 15_000 });
    const first = await companion.log();
    await companion.page.waitForTimeout(4_000);
    const later = await companion.log();
    expect(later.stateGets).toBe(first.stateGets);
    expect(later.openStreams).toBe(0);
    // Последняя лента остаётся видна.
    await expect(companion.page.locator('[data-msg-id="stt:1"]')).toBeVisible();
  });

  test('некорректный snapshot от /api/state: ошибка, повтор, затем восстановление', async ({ companion, page }) => {
    await companion.reset(snapshotData([stt(1, 'Нормальное сообщение')]));
    // Несколько раз подряд: WebKit на pageshow сразу повторяет запрос, одной ошибки мало, чтобы её увидеть.
    await companion.configure({
      stateOverride: { status: 200, body: { revision: '7', data: { timeline: 'not-an-array' } }, times: 4 },
    });
    await companion.open({ waitConnected: false });
    await expect(companion.status).toContainText('Не удалось получить корректное состояние');
    // Пользователь видит понятный текст, а не сырой JSON из тела ответа.
    await expect(companion.status).not.toContainText('not-an-array');
    await expect(page.locator('.chat-row')).toHaveCount(0);
    // Планировщик повторяет запрос и подключается, когда сервер снова отвечает корректно.
    await companion.waitConnected();
    await expect(page.locator('[data-msg-id="stt:1"]')).toBeVisible();
    await expect(companion.status).toBeHidden();
  });

  test('битый SSE-кадр и snapshot с дубликатами id: лента цела, состояние перечитывается', async ({ companion, page }) => {
    await companion.reset(snapshotData([stt(1, 'Первое'), stt(2, 'Второе')]));
    await companion.open();
    const before = await companion.log();

    await companion.publishRaw('event: snapshot\ndata: {"revision": "99", "data": \n\n');
    await expect.poll(async () => (await companion.log()).stateGets).toBeGreaterThan(before.stateGets);
    await companion.waitConnected();
    await expect.poll(() => companion.rowIds()).toEqual(['stt:1', 'stt:2']);

    const duplicate = { revision: '100', data: snapshotData([stt(1, 'A'), stt(1, 'B')]) };
    const gets = (await companion.log()).stateGets;
    await companion.publishRaw(`event: snapshot\ndata: ${JSON.stringify(duplicate)}\n\n`);
    await expect.poll(async () => (await companion.log()).stateGets).toBeGreaterThan(gets);
    await companion.waitConnected();
    await expect.poll(() => companion.rowIds()).toEqual(['stt:1', 'stt:2']);
    await expect(page.locator('[data-msg-id="stt:1"]')).toHaveText('Первое');
  });

  test('устаревшая ревизия игнорируется, новый instance desktop принимается и сбрасывает выделение', async ({ companion, page }) => {
    await companion.reset(snapshotData([stt(1, 'Текущее'), stt(2, 'Ещё')]));
    await companion.open();
    await companion.update((data) => { data.timeline.push(stt(3, 'Свежее')); });
    await expect(page.locator('[data-msg-id="stt:3"]')).toBeVisible();
    await page.locator('[data-msg-id="stt:1"] .chat-bubble').click();
    await expect(page.locator('.selection-badge')).toHaveText('1');

    const stale = { revision: '1', data: snapshotData([stt(1, 'Старое состояние')]) };
    await companion.publishRaw(`event: snapshot\ndata: ${JSON.stringify(stale)}\n\n`);
    await page.waitForTimeout(400);
    await expect(page.locator('[data-msg-id="stt:3"]')).toBeVisible();
    await expect(page.locator('[data-msg-id="stt:1"]')).toHaveText('Текущее');

    // Desktop перезапустился: ревизии начались заново, id могут совпасть со старыми.
    const restarted = { revision: '1', data: snapshotData([stt(1, 'Новая сессия')]) };
    restarted.data.controls.instanceId = 'mock-instance-b';
    await companion.publishRaw(`event: snapshot\ndata: ${JSON.stringify(restarted)}\n\n`);
    await expect(page.locator('[data-msg-id="stt:1"]')).toHaveText('Новая сессия');
    await expect(page.locator('[data-msg-id="stt:3"]')).toHaveCount(0);
    await expect(page.locator('.selection-clear')).toHaveCount(0);
    await expect(page.locator('.chat-row.selected')).toHaveCount(0);
  });

  test('вкладка в фоне закрывает поток, при возврате состояние догоняется', async ({ companion, page }) => {
    await companion.reset(snapshotData([stt(1, 'До фона')]));
    await companion.open();
    await setPageVisibility(page, 'hidden');
    await expect.poll(async () => (await companion.log()).openStreams).toBe(0);
    await companion.update((data) => { data.timeline.push(stt(2, 'Пока телефон спал')); });
    await page.waitForTimeout(300);
    await expect(page.locator('[data-msg-id="stt:2"]')).toHaveCount(0);

    await setPageVisibility(page, 'visible');
    await expect(page.locator('[data-msg-id="stt:2"]')).toBeVisible();
    await companion.waitConnected();
    await expect.poll(async () => (await companion.log()).openStreams).toBe(1);
  });

  test('событие offline при живом Wi-Fi не рвёт рабочий поток', async ({ companion, page }) => {
    await companion.reset(snapshotData([stt(1, 'Вопрос')]));
    await companion.open();
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await page.waitForTimeout(500);
    expect((await companion.log()).openStreams).toBe(1);
    await expect(companion.recordButton).toBeEnabled();
    await companion.update((data) => { data.timeline.push(stt(2, 'Новое')); });
    await expect(page.locator('[data-msg-id="stt:2"]')).toBeVisible();
  });
});
