import { randomUUID } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { expect, test as base, type Locator, type Page } from '@playwright/test';
import type {
  CompanionMessage,
  CompanionSnapshotData,
} from '../../src/windowing/stateSync/contracts';
import {
  emptyCompanionSnapshotData,
  MOCK_CONTROL_PREFIX,
  type MockConfig,
  type MockLog,
} from './mockCompanionServer';

export { expect };

const BASE_TIME_MS = 1_760_000_000_000;

type MessageInit = Partial<CompanionMessage> & { text?: string };

/** Сообщение ленты в формате desktop-сервера (CompanionMessage). */
export function message(seq: number, init: MessageInit = {}): CompanionMessage {
  const kind = init.kind ?? 'stt';
  const outgoing = kind === 'mic' || kind === 'prompt' || kind === 'haiku';
  return {
    id: init.id ?? `${kind}:${seq}`,
    seq,
    kind,
    role: init.role ?? (outgoing ? 'outgoing' : 'incoming'),
    status: init.status ?? 'final',
    text: init.text ?? `${kind} ${seq}`,
    createdAtMs: init.createdAtMs ?? BASE_TIME_MS + seq * 1_000,
    ...init,
  };
}

export const stt = (seq: number, text: string, init: MessageInit = {}) => message(seq, { kind: 'stt', text, ...init });
export const mic = (seq: number, text: string, init: MessageInit = {}) => message(seq, { kind: 'mic', text, ...init });
export const prompt = (seq: number, text: string, init: MessageInit = {}) => message(seq, { kind: 'prompt', text, ...init });
export const haiku = (seq: number, text: string, init: MessageInit = {}) => message(seq, { kind: 'haiku', text, ...init });

export function snapshotData(
  timeline: CompanionMessage[] = [],
  patch: Partial<CompanionSnapshotData> = {},
): CompanionSnapshotData {
  return { ...emptyCompanionSnapshotData(), ...patch, timeline };
}

type OpenOptions = {
  /** null открывает страницу без token. */
  token?: string | null;
  /** Не ждать подключения (для сценариев с ошибкой связи). */
  waitConnected?: boolean;
};

export class CompanionMock {
  readonly token = `ui-${randomUUID()}`;

  constructor(readonly page: Page) {}

  private async control<T>(command: string, body?: unknown): Promise<T> {
    const response = await this.page.request.post(
      `${MOCK_CONTROL_PREFIX}${encodeURIComponent(this.token)}/${command}`,
      { data: body ?? {} },
    );
    expect(response.ok(), `mock ${command}`).toBeTruthy();
    return await response.json() as T;
  }

  reset(data: CompanionSnapshotData = snapshotData(), config: MockConfig = {}) {
    return this.control('reset', { data, config });
  }

  async state(): Promise<CompanionSnapshotData> {
    const envelope = await this.control<{ data: CompanionSnapshotData }>('state');
    return envelope.data;
  }

  /** Меняет состояние на сервере и рассылает snapshot по SSE (ревизия растёт). */
  async update(mutate: (data: CompanionSnapshotData) => void): Promise<void> {
    const data = await this.state();
    mutate(data);
    await this.control('publish', { data });
  }

  publishRaw(frame: string) {
    return this.control('publish-raw', { frame });
  }

  dropStreams() {
    return this.control('drop-streams');
  }

  configure(config: MockConfig) {
    return this.control('configure', config);
  }

  hold(path: string) {
    return this.control('hold', { path });
  }

  release(path: string) {
    return this.control('release', { path });
  }

  log(): Promise<MockLog> {
    return this.control<MockLog>('log');
  }

  async posts(path?: string) {
    const log = await this.log();
    return path ? log.posts.filter((post) => post.path === path) : log.posts;
  }

  async open(options: OpenOptions = {}): Promise<void> {
    const token = options.token === undefined ? this.token : options.token;
    const query = token === null ? '' : `?token=${encodeURIComponent(token)}`;
    await this.page.goto(`/companion.html${query}`);
    await expect(this.page.locator('.controls-dock')).toBeVisible();
    if (options.waitConnected !== false && token !== null) {
      await this.waitConnected();
    }
  }

  async waitConnected(): Promise<void> {
    await expect(this.recordButton).toBeEnabled({ timeout: 15_000 });
  }

  get feed(): Locator {
    return this.page.locator('.chat-scroll');
  }

  get rows(): Locator {
    return this.page.locator('.chat-row');
  }

  get recordButton(): Locator {
    return this.page.locator('.dock-record-button');
  }

  get composerToggle(): Locator {
    return this.page.locator('.controls-center .dock-circle-button').last();
  }

  get composer(): Locator {
    return this.page.locator('.ask-card');
  }

  get textarea(): Locator {
    return this.page.locator('.ask-textarea');
  }

  get sendButton(): Locator {
    return this.page.locator('.send-button');
  }

  get status(): Locator {
    return this.page.locator('.top-connection-status');
  }

  /** Строка статуса внутри открытого composer (верхнюю строку статуса карточка закрывает). */
  get composerStatus(): Locator {
    return this.page.locator('.ask-card .ask-status');
  }

  async rowIds(): Promise<string[]> {
    return this.rows.evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.msgId ?? ''));
  }

  async openComposer(): Promise<void> {
    await this.composerToggle.click();
    await expect(this.composer).toBeVisible();
    // Дожидаемся конца анимации появления, чтобы замеры позиции были стабильными.
    await this.composer.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  }

  /** Состояние прокрутки ленты. */
  scrollMetrics() {
    return this.feed.evaluate((element) => ({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      remaining: element.scrollHeight - element.scrollTop - element.clientHeight,
    }));
  }

  /** Прокрутка пальцем: ConversationFeed считает скролл пользовательским только после touchmove/wheel. */
  async userScrollTo(position: number | 'bottom'): Promise<void> {
    await this.feed.evaluate((element, target) => {
      element.dispatchEvent(new Event('touchmove', { bubbles: true }));
      element.scrollTop = target === 'bottom' ? element.scrollHeight : Number(target);
      element.dispatchEvent(new Event('scroll'));
    }, position);
    // scroll-события асинхронны: даём ConversationFeed обработать новую позицию.
    await this.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
}

type Fixtures = {
  companion: CompanionMock;
  pageErrors: string[];
};

export const test = base.extend<Fixtures>({
  pageErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (entry) => {
      if (entry.text().includes('[Vue warn]')) errors.push(`vue: ${entry.text()}`);
    });
    await use(errors);
  }, { auto: true }],

  companion: async ({ page, pageErrors }, use) => {
    // Подсказка установки PWA не относится к проверкам ленты и только добавляет шум сверху.
    await page.addInitScript(() => {
      try {
        if (!sessionStorage.getItem('__companionUiKeepPwaHint')) {
          localStorage.setItem('companionPwaInstallHintDismissed', '1');
        }
      } catch {
        // ignore
      }
    });
    const companion = new CompanionMock(page);
    await companion.reset();
    await use(companion);
    expect(pageErrors, 'страница не должна бросать исключения и Vue warnings').toEqual([]);
  },
});

/** Синтетический PNG без внешних зависимостей. noise=true даёт почти несжимаемый файл. */
export function makePng(width: number, height: number, options: { noise?: boolean; seed?: number } = {}): Buffer {
  const rowBytes = width * 3 + 1;
  const raw = Buffer.alloc(rowBytes * height);
  let state = options.seed ?? 42;
  for (let y = 0; y < height; y += 1) {
    raw[y * rowBytes] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = y * rowBytes + 1 + x * 3;
      if (options.noise) {
        state = (state * 1_103_515_245 + 12_345) >>> 0;
        raw[offset] = state & 0xff;
        raw[offset + 1] = (state >>> 8) & 0xff;
        raw[offset + 2] = (state >>> 16) & 0xff;
      } else {
        raw[offset] = (x * 255) / width;
        raw[offset + 1] = (y * 255) / height;
        raw[offset + 2] = 160;
      }
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: options.noise ? 0 : 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 24x16, сгенерированы canvas.toBlob в Chromium.
export const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAQABgDASIAAhEBAxEB/8QAFwABAQEBAAAAAAAAAAAAAAAAAAQDBf/EACIQAAECBAcBAAAAAAAAAAAAABEAEgQFExQBAgMhI0JhUf/EABUBAQEAAAAAAAAAAAAAAAAAAAUG/8QAKBEAAAEKBQUAAAAAAAAAAAAAAAECBBESFSIxM1ETFBYhMjRBUmHB/9oADAMBAAIRAxEAPwDeVy+/q8tNg6kk++KiOk9rC59au9o2YCcR9U8rmFhV4qjx2AB89VEdOLqFz6NBjhu8gYn4mE3Uj5JlulaMXT4wtziv7t2B6O6HeXFrqO8p7syht9HIREVwJwf/2Q==',
  'base64',
);

export const TINY_WEBP = Buffer.from(
  'UklGRoICAABXRUJQVlA4WAoAAAAgAAAAFwAADwAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDgglAAAAFAGAJ0BKhgAEAA+bSqSRaQioZgEAEAGxLYATplBXgTAB/QPsAvoD+AegB1gHkb/qb8AHkZgPiTcWAAAAPnWiG6QtfY6uJTRt/a/6Obc9OzkuGXWv88N83sKHjUfnf9IJOYfZaPQxPqVK8824KouEv3saZvRqnXyhctDC0qal959LJvvLRf4KXJ5DlFMTfD/aH6HgAA=',
  'base64',
);
