import { expect, haiku, mic, prompt, snapshotData, stt, test } from './support';

test.describe('Порядок сообщений в ленте', () => {
  test('несколько ответов AI на один вопрос идут в порядке создания, вперемешку с mic/stt/prompt', async ({ companion }) => {
    await companion.reset(snapshotData([
      stt(1, 'Расскажи про SOLID'),
      mic(2, 'Сейчас расскажу'),
      // Ответы привязаны к вопросу stt:1, но созданы в разное время и после mic:2.
      haiku(3, 'Первый ответ AI', { id: 'haiku:a', insertAfterId: 'stt:1', createdAtMs: 1_760_000_003_000 }),
      prompt(4, 'А что такое LSP?'),
      haiku(5, 'Второй ответ AI', { id: 'haiku:b', insertAfterId: 'stt:1', createdAtMs: 1_760_000_005_000 }),
      stt(6, 'Следующий вопрос: CAP теорема'),
      haiku(7, 'Третий ответ AI', { id: 'haiku:c', insertAfterId: 'stt:1', createdAtMs: 1_760_000_007_000 }),
      haiku(8, 'Ответ на prompt', { id: 'haiku:p', insertAfterId: 'prompt:4' }),
      haiku(9, 'Ответ без привязки'),
    ]));
    await companion.open();

    await expect.poll(() => companion.rowIds()).toEqual([
      'stt:1', 'haiku:a', 'haiku:b', 'haiku:c',
      'mic:2',
      'prompt:4', 'haiku:p',
      'stt:6',
      'haiku:9',
    ]);
  });

  test('новый ответ на старый вопрос, пришедший по SSE, встаёт после уже показанных ответов', async ({ companion }) => {
    await companion.reset(snapshotData([
      stt(1, 'Вопрос 1'),
      haiku(2, 'Ответ 1.1', { id: 'haiku:1', insertAfterId: 'stt:1' }),
      stt(3, 'Вопрос 2'),
    ]));
    await companion.open();
    await expect.poll(() => companion.rowIds()).toEqual(['stt:1', 'haiku:1', 'stt:3']);

    await companion.update((data) => {
      data.timeline.push(haiku(4, 'Ответ 1.2 (перегенерация)', { id: 'haiku:2', insertAfterId: 'stt:1' }));
      data.timeline.push(haiku(5, 'Ответ 2.1', { id: 'haiku:3', insertAfterId: 'stt:3' }));
    });
    await expect.poll(() => companion.rowIds()).toEqual(['stt:1', 'haiku:1', 'haiku:2', 'stt:3', 'haiku:3']);
    await expect(companion.page.locator('[data-msg-id="haiku:2"]')).toContainText('перегенерация');
  });

  test('live partial стоит по времени начала, ответ на него переезжает к финальному вопросу', async ({ companion }) => {
    const startedAt = 1_760_000_010_000;
    await companion.reset(snapshotData([
      stt(1, 'Старый вопрос'),
      mic(2, 'Мой ответ голосом', { createdAtMs: startedAt + 5_000 }),
    ], {
      live: {
        partialText: 'Как устроен event loop',
        partialStartedAtMs: startedAt,
        microphonePartialText: 'эээ сейчас',
        microphonePartialStartedAtMs: startedAt + 9_000,
      },
    }));
    await companion.open();

    await expect.poll(() => companion.rowIds()).toEqual(['stt:1', 'stt:live', 'mic:2', 'mic:live']);
    await expect(companion.page.locator('[data-msg-id="stt:live"]')).toHaveClass(/partial/);
    await expect(companion.page.locator('[data-msg-id="stt:live"] .chat-cursor')).toBeVisible();

    // AI начал отвечать на ещё не финальный вопрос.
    await companion.update((data) => {
      data.timeline.push(haiku(3, 'Ответ про event loop', { id: 'haiku:live', insertAfterId: 'stt:live', status: 'streaming', createdAtMs: startedAt + 6_000 }));
    });
    await expect.poll(() => companion.rowIds()).toEqual(['stt:1', 'stt:live', 'haiku:live', 'mic:2', 'mic:live']);

    // Partial стал финальным сообщением: live-строка исчезла, ответ встал под последним stt.
    await companion.update((data) => {
      data.live = {};
      data.timeline.push(stt(4, 'Как устроен event loop?', { createdAtMs: startedAt }));
    });
    await expect.poll(() => companion.rowIds()).toEqual(['stt:1', 'stt:4', 'haiku:live', 'mic:2']);
  });

  test('live partial, совпадающий с только что пришедшим финальным текстом, не дублируется', async ({ companion }) => {
    const at = Date.now();
    await companion.reset(snapshotData([
      stt(1, 'Привет, расскажи о себе.', { createdAtMs: at }),
    ], {
      live: { partialText: 'привет расскажи о себе', partialStartedAtMs: at + 500 },
    }));
    await companion.open();
    await expect.poll(() => companion.rowIds()).toEqual(['stt:1']);
  });

  test('удалённые сообщения остаются на месте, не кликабельны и не выделяются', async ({ companion }) => {
    await companion.reset(snapshotData([
      stt(1, 'Вопрос'),
      mic(2, 'Удалено', { deleted: true }),
      stt(3, 'Ещё вопрос'),
    ]));
    await companion.open();
    await expect.poll(() => companion.rowIds()).toEqual(['stt:1', 'mic:2', 'stt:3']);
    const deleted = companion.page.locator('[data-msg-id="mic:2"] .chat-bubble');
    await expect(deleted).toHaveClass(/deleted/);
    await expect(deleted).not.toHaveClass(/clickable/);
    await deleted.click();
    await expect(companion.page.locator('.chat-row.selected')).toHaveCount(0);
    await expect(companion.page.locator('.selection-clear')).toHaveCount(0);

    // Сообщение удалили на компьютере уже после показа.
    await companion.update((data) => {
      data.timeline[0].deleted = true;
    });
    await expect(companion.page.locator('[data-msg-id="stt:1"] .chat-bubble')).toHaveClass(/deleted/);
    await expect.poll(() => companion.rowIds()).toEqual(['stt:1', 'mic:2', 'stt:3']);
  });
});
