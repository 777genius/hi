import { expect, haiku, mic, prompt, snapshotData, stt, test } from './support';

const questions = (count: number) => Array.from({ length: count }, (_, index) => stt(index + 1, `Вопрос ${index}: расскажи про архитектуру сервиса`));
const paragraphs = (count: number) => Array.from({ length: count }, (_, index) => `Абзац ${index}: подробное объяснение, чтобы ответ рос по мере стриминга.`).join('\n\n');

test.describe('Автоскролл ленты', () => {
  test('новое сообщение прокручивает ленту, если пользователь внизу', async ({ companion }) => {
    await companion.reset(snapshotData(questions(40)));
    await companion.open();
    await expect.poll(async () => (await companion.scrollMetrics()).remaining).toBeLessThanOrEqual(2);
    await companion.update((data) => { data.timeline.push(stt(41, 'Совсем новый вопрос')); });
    await expect(companion.page.locator('[data-msg-id="stt:41"]')).toBeInViewport();
    await expect.poll(async () => (await companion.scrollMetrics()).remaining).toBeLessThanOrEqual(2);
  });

  test('если пользователь выше, новые сообщения не уводят вниз, а кнопка «вниз» возвращает', async ({ companion, page }) => {
    await companion.reset(snapshotData(questions(40)));
    await companion.open();
    await companion.userScrollTo(300);
    for (let index = 0; index < 3; index += 1) {
      await companion.update((data) => { data.timeline.push(stt(41 + index, `Новый вопрос ${index}`)); });
    }
    await expect(page.locator('[data-msg-id="stt:43"]')).toHaveCount(1);
    expect((await companion.scrollMetrics()).scrollTop).toBe(300);
    const button = page.locator('.scroll-to-bottom-button');
    await expect(button).toBeVisible();
    await button.click();
    await expect.poll(async () => (await companion.scrollMetrics()).remaining).toBeLessThanOrEqual(2);
    await expect(button).toBeHidden();
  });

  test('стриминг ответа никогда не тянет ленту вниз, даже если пользователь стоит внизу', async ({ companion, page }) => {
    await companion.reset(snapshotData(questions(40)));
    await companion.open();
    await companion.userScrollTo('bottom');
    const start = await companion.scrollMetrics();

    await companion.update((data) => {
      data.timeline.push(haiku(41, 'Начало ответа', { status: 'streaming', insertAfterId: 'stt:40' }));
    });
    for (let chunk = 1; chunk <= 3; chunk += 1) {
      await companion.update((data) => { data.timeline.at(-1)!.text = paragraphs(chunk * 3); });
      await expect(page.locator('[data-msg-id="haiku:41"]')).toContainText(`Абзац ${chunk * 3 - 1}`);
    }
    // Решение владельца: начало ответа остаётся на месте, лента не прыгает за текстом.
    expect((await companion.scrollMetrics()).scrollTop).toBe(start.scrollTop);
    await expect(page.locator('.scroll-to-bottom-button')).toBeVisible();

    // Пользователь сам долистал до конца: автоскролла всё равно нет, позиция остаётся той, где он её оставил.
    await companion.userScrollTo('bottom');
    const atBottom = (await companion.scrollMetrics()).scrollTop;
    await companion.update((data) => { data.timeline.at(-1)!.text = paragraphs(16); });
    await expect(page.locator('[data-msg-id="haiku:41"]')).toContainText('Абзац 15');
    expect((await companion.scrollMetrics()).scrollTop).toBe(atBottom);

    // Пользователь пролистал вверх перечитать: стриминг его не возвращает вниз.
    await companion.userScrollTo((await companion.scrollMetrics()).scrollTop - 400);
    const reading = (await companion.scrollMetrics()).scrollTop;
    await companion.update((data) => { data.timeline.at(-1)!.text = paragraphs(22); });
    await expect(page.locator('[data-msg-id="haiku:41"]')).toContainText('Абзац 21');
    expect((await companion.scrollMetrics()).scrollTop).toBe(reading);

    // Ответ завершился: позиция всё ещё не меняется.
    await companion.update((data) => { const last = data.timeline.at(-1)!; last.status = 'final'; last.text = paragraphs(24); });
    await expect(page.locator('.chat-cursor')).toHaveCount(0);
    expect((await companion.scrollMetrics()).scrollTop).toBe(reading);
  });

  test('стриминг, пока пользователь читает старые сообщения, вообще не двигает ленту', async ({ companion, page }) => {
    await companion.reset(snapshotData(questions(40)));
    await companion.open();
    await companion.userScrollTo(200);
    await companion.update((data) => {
      data.timeline.push(haiku(41, 'Начало', { status: 'streaming', insertAfterId: 'stt:40' }));
    });
    for (let chunk = 1; chunk <= 4; chunk += 1) {
      await companion.update((data) => { data.timeline.at(-1)!.text = paragraphs(chunk * 4); });
      await expect(page.locator('[data-msg-id="haiku:41"]')).toContainText(`Абзац ${chunk * 4 - 1}`);
      expect((await companion.scrollMetrics()).scrollTop).toBe(200);
    }
  });
});

test.describe('Большая лента и длинный контент', () => {
  test('300+ сообщений: открывается в конце, обновляется без ошибок и тормозов', async ({ companion, page }) => {
    const timeline = Array.from({ length: 360 }, (_, index) => {
      const seq = index + 1;
      if (index % 3 === 0) return stt(seq, `Вопрос ${index}: что такое идемпотентность?`);
      if (index % 3 === 1) return mic(seq, `Мой ответ ${index}: повтор запроса не меняет результат`);
      return haiku(seq, `**Подсказка ${index}:** используй \`request id\` и кэш результата.`, { insertAfterId: `stt:${seq - 2}` });
    });
    await companion.reset(snapshotData(timeline));
    const started = Date.now();
    await companion.open();
    await expect(companion.rows).toHaveCount(360);
    expect(Date.now() - started).toBeLessThan(15_000);
    await expect(page.locator('[data-msg-id="haiku:360"]')).toBeInViewport();

    // Быстрая серия обновлений (стриминг нового ответа) не роняет страницу.
    await companion.update((data) => { data.timeline.push(haiku(361, 'Стрим', { status: 'streaming', insertAfterId: 'stt:358' })); });
    for (let chunk = 0; chunk < 15; chunk += 1) {
      await companion.update((data) => { data.timeline.at(-1)!.text += ` слово${chunk}`; });
    }
    await expect(page.locator('[data-msg-id="haiku:361"]')).toContainText('слово14');
    await expect(companion.rows).toHaveCount(361);

    await companion.userScrollTo(0);
    await expect(page.locator('[data-msg-id="stt:1"]')).toBeInViewport();
    await expect(page.locator('.scroll-to-bottom-button')).toBeVisible();
  });

  test('длинная строка кода скроллится внутри блока, а не страница', async ({ companion, page }) => {
    const longLine = `const value = ${Array.from({ length: 40 }, (_, index) => `item${index}`).join(' + ')};`;
    await companion.reset(snapshotData([
      stt(1, 'Покажи длинный код'),
      haiku(2, `Вот код:\n\n\`\`\`ts\n${longLine}\nconsole.log(value);\n\`\`\``, { insertAfterId: 'stt:1' }),
      prompt(3, `Мой код:\n\`\`\`js\n${longLine}\n\`\`\``),
    ]));
    await companion.open();
    const viewportWidth = page.viewportSize()!.width;
    for (const id of ['haiku:2', 'prompt:3']) {
      const pre = page.locator(`[data-msg-id="${id}"] .code-block pre`);
      await expect(pre).toBeVisible();
      const metrics = await pre.evaluate((element) => {
        const bubble = element.closest('.chat-bubble')!.getBoundingClientRect();
        const before = element.scrollLeft;
        element.scrollLeft = 200;
        const after = element.scrollLeft;
        element.scrollLeft = before;
        return { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, after, bubbleRight: bubble.right };
      });
      expect(metrics.scrollWidth, id).toBeGreaterThan(metrics.clientWidth);
      expect(metrics.after, `${id}: блок кода прокручивается по горизонтали`).toBeGreaterThan(0);
      expect(metrics.bubbleRight, id).toBeLessThanOrEqual(viewportWidth);
    }
    const overflow = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      feed: document.querySelector('.chat-scroll')!.scrollWidth - document.querySelector('.chat-scroll')!.clientWidth,
    }));
    expect(overflow.document).toBeLessThanOrEqual(viewportWidth);
    expect(overflow.feed).toBeLessThanOrEqual(0);
  });

  test('длинные слова и URL переносятся и не раздвигают ленту', async ({ companion, page }) => {
    const word = 'Суперкалифраджилистикэкспиалидоций'.repeat(12);
    const url = `https://example.com/${'very-long-path-segment/'.repeat(20)}?query=${'x'.repeat(120)}`;
    await companion.reset(snapshotData([
      stt(1, word),
      mic(2, url),
      haiku(3, `Ссылка: ${url} и слово ${word}`, { insertAfterId: 'stt:1' }),
      prompt(4, `${word} ${url}`),
    ]));
    await companion.open();
    const viewportWidth = page.viewportSize()!.width;
    const result = await page.evaluate(() => Array.from(document.querySelectorAll('.chat-row')).map((row) => {
      const rowRect = row.getBoundingClientRect();
      const bubble = row.querySelector('.chat-bubble')!;
      const bubbleRect = bubble.getBoundingClientRect();
      return {
        id: (row as HTMLElement).dataset.msgId,
        overflow: bubble.scrollWidth - bubble.clientWidth,
        right: bubbleRect.right,
        rowRight: rowRect.right,
      };
    }));
    for (const row of result) {
      expect(row.overflow, `${row.id}: содержимое не шире пузыря`).toBeLessThanOrEqual(1);
      expect(row.right, `${row.id}: пузырь в пределах строки`).toBeLessThanOrEqual(row.rowRight + 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewportWidth);
    const link = page.locator('[data-msg-id="haiku:3"] a').first();
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
  });

  test('русский, украинский и английский текст отображаются без искажений', async ({ companion, page }) => {
    const ru = 'Расскажите о себе: опыт, стек и ожидания по зарплате — ёжик, щука, Ъ.';
    const uk = 'Розкажіть про себе: досвід, стек і очікування. Ґанок, їжак, єнот, ще, бджілка.';
    const en = 'Tell me about yourself: experience, stack and salary expectations.';
    await companion.reset(snapshotData([
      stt(1, ru), mic(2, uk), haiku(3, `${en}\n\n${uk}\n\n${ru}`, { insertAfterId: 'stt:1' }),
    ]));
    await companion.open();
    await expect(page.locator('[data-msg-id="stt:1"]')).toHaveText(ru);
    await expect(page.locator('[data-msg-id="mic:2"]')).toHaveText(uk);
    for (const text of [en, uk, ru]) {
      await expect(page.locator('[data-msg-id="haiku:3"]')).toContainText(text);
    }
  });

  test('markdown: списки, таблица, inline code, ссылки; HTML из ответа не исполняется', async ({ companion, page }) => {
    const markdown = [
      '## Сравнение',
      '',
      '- **REST** — просто',
      '- `gRPC` — быстро',
      '',
      '1. Первый шаг',
      '2. Второй шаг',
      '',
      '| Протокол | Транспорт | Формат | Стриминг | Браузер | Кэш |',
      '|---|---|---|---|---|---|',
      '| REST | HTTP/1.1 | JSON | нет | да | HTTP-кэш |',
      '| gRPC | HTTP/2 | Protobuf | да | через proxy | нет |',
      '',
      'Подробнее: [документация](https://grpc.io/docs/)',
      '',
      '<img src="x" onerror="window.__xss = 1"> <script>window.__xss = 2</script> <a href="javascript:window.__xss=3">клик</a>',
    ].join('\n');
    await companion.reset(snapshotData([stt(1, 'Сравни REST и gRPC'), haiku(2, markdown, { insertAfterId: 'stt:1' })]));
    await companion.open();
    const answer = page.locator('[data-msg-id="haiku:2"] .chat-markdown');
    await expect(answer.locator('h2')).toHaveText('Сравнение');
    await expect(answer.locator('ul > li')).toHaveCount(2);
    await expect(answer.locator('ol > li')).toHaveCount(2);
    await expect(answer.locator('li code')).toHaveText('gRPC');
    await expect(answer.locator('strong')).toHaveText('REST');
    await expect(answer.locator('table tr')).toHaveCount(3);
    await expect(answer.locator('a[href="https://grpc.io/docs/"]')).toHaveAttribute('target', '_blank');
    await expect(answer.locator('script')).toHaveCount(0);
    await expect(answer.locator('[onerror]')).toHaveCount(0);
    await expect(answer.locator('a[href^="javascript:"]')).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();

    // Таблица не шире пузыря и не даёт горизонтальной прокрутки всей ленты.
    const table = await answer.locator('table').evaluate((element) => {
      const bubble = element.closest('.chat-bubble')!.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      return { tableRight: rect.right, bubbleRight: bubble.right };
    });
    expect(table.tableRight).toBeLessThanOrEqual(table.bubbleRight + 1);
    const feedOverflow = await page.evaluate(() => {
      const feed = document.querySelector('.chat-scroll')!;
      return feed.scrollWidth - feed.clientWidth;
    });
    expect(feedOverflow).toBeLessThanOrEqual(0);
  });

  test('длинные старые ответы свёрнуты, тап раскрывает; последний ответ раскрыт', async ({ companion, page }) => {
    await companion.reset(snapshotData([
      stt(1, 'Вопрос 1'),
      haiku(2, paragraphs(8), { insertAfterId: 'stt:1' }),
      stt(3, 'Вопрос 2'),
      haiku(4, paragraphs(8), { insertAfterId: 'stt:3' }),
    ]));
    await companion.open();
    const older = page.locator('[data-msg-id="haiku:2"] .chat-collapsible-message');
    const latest = page.locator('[data-msg-id="haiku:4"] .chat-collapsible-message');
    await expect(older).toHaveClass(/collapsed/);
    await expect(latest).not.toHaveClass(/collapsed/);
    await companion.userScrollTo(0);
    await older.click();
    await expect(older).not.toHaveClass(/collapsed/);
  });
});
