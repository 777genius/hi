import type { Page } from '@playwright/test';
import { expect, haiku, makePng, snapshotData, stt, test } from './support';

const conversation = () => snapshotData(Array.from({ length: 24 }, (_, index) => (
  index % 2 ? haiku(index + 1, `Ответ ${index}`) : stt(index + 1, `Вопрос ${index}`)
)));

/**
 * Эмуляция экранной клавиатуры: visualViewport становится ниже и может сместиться (offsetTop),
 * как в iOS Safari / Android Chrome при фокусе поля. layout viewport при этом не меняется.
 */
async function installKeyboardEmulation(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = { offsetTop: 0, height: 0 };
    const proto = Object.getPrototypeOf(window.visualViewport) as object;
    Object.defineProperty(proto, 'offsetTop', { configurable: true, get: () => state.offsetTop });
    Object.defineProperty(proto, 'height', { configurable: true, get: () => state.height || window.innerHeight });
    (window as unknown as { __keyboard: (offsetTop: number, height: number) => void }).__keyboard = (offsetTop, height) => {
      state.offsetTop = offsetTop;
      state.height = height;
      window.visualViewport!.dispatchEvent(new Event('resize'));
      window.visualViewport!.dispatchEvent(new Event('scroll'));
    };
  });
}

async function setKeyboard(page: Page, offsetTop: number, height: number): Promise<void> {
  await page.evaluate(([top, h]) => {
    (window as unknown as { __keyboard: (offsetTop: number, height: number) => void }).__keyboard(top, h);
  }, [offsetTop, height] as const);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test.describe('Composer сообщения в AI', () => {
  test.beforeEach(async ({ companion }) => {
    await companion.reset(conversation());
    await companion.open();
  });

  test('открывается вверху экрана, поле сразу в фокусе, закрывается крестиком и кнопкой дока', async ({ companion, page }) => {
    await companion.openComposer();
    await expect(companion.textarea).toBeFocused();
    const box = (await companion.composer.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeLessThanOrEqual(24);
    // Карточка не перекрывает док и не растянута на весь экран: под ней видна лента.
    const viewport = page.viewportSize()!;
    expect(box.y + box.height).toBeLessThan(viewport.height * 0.6);

    await page.locator('.ask-close-button').click();
    await expect(companion.composer).toHaveCount(0);

    await companion.openComposer();
    await expect(companion.textarea).toBeFocused();
    await companion.composerToggle.click();
    await expect(companion.composer).toHaveCount(0);
  });

  test('после закрытия лента снова доступна для нажатий', async ({ companion, page }) => {
    await companion.openComposer();
    await page.locator('.ask-close-button').click();
    await expect(companion.composer).toHaveCount(0);
    const firstVisibleQuestion = page.locator('.chat-row.incoming').first();
    await companion.userScrollTo(0);
    await firstVisibleQuestion.locator('.chat-bubble').click();
    await expect(firstVisibleQuestion).toHaveClass(/selected/);
  });

  test('Ctrl+Enter и Cmd+Enter отправляют, пустое и пробелы отправить нельзя', async ({ companion, page }) => {
    await companion.openComposer();
    await expect(companion.sendButton).toBeDisabled();
    await companion.textarea.fill('   \n  ');
    await expect(companion.sendButton).toBeDisabled();
    await companion.textarea.press('Control+Enter');
    // Подсказка видна в самой карточке, а не под ней.
    await expect(companion.composerStatus).toHaveText('Добавь текст или фото для отправки');
    await expect(companion.composerStatus).toBeInViewport();
    expect(await companion.posts('/api/prompt/send')).toHaveLength(0);

    await companion.textarea.fill('  Как работает GC в V8?  ');
    await companion.textarea.press('Control+Enter');
    await expect(companion.composer).toHaveCount(0);
    await expect.poll(async () => (await companion.posts('/api/prompt/send')).length).toBe(1);
    const [first] = await companion.posts('/api/prompt/send');
    expect(first.body.text).toBe('Как работает GC в V8?');
    expect(first.body.images).toEqual([]);
    expect(first.token).toBe(companion.token);
    expect(first.requestId).toBeTruthy();
    await expect(page.locator('.chat-row.prompt').last()).toContainText('Как работает GC в V8?');

    await companion.openComposer();
    await expect(companion.textarea).toHaveValue('');
    await companion.textarea.fill('Второй вопрос');
    await companion.textarea.press('Meta+Enter');
    await expect.poll(async () => (await companion.posts('/api/prompt/send')).length).toBe(2);
    await expect(companion.composer).toHaveCount(0);
  });

  test('при клавиатуре (меньший viewport) поле остаётся видимым, а «Отправить» достижима', async ({ companion, page }) => {
    const width = page.viewportSize()!.width;
    await companion.openComposer();
    await companion.textarea.fill('Черновик');
    await page.setViewportSize({ width, height: 420 });
    await expect(companion.textarea).toBeFocused();
    await expect(companion.textarea).toBeInViewport();
    const box = (await companion.composer.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(420);
    await companion.sendButton.scrollIntoViewIfNeeded();
    await expect(companion.sendButton).toBeInViewport();
    await expect(companion.textarea).toHaveValue('Черновик');
  });

  test('при сдвиге visualViewport (iOS прокрутил страницу к полю) карточка едет вместе с видимой областью', async ({ companion, page }) => {
    await installKeyboardEmulation(page);
    const rectOf = (selector: string) => page.locator(selector).evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    });
    // На iOS клавиатура выезжает и сдвигает видимую область сразу после открытия, пока идёт анимация появления:
    // карточка должна встать на место сразу, а не «плыть» за клавиатурой.
    await companion.composerToggle.click();
    await setKeyboard(page, 160, 420);
    const opening = await rectOf('.ask-card');
    // Допуск -10px: сама анимация выезда (margin-top), но не половина пути до места под клавиатурой.
    expect(opening.top - 160).toBeGreaterThanOrEqual(-12);
    expect(opening.top - 160).toBeLessThanOrEqual(24);
    await companion.composer.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
    await setKeyboard(page, 0, 0);

    // 5 фото делают карточку высокой: она должна поместиться в область над клавиатурой.
    await page.locator('.prompt-file-input').nth(1).setInputFiles(
      Array.from({ length: 5 }, (_, index) => ({ name: `shot-${index}.png`, mimeType: 'image/png', buffer: makePng(64, 48, { seed: index }) })),
    );
    await expect(page.locator('.prompt-attachment')).toHaveCount(5);
    await companion.textarea.focus();

    // Координаты берём из layout viewport (getBoundingClientRect): boundingBox()/scrollIntoView Playwright
    // сами учитывают visualViewport и с подменённым offsetTop дают неверную картину.
    const visibleHeight = 380;
    for (const offsetTop of [0, 160]) {
      await setKeyboard(page, offsetTop, visibleHeight);
      const card = await rectOf('.ask-card');
      // Верх карточки у верхнего края видимой области, а не уехал за неё.
      expect(card.top - offsetTop, `offsetTop=${offsetTop}`).toBeGreaterThanOrEqual(0);
      expect(card.top - offsetTop, `offsetTop=${offsetTop}`).toBeLessThanOrEqual(24);
      // Карточка целиком над клавиатурой: внутри неё можно доскроллить до «Отправить».
      expect(card.bottom - offsetTop, `offsetTop=${offsetTop}`).toBeLessThanOrEqual(visibleHeight);
      // Пользователь листает карточку пальцем до конца.
      await page.locator('.ask-card').evaluate((element) => { element.scrollTop = element.scrollHeight; });
      const send = await rectOf('.send-button');
      expect(send.bottom - offsetTop, `offsetTop=${offsetTop}`).toBeLessThanOrEqual(visibleHeight);
      expect(send.top - offsetTop, `offsetTop=${offsetTop}`).toBeGreaterThanOrEqual(0);
    }

    // Клавиатура закрылась: карточка вернулась наверх и снова может быть выше.
    await setKeyboard(page, 0, 0);
    const card = await rectOf('.ask-card');
    expect(card.top).toBeLessThanOrEqual(24);
    const maxHeight = await companion.composer.evaluate((element) => Number.parseFloat(getComputedStyle(element).maxHeight));
    expect(maxHeight).toBeGreaterThan(visibleHeight);
  });

  test('пока сообщение уходит, повторный Ctrl+Enter не дублирует отправку, а поле не редактируется', async ({ companion, page }) => {
    await companion.openComposer();
    await companion.textarea.fill('Один раз');
    await companion.hold('/api/prompt/send');
    await companion.textarea.press('Control+Enter');
    await expect(companion.textarea).toHaveAttribute('readonly', '');
    await expect(page.getByTitle('Выбрать из галереи')).toBeDisabled();
    await companion.textarea.press('Control+Enter');
    await companion.textarea.press('X');
    await expect(companion.textarea).toHaveValue('Один раз');
    await companion.release('/api/prompt/send');
    await expect(companion.composer).toHaveCount(0);
    expect(await companion.posts('/api/prompt/send')).toHaveLength(1);
  });

  test('черновик можно продолжать печатать, пока связь восстанавливается', async ({ companion }) => {
    await companion.openComposer();
    await companion.textarea.fill('Начал писать');
    await companion.configure({ stateOverride: { drop: true, times: 50 } });
    await companion.dropStreams();
    await expect(companion.sendButton).toBeDisabled();
    // Статус связи виден пользователю и при открытом composer.
    await expect(companion.composerStatus).toHaveText(/переподключ|восстановить связь|Не удалось подключиться/);
    await expect(companion.composerStatus).toBeInViewport();
    await expect(companion.textarea).toBeEnabled();
    await expect(companion.textarea).toBeFocused();
    await companion.textarea.pressSequentially(' и продолжаю');
    await expect(companion.textarea).toHaveValue('Начал писать и продолжаю');

    await companion.configure({ stateOverride: null });
    await expect(companion.sendButton).toBeEnabled({ timeout: 20_000 });
    await companion.sendButton.click();
    await expect.poll(async () => (await companion.posts('/api/prompt/send')).at(-1)?.body.text).toBe('Начал писать и продолжаю');
  });
});

test('на телефоне 360px composer не растягивается на весь экран', async ({ companion, page }, info) => {
  test.skip(info.project.name === 'tablet', 'узкий телефон');
  await page.setViewportSize({ width: 360, height: 760 });
  await companion.reset(conversation());
  await companion.open();
  await companion.openComposer();
  const box = (await companion.composer.boundingBox())!;
  expect(box.y).toBeLessThanOrEqual(24);
  // Карточка по содержимому (заголовок + поле + кнопка), не до самого дока.
  expect(box.height).toBeLessThan(320);
});
