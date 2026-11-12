import { afterEach, expect, it, vi } from 'vitest';
import { createApp, nextTick } from 'vue';
import CompanionApp from './CompanionApp.vue';

// Exercise the actual mobile component and transport lifecycle without a
// heavyweight browser runner. Only its visual feed child is replaced.
vi.mock('@/presentation/components/ConversationFeed.vue', () => ({
  default: {
    props: ['messages'],
    template: '<div class="test-feed"><span v-for="message in messages" :key="message.id">{{ message.text }}</span></div>',
  },
}));

class TestEventSource {
  static instances: TestEventSource[] = [];
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private listeners = new Map<string, ((event: MessageEvent) => void)[]>();

  constructor(readonly url: string) {
    TestEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emitSnapshot(snapshot: unknown): void {
    const event = { data: JSON.stringify(snapshot) } as MessageEvent;
    for (const listener of this.listeners.get('snapshot') ?? []) listener(event);
  }

  close(): void {
    this.closed = true;
  }
}

function snapshot(revision: number, text = '') {
  return {
    revision: String(revision),
    data: {
      authRequired: false,
      recording: { status: 'Idle', activeSessionId: 0 },
      microphone: { appMuted: false, enabled: true },
      controls: {
        instanceId: 'mobile-test-server',
        companionModeEnabled: true,
        historyFloorSeq: 0,
        contextFloorSeq: 0,
        conversationGeneration: 1,
        desktopBlackoutEnabled: false,
      },
      live: {},
      timeline: text
        ? [{ id: 'stt:1:1', seq: 1, kind: 'stt', role: 'incoming', status: 'final', text, createdAtMs: 1234 }]
        : [],
    },
  };
}

const originalUrl = window.location.pathname + window.location.search + window.location.hash;
let mountedApp: ReturnType<typeof createApp> | null = null;
let mountPoint: HTMLElement | null = null;

async function flushUi() {
  // The actual component crosses fetch → requestJson → resync → bootstrap
  // async boundaries before Vue updates the DOM.
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
  await nextTick();
}

afterEach(() => {
  mountedApp?.unmount();
  mountPoint?.remove();
  mountedApp = null;
  mountPoint = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  TestEventSource.instances.length = 0;
  Reflect.deleteProperty(document, 'visibilityState');
  window.history.replaceState({}, '', originalUrl || '/');
});

it('CompanionApp retries its initial GET and restores SSE after disconnect without page reload', async () => {
  vi.useFakeTimers();
  window.history.replaceState({}, '', '/companion.html?token=mobile-test-token');
  vi.stubGlobal('EventSource', TestEventSource);
  let stateRequests = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).startsWith('/api/state')) {
      stateRequests += 1;
      if (stateRequests === 1) throw new TypeError('Failed to fetch');
      const body = snapshot(stateRequests, stateRequests > 2 ? 'Restored from desktop' : '');
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify(body),
        json: async () => body,
      } as Response;
    }
    return {
      ok: true, status: 200,
      text: async () => '',
      json: async () => ({}),
    } as Response;
  }));

  mountPoint = document.createElement('div');
  document.body.appendChild(mountPoint);
  mountedApp = createApp(CompanionApp);
  mountedApp.mount(mountPoint);
  await flushUi();

  expect(TestEventSource.instances).toHaveLength(0);
  expect(stateRequests).toBeGreaterThanOrEqual(1); // the mocked first GET failed

  await vi.advanceTimersByTimeAsync(1500);
  await flushUi();
  expect(TestEventSource.instances).toHaveLength(1);
  const first = TestEventSource.instances[0];
  first.onopen?.(new Event('open'));
  first.onerror?.(new Event('error'));
  expect(first.closed).toBe(true);

  await vi.advanceTimersByTimeAsync(1500);
  await flushUi();
  expect(TestEventSource.instances).toHaveLength(2);
  expect(stateRequests).toBeGreaterThanOrEqual(3);

  const recovered = TestEventSource.instances[1];
  recovered.onopen?.(new Event('open'));
  recovered.emitSnapshot(snapshot(10, 'Restored from desktop'));
  await flushUi();
  expect(mountPoint.textContent).toContain('Restored from desktop');
  expect(recovered.closed).toBe(false);
});


it('keeps an ambiguous POST warning after another failed reconnect without replaying history clear', async () => {
  vi.useFakeTimers();
  window.history.replaceState({}, '', '/companion.html?token=mobile-test-token');
  vi.stubGlobal('EventSource', TestEventSource);
  let stateRequests = 0;
  let historyClearPosts = 0;
  let failNextState = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).startsWith('/api/state')) {
      stateRequests += 1;
      if (failNextState) {
        failNextState = false;
        throw new TypeError('Failed to fetch');
      }
      const body = snapshot(stateRequests);
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify(body),
        json: async () => body,
      } as Response;
    }
    if (String(url) === '/api/history/clear') {
      historyClearPosts += 1;
      throw new TypeError('Failed to fetch'); // The desktop may still have cleared history.
    }
    return {
      ok: true, status: 200,
      text: async () => '',
      json: async () => ({}),
    } as Response;
  }));

  mountPoint = document.createElement('div');
  document.body.appendChild(mountPoint);
  mountedApp = createApp(CompanionApp);
  mountedApp.mount(mountPoint);
  await flushUi();

  const clearHistory = mountPoint.querySelector<HTMLButtonElement>('button[title="Очистить историю"]');
  expect(clearHistory?.disabled).toBe(false);
  const initialStateRequests = stateRequests;
  failNextState = true;
  clearHistory?.click();
  await flushUi();
  expect(historyClearPosts).toBe(1);
  expect(mountPoint.textContent).toContain('Не удалось подтвердить отправку');

  await vi.advanceTimersByTimeAsync(1500);
  await flushUi();
  expect(stateRequests).toBeGreaterThan(initialStateRequests);
  expect(mountPoint.textContent).toContain('Не удалось подтвердить отправку');

  await vi.advanceTimersByTimeAsync(3000);
  await flushUi();
  expect(mountPoint.textContent).toContain('Не удалось подтвердить отправку');
  expect(historyClearPosts).toBe(1);
});


it('warns when backgrounding aborts a non-idempotent POST with an unknown desktop result', async () => {
  vi.useFakeTimers();
  window.history.replaceState({}, '', '/companion.html?token=mobile-test-token');
  vi.stubGlobal('EventSource', TestEventSource);
  let visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });

  let historyClearPosts = 0;
  let abortedPosts = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).startsWith('/api/state')) {
      const body = snapshot(2);
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify(body),
        json: async () => body,
      } as Response;
    }
    if (String(url) === '/api/history/clear') {
      historyClearPosts += 1;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error('POST missing abort signal'));
        signal.addEventListener('abort', () => {
          abortedPosts += 1;
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
    }
    return {
      ok: true, status: 200,
      text: async () => '',
      json: async () => ({}),
    } as Response;
  }));

  mountPoint = document.createElement('div');
  document.body.appendChild(mountPoint);
  mountedApp = createApp(CompanionApp);
  mountedApp.mount(mountPoint);
  await flushUi();

  const clearHistory = mountPoint.querySelector<HTMLButtonElement>('button[title="Очистить историю"]');
  expect(clearHistory?.disabled).toBe(false);
  clearHistory?.click();
  await flushUi();
  expect(historyClearPosts).toBe(1);

  visibility = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  await flushUi();
  expect(abortedPosts).toBe(1);
  expect(mountPoint.textContent).toContain('Не удалось подтвердить отправку');

  visibility = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  await flushUi();
  expect(mountPoint.textContent).toContain('Не удалось подтвердить отправку');
  expect(historyClearPosts).toBe(1);
});
