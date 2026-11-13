import { expect, makePng, snapshotData, stt, test, TINY_JPEG, TINY_WEBP, type CompanionMock } from './support';

const MAX_IMAGE_BYTES = Math.floor(4.5 * 1024 * 1024);

const png = (name: string, seed = 1) => ({ name, mimeType: 'image/png', buffer: makePng(40, 30, { seed }) });

/** Выбор файлов через настоящий file chooser, открытый кнопкой «Выбрать из галереи». */
async function pickFromGallery(companion: CompanionMock, files: Parameters<import('@playwright/test').FileChooser['setFiles']>[0]) {
  const chooserPromise = companion.page.waitForEvent('filechooser');
  await companion.page.getByTitle('Выбрать из галереи').click();
  const chooser = await chooserPromise;
  await chooser.setFiles(files);
}

test.describe('Фото в сообщении AI', () => {
  test.beforeEach(async ({ companion }) => {
    await companion.reset(snapshotData([stt(1, 'Покажи, что на скриншоте')]));
    await companion.open();
    await companion.openComposer();
  });

  test('«Сфоткать» открывает камеру (capture), «Выбрать из галереи» — без capture', async ({ companion, page }) => {
    const cameraChooser = page.waitForEvent('filechooser');
    await page.getByTitle('Сфоткать').click();
    const camera = await cameraChooser;
    expect(camera.isMultiple()).toBe(true);
    expect(await camera.element().getAttribute('capture')).toBe('environment');
    expect(await camera.element().getAttribute('accept')).toBe('image/*');
    await camera.setFiles([]);

    const galleryChooser = page.waitForEvent('filechooser');
    await page.getByTitle('Выбрать из галереи').click();
    const gallery = await galleryChooser;
    expect(await gallery.element().getAttribute('capture')).toBeNull();
    expect(await gallery.element().getAttribute('accept')).toBe('image/*');
    await gallery.setFiles([]);
    await expect(page.locator('.prompt-attachment')).toHaveCount(0);
    await expect(companion.composer).toBeVisible();
  });

  test('PNG, JPEG и WebP попадают в превью и уходят в теле images[{mediaType,dataBase64}]', async ({ companion, page }) => {
    await pickFromGallery(companion, [
      png('screen.png'),
      { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: TINY_JPEG },
      { name: 'image.webp', mimeType: 'image/webp', buffer: TINY_WEBP },
    ]);
    await expect(page.locator('.prompt-attachment')).toHaveCount(3);
    // Превью реально декодировались.
    for (const image of await page.locator('.prompt-attachment-image').all()) {
      await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    }
    await companion.textarea.fill('Что здесь не так?');
    await companion.sendButton.click();
    await expect(companion.composer).toHaveCount(0);

    const [post] = await companion.posts('/api/prompt/send');
    expect(post.body.text).toBe('Что здесь не так?');
    expect(post.body.images).toEqual([
      expect.objectContaining({ mediaType: 'image/png', dataBase64Prefix: expect.stringMatching(/^iVBORw0KGgo/) }),
      expect.objectContaining({ mediaType: 'image/jpeg', dataBase64Prefix: expect.stringMatching(/^\/9j\//) }),
      expect.objectContaining({ mediaType: 'image/webp', dataBase64Prefix: expect.stringMatching(/^UklGR/) }),
    ]);
    // Сообщение с фото появилось в ленте.
    await expect(page.locator('.chat-row.prompt').last().locator('.chat-attachment-img')).toHaveCount(3);

    // Черновик очищен для следующего сообщения.
    await companion.openComposer();
    await expect(page.locator('.prompt-attachment')).toHaveCount(0);
    await expect(companion.textarea).toHaveValue('');
  });

  test('только фото без текста можно отправить', async ({ companion, page }) => {
    await expect(companion.sendButton).toBeDisabled();
    await pickFromGallery(companion, [png('only.png')]);
    await expect(page.locator('.prompt-attachment')).toHaveCount(1);
    await expect(companion.sendButton).toBeEnabled();
    await companion.sendButton.click();
    await expect.poll(async () => (await companion.posts('/api/prompt/send')).length).toBe(1);
    const [post] = await companion.posts('/api/prompt/send');
    expect(post.body.text).toBe('');
    expect(post.body.images).toHaveLength(1);
  });

  test('большое фото (больше 4,5 МБ) ужимается до лимита', async ({ companion, page }) => {
    const big = makePng(1700, 1000, { noise: true });
    expect(big.length).toBeGreaterThan(MAX_IMAGE_BYTES);
    await pickFromGallery(companion, [{ name: 'huge.png', mimeType: 'image/png', buffer: big }]);
    await expect(page.locator('.prompt-attachment')).toHaveCount(1, { timeout: 20_000 });
    await companion.sendButton.click();
    await expect.poll(async () => (await companion.posts('/api/prompt/send')).length).toBe(1);
    const [post] = await companion.posts('/api/prompt/send');
    const [image] = post.body.images as Array<{ mediaType: string; dataBase64Length: number }>;
    expect(['image/png', 'image/webp', 'image/jpeg']).toContain(image.mediaType);
    expect(image.dataBase64Length * 0.75).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    expect(image.dataBase64Length).toBeGreaterThan(1000);
  });

  test('HEIC отклоняется с понятным сообщением, которое видно поверх composer', async ({ companion, page }) => {
    await pickFromGallery(companion, [{ name: 'IMG_0001.HEIC', mimeType: 'image/heic', buffer: Buffer.from('not really heic') }]);
    await expect(companion.composerStatus).toContainText('HEIC');
    await expect(companion.composerStatus).toBeInViewport();
    await expect(page.locator('.prompt-attachment')).toHaveCount(0);

    // HEIC вместе с обычным фото: обычное добавляется, про HEIC предупреждаем.
    await pickFromGallery(companion, [
      { name: 'IMG_0002.heic', mimeType: '', buffer: Buffer.from('heic without mime') },
      png('ok.png'),
    ]);
    await expect(page.locator('.prompt-attachment')).toHaveCount(1);
    await expect(companion.composerStatus).toContainText('HEIC');
  });

  test('не больше 5 фото: лишние пропускаются, кнопки сообщают о лимите', async ({ companion, page }) => {
    await pickFromGallery(companion, Array.from({ length: 6 }, (_, index) => png(`shot-${index}.png`, index)));
    await expect(page.locator('.prompt-attachment')).toHaveCount(5);
    await expect(companion.composerStatus).toContainText('максимум 5 фото');

    let chooserOpened = false;
    page.on('filechooser', () => { chooserOpened = true; });
    await page.getByTitle('Сфоткать').click();
    await expect(companion.composerStatus).toContainText('не больше 5 фото');
    await page.waitForTimeout(300);
    expect(chooserOpened).toBe(false);
  });

  test('удаление превью убирает фото из отправки', async ({ companion, page }) => {
    await pickFromGallery(companion, [png('a.png', 1), png('b.png', 2), png('c.png', 3)]);
    await expect(page.locator('.prompt-attachment')).toHaveCount(3);
    await page.locator('.prompt-attachment').nth(1).getByTitle('Удалить фото').click();
    await expect(page.locator('.prompt-attachment')).toHaveCount(2);
    await companion.textarea.fill('Два фото');
    await companion.textarea.press('Control+Enter');
    await expect.poll(async () => (await companion.posts('/api/prompt/send')).length).toBe(1);
    const [post] = await companion.posts('/api/prompt/send');
    expect(post.body.images).toHaveLength(2);
  });

  for (const status of [413, 500]) {
    test(`ошибка сервера ${status}: черновик и фото не теряются, ошибка видна`, async ({ companion, page }) => {
      const body = status === 413 ? 'Request body too large' : 'Internal error: prompt pipeline failed';
      await companion.configure({ actionOverrides: { '/api/prompt/send': { status, body } } });
      await pickFromGallery(companion, [png('a.png')]);
      await companion.textarea.fill('Важный вопрос');
      await companion.sendButton.click();

      await expect(companion.composerStatus).toBeVisible();
      await expect(companion.composerStatus).toBeInViewport();
      if (status === 413) {
        // Пользователь понимает, что делать, а не видит технический английский текст.
        await expect(companion.composerStatus).toContainText('фото');
        await expect(companion.composerStatus).not.toContainText('Request body too large');
      } else {
        await expect(companion.composerStatus).toContainText('prompt pipeline failed');
      }
      await expect(companion.composer).toBeVisible();
      await expect(companion.textarea).toHaveValue('Важный вопрос');
      await expect(page.locator('.prompt-attachment')).toHaveCount(1);
      await expect(page.locator('.chat-row.prompt')).toHaveCount(0);

      // Повтор после ошибки уходит одним запросом.
      await companion.sendButton.click();
      await expect(companion.composer).toHaveCount(0);
      await expect.poll(async () => (await companion.posts('/api/prompt/send')).length).toBe(2);
      await expect(page.locator('.chat-row.prompt')).toHaveCount(1);
    });
  }

  test('обрыв связи во время отправки: черновик цел, без авто-повтора, предупреждение видно', async ({ companion, page }) => {
    // Сервер принял сообщение, но ответ потерялся посреди передачи (как пропавший Wi-Fi).
    await companion.configure({ actionOverrides: { '/api/prompt/send': { dropAfterHeaders: true, applyAction: true } } });
    await pickFromGallery(companion, [png('a.png')]);
    await companion.textarea.fill('Не потеряй меня');
    await companion.sendButton.click();

    await expect(companion.composerStatus).toContainText('Не удалось подтвердить отправку');
    await expect(companion.textarea).toHaveValue('Не потеряй меня');
    await expect(page.locator('.prompt-attachment')).toHaveCount(1);
    // После переподключения лента показывает, что сообщение всё же дошло, а повтора не было.
    await expect(page.locator('.chat-row.prompt')).toHaveCount(1, { timeout: 15_000 });
    await expect(companion.sendButton).toBeEnabled({ timeout: 15_000 });
    expect(await companion.posts('/api/prompt/send')).toHaveLength(1);
    // Предупреждение не пропадает само после восстановления связи.
    await expect(companion.composerStatus).toContainText('Не удалось подтвердить отправку');
  });
});
