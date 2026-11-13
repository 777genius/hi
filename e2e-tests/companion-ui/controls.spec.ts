import { expect, haiku, mic, snapshotData, stt, test } from './support';

const conversation = () => snapshotData([
  stt(1, 'Вопрос про кэширование'),
  mic(2, 'Мой ответ про Redis'),
  haiku(3, 'Подсказка AI', { insertAfterId: 'stt:1' }),
  stt(4, 'Вопрос про очереди'),
  mic(5, 'Удалённое', { deleted: true }),
], { live: { partialText: 'Ещё говорю', partialStartedAtMs: 1_760_000_100_000 } });

test.describe('Выделение сообщений', () => {
  test.beforeEach(async ({ companion }) => {
    await companion.reset(conversation());
    await companion.open();
  });

  test('тап выделяет, следующие тапы добавляют и снимают, кнопка сбрасывает', async ({ page }) => {
    const bubble = (id: string) => page.locator(`[data-msg-id="${id}"] .chat-bubble`);
    await bubble('stt:1').click();
    await expect(page.locator('[data-msg-id="stt:1"]')).toHaveClass(/selected/);
    await expect(page.locator('.selection-badge')).toHaveText('1');
    await bubble('mic:2').click();
    await expect(page.locator('.selection-badge')).toHaveText('2');
    await bubble('stt:1').click();
    await expect(page.locator('.selection-badge')).toHaveText('1');
    await expect(page.locator('[data-msg-id="stt:1"]')).not.toHaveClass(/selected/);

    // Ответы AI, live partial и удалённые сообщения не выделяются.
    for (const id of ['haiku:3', 'stt:live', 'mic:5']) {
      await bubble(id).click();
      await expect(page.locator(`[data-msg-id="${id}"]`)).not.toHaveClass(/selected/);
    }
    await expect(page.locator('.selection-badge')).toHaveText('1');

    await page.getByTitle('Снять выделение').click();
    await expect(page.locator('.chat-row.selected')).toHaveCount(0);
    await expect(page.locator('.selection-clear')).toHaveCount(0);
  });

  test('AI-ответ по выделенным сообщениям отправляет их id и снимает выделение', async ({ companion, page }) => {
    await page.locator('[data-msg-id="stt:4"] .chat-bubble').click();
    await page.locator('[data-msg-id="stt:1"] .chat-bubble').click();
    await page.getByTitle('Сгенерировать ответ').click();
    await expect.poll(async () => (await companion.posts('/api/ai/request')).length).toBe(1);
    const [post] = await companion.posts('/api/ai/request');
    expect(post.body.selectedMessageIds).toEqual(['stt:4', 'stt:1']);
    expect(post.body.openaiResponsesWebSearch).toBe(false);
    await expect(page.locator('.chat-row.selected')).toHaveCount(0);
  });

  test('ошибка AI-запроса сохраняет выделение, чтобы можно было повторить', async ({ companion, page }) => {
    await companion.configure({ actionOverrides: { '/api/ai/request': { status: 500, body: 'LLM недоступна' } } });
    await page.locator('[data-msg-id="stt:1"] .chat-bubble').click();
    await page.getByTitle('Сгенерировать ответ').click();
    await expect(companion.status).toContainText('LLM недоступна');
    await expect(page.locator('.selection-badge')).toHaveText('1');
  });

  test('prompt с выделением уходит с selectedMessageIds', async ({ companion, page }) => {
    await page.locator('[data-msg-id="mic:2"] .chat-bubble').click();
    await companion.openComposer();
    await companion.textarea.fill('Оцени мой ответ');
    await companion.textarea.press('Control+Enter');
    await expect.poll(async () => (await companion.posts('/api/prompt/send')).length).toBe(1);
    const [post] = await companion.posts('/api/prompt/send');
    expect(post.body.selectedMessageIds).toEqual(['mic:2']);
    await expect(page.locator('.chat-row.selected')).toHaveCount(0);
  });

  test('выделенное сообщение исчезло с компьютера — счётчик выделения обновляется', async ({ companion, page }) => {
    await page.locator('[data-msg-id="stt:1"] .chat-bubble').click();
    await page.locator('[data-msg-id="stt:4"] .chat-bubble').click();
    await expect(page.locator('.selection-badge')).toHaveText('2');
    await companion.update((data) => { data.timeline = data.timeline.filter((message) => message.id !== 'stt:4'); });
    await expect(page.locator('.selection-badge')).toHaveText('1');
  });
});

test.describe('Кнопки управления', () => {
  test('очистка AI контекста и истории', async ({ companion, page }) => {
    await companion.reset(conversation());
    await companion.open();
    await page.getByTitle('Очистить AI контекст').click();
    await expect(companion.status).toContainText('AI контекст очищен');
    expect(await companion.posts('/api/context/clear')).toHaveLength(1);
    await expect(companion.rows).not.toHaveCount(0);

    await page.getByTitle('Очистить историю').click();
    await expect(companion.status).toContainText('История очищена');
    await expect(page.locator('.chat-row:not([data-msg-id="stt:live"])')).toHaveCount(0);
    expect(await companion.posts('/api/history/clear')).toHaveLength(1);
  });

  test('после очистки истории пустая лента показывает подсказку', async ({ companion, page }) => {
    await companion.reset(snapshotData([stt(1, 'Вопрос')]));
    await companion.open();
    await page.getByTitle('Очистить историю').click();
    await expect(page.locator('.chat-empty')).toContainText('Сообщений пока нет');
  });

  test('web search переключается, запоминается и уходит в запросе', async ({ companion, page }) => {
    await companion.reset(conversation());
    await companion.open();
    const toggle = page.locator('.dock-circle-button.web-search');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await page.reload();
    await companion.waitConnected();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await page.getByTitle('Сгенерировать ответ').click();
    await expect.poll(async () => (await companion.posts('/api/ai/request')).at(-1)?.body.openaiResponsesWebSearch).toBe(true);
  });

  test('запись и микрофон: состояние на кнопках, двойной тап не шлёт второй запрос', async ({ companion, page }) => {
    await companion.reset(conversation());
    await companion.open();
    await companion.hold('/api/record/start');
    await companion.recordButton.click();
    await expect(companion.recordButton).toBeDisabled();
    await companion.recordButton.click({ force: true });
    await companion.release('/api/record/start');
    await expect(companion.recordButton).toHaveAttribute('title', 'Остановить запись');
    await expect(companion.recordButton).toHaveClass(/recording/);
    expect(await companion.posts('/api/record/start')).toHaveLength(1);

    await companion.recordButton.click();
    await expect(companion.recordButton).toHaveAttribute('title', 'Начать запись');

    const micButton = page.locator('.dock-microphone-button');
    await micButton.click();
    await expect(micButton).toHaveClass(/active/);
    await expect(micButton).toHaveAttribute('title', 'Включить микрофон в приложении');
    await micButton.click();
    await expect(micButton).not.toHaveClass(/active/);
  });

  test('desktop просит авторизацию: подсказка и выключенные действия', async ({ companion, page }) => {
    await companion.reset(snapshotData([], { authRequired: true }));
    await companion.open({ waitConnected: false });
    await expect(page.locator('.chat-empty')).toContainText('Сначала авторизуйся');
    for (const title of ['Начать запись', 'Сгенерировать ответ', 'Открыть сообщение в AI', 'Очистить историю']) {
      await expect(page.getByTitle(title)).toBeDisabled();
    }
  });

  test('ссылка без token: понятное сообщение, никаких запросов к API', async ({ companion, page }) => {
    const apiRequests: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/') || url.pathname === '/events') apiRequests.push(url.pathname);
    });
    await companion.open({ token: null });
    await expect(page.locator('.chat-empty')).toContainText('Некорректная companion-ссылка');
    await expect(companion.status).toContainText('Ссылка не содержит token');
    for (const title of ['Начать запись', 'Сгенерировать ответ', 'Открыть сообщение в AI', 'Очистить AI контекст']) {
      await expect(page.getByTitle(title)).toBeDisabled();
    }
    await page.waitForTimeout(1_000);
    expect(apiRequests).toEqual([]);
  });
});
