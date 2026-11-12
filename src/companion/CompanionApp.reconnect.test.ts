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
  await Promise.resolve();
  await Promise.resolve();
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
  expect(mountPoint.textContent).toContain('Не удалось подключиться к компьютеру');

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
