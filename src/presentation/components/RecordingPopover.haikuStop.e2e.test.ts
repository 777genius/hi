import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, reactive } from 'vue';
import { createPinia, setActivePinia } from 'pinia';

import { i18n } from '@/i18n';
import { useChatStore } from '@/stores/chat';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  authInitialize: vi.fn(),
  transcription: { current: null as any },
  listeners: {} as Record<string, Array<(event: { payload: any }) => void>>,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mocks.invoke(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: any[]) => mocks.listen(...args),
}));

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: () => Promise.resolve('0.1.0-e2e'),
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({
    hide: vi.fn(),
    startDragging: vi.fn(),
  }),
}));

vi.mock('../../utils/tauri', () => ({
  isTauriAvailable: () => true,
}));

vi.mock('../../utils/sound', () => ({
  playShowSound: vi.fn(),
  playDoneSound: vi.fn(),
  preloadUiSounds: vi.fn(),
}));

vi.mock('../../stores/transcription', () => ({
  useTranscriptionStore: () => mocks.transcription.current,
}));

vi.mock('../../features/auth', () => ({
  useAuth: () => ({
    initialize: mocks.authInitialize,
  }),
}));

vi.mock('qrcode', () => ({
  toDataURL: () => Promise.resolve('data:image/png;base64,e2e'),
}));

vi.mock('../../features/settings', () => ({
  SettingsPanel: { name: 'SettingsPanelStub', render: () => null },
}));

vi.mock('./ProfilePopover.vue', () => ({
  default: { name: 'ProfilePopoverStub', render: () => null },
}));

vi.mock('./UpdateIndicator.vue', () => ({
  default: { name: 'UpdateIndicatorStub', render: () => null },
}));

vi.mock('./UpdateDialog.vue', () => ({
  default: { name: 'UpdateDialogStub', render: () => null },
}));

vi.mock('./AudioVisualizer.vue', () => ({
  default: { name: 'AudioVisualizerStub', render: () => null },
}));

vi.mock('./ConversationFeed.vue', () => ({
  default: {
    name: 'ConversationFeedStub',
    setup(_: unknown, { expose }: { expose: (value: Record<string, unknown>) => void }) {
      expose({ scrollEl: null });
      return () => null;
    },
  },
}));

function companionSnapshot(timeline: any[] = []) {
  return {
    revision: '1',
    data: {
      authRequired: false,
      recording: {
        status: 'Idle',
        activeSessionId: 1,
      },
      microphone: {
        muted: false,
        enabled: true,
        supported: true,
        source: 'combined',
        systemMuted: false,
        systemSupported: true,
        systemSource: 'combined',
        appMuted: false,
        appEnabled: true,
      },
      controls: {
        historyFloorSeq: 0,
        contextFloorSeq: 0,
        conversationGeneration: 1,
        companionModeEnabled: false,
        desktopBlackoutEnabled: false,
        lastAction: null,
      },
      live: {},
      timeline,
    },
  };
}

function createTranscriptionStoreMock() {
  return reactive({
    finalUtterances: [
      {
        id: 'stt:e2e:1',
        sessionId: 1,
        text: 'Расскажи про event loop в JavaScript',
        timestamp: 1,
      },
    ],
    accumulatedText: '',
    partialText: '',
    displayText: '',
    error: '',
    wantsLicenseActivation: false,
    status: 'Idle',
    connectionQuality: 'Good',
    isRecording: false,
    isStarting: false,
    isProcessing: false,
    isConnecting: false,
    isIdle: true,
    hasError: false,
    hasConnectionIssue: false,
    canReconnect: false,
    canActivateLicense: false,
    canOpenSettingsForDevice: false,
    initialize: vi.fn(),
    cleanup: vi.fn(),
    clearText: vi.fn(),
    hydrateFromCompanionSnapshot: vi.fn(),
    reconcileBackendStatus: vi.fn(() => Promise.resolve('Idle')),
    startRecording: vi.fn(),
    toggleRecording: vi.fn(),
    reconnect: vi.fn(),
  });
}

async function flushUi(): Promise<void> {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

async function waitFor<T>(assertion: () => T | Promise<T>, timeoutMs = 2000): Promise<T> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await assertion();
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 20));
      await flushUi();
    }
  }
  throw lastError;
}

function dispatchHover(el: Element): void {
  el.dispatchEvent(new Event('pointerenter', { bubbles: false }));
  el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
}

function dispatchLeave(el: Element): void {
  el.dispatchEvent(new Event('pointerleave', { bubbles: false }));
  el.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
}

function emitTauriEvent(eventName: string, payload: any): void {
  for (const listener of mocks.listeners[eventName] ?? []) {
    listener({ payload });
  }
}

function vuetifySlotStub(name: string) {
  return {
    name,
    setup(_: unknown, { slots }: { slots: Record<string, ((props?: unknown) => any) | undefined> }) {
      return () => {
        const children = [
          ...(slots.activator?.({ props: {} }) ?? []),
          ...(slots.default?.() ?? []),
        ];
        return h('div', children);
      };
    },
  };
}

function registerVuetifyStubs(appInstance: ReturnType<typeof createApp>): void {
  for (const name of [
    'v-tooltip',
    'v-menu',
    'v-dialog',
    'v-card',
    'v-card-title',
    'v-card-text',
    'v-card-actions',
    'v-divider',
    'v-btn',
    'v-textarea',
  ]) {
    appInstance.component(name, vuetifySlotStub(name));
  }
  appInstance.directive('ripple', {});
}

describe('RecordingPopover Haiku stop hover e2e', () => {
  let host: HTMLElement;
  let app: ReturnType<typeof createApp> | null;
  let requestSeq: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.listeners = {};
    requestSeq = 0;

    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    window.matchMedia ??= vi.fn(() => ({
      matches: false,
      media: '',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as any;
    window.requestAnimationFrame ??= ((cb: FrameRequestCallback) => window.setTimeout(() => cb(Date.now()), 0)) as any;
    window.cancelAnimationFrame ??= ((id: number) => window.clearTimeout(id)) as any;

    mocks.transcription.current = createTranscriptionStoreMock();
    mocks.listen.mockImplementation((eventName: string, callback: (event: { payload: any }) => void) => {
      mocks.listeners[eventName] ??= [];
      mocks.listeners[eventName].push(callback);
      return Promise.resolve(() => {
        mocks.listeners[eventName] = (mocks.listeners[eventName] ?? []).filter((item) => item !== callback);
      });
    });
    mocks.invoke.mockImplementation((commandName: string) => {
      if (commandName === 'start_haiku_stream') {
        requestSeq += 1;
        return Promise.resolve(`haiku:e2e:${requestSeq}`);
      }
      if (commandName === 'cancel_haiku_streams') {
        return Promise.resolve({
          ok: true,
          actionResult: 'cancelled',
          snapshot: companionSnapshot([]),
        });
      }
      if (commandName === 'get_companion_snapshot') {
        return Promise.resolve(companionSnapshot([]));
      }
      if (commandName === 'get_companion_server_status') {
        return Promise.resolve({
          enabled: false,
          port: null,
          token: null,
          localUrl: null,
          localNetworkUrl: null,
        });
      }
      if (commandName === 'get_audio_permission_status') {
        return Promise.resolve({
          system_audio_granted: true,
          microphone_granted: true,
        });
      }
      if (commandName === 'get_microphone_mute_state') {
        return Promise.resolve({
          muted: false,
          supported: true,
          source: 'e2e',
        });
      }
      if (commandName === 'check_focus_copy_helper_accessibility') {
        return Promise.resolve(true);
      }
      if (commandName === 'get_focus_copy_helper_info') {
        return Promise.resolve(null);
      }
      if (commandName === 'get_app_config_snapshot') {
        return Promise.resolve({
          revision: '1',
          data: {
            microphone_sensitivity: 95,
            recording_hotkey: 'CmdOrCtrl+Shift+X',
            auto_copy_to_clipboard: false,
            auto_paste_text: false,
            selected_audio_device: null,
            selected_output_audio_device: null,
            interview_memory_enabled: true,
            answer_language: 'ru',
            answer_audience: 'internal',
            natural_answer_style_enabled: false,
            answer_imperfection_level: 'off',
          },
        });
      }
      if (commandName === 'get_stt_config_snapshot') {
        return Promise.resolve({
          revision: '1',
          data: {
            provider: 'backend',
            language: 'ru',
            auto_detect_language: false,
            enable_punctuation: true,
            filter_profanity: false,
            deepgram_api_key: null,
            assemblyai_api_key: null,
            model: null,
            keep_connection_alive: false,
            deepgram_keyterms: null,
          },
        });
      }
      return Promise.resolve(null);
    });

    const pinia = createPinia();
    setActivePinia(pinia);
    host = document.createElement('div');
    document.body.appendChild(host);
    const { default: RecordingPopover } = await import('./RecordingPopover.vue');
    app = createApp(RecordingPopover);
    app.use(pinia);
    app.use(i18n);
    registerVuetifyStubs(app);
  });

  afterEach(() => {
    app?.unmount();
    app = null;
    document.body.innerHTML = '';
    delete (window as any).__TAURI_INTERNALS__;
  });

  it('stops an active AI answer when the loading button is clicked again', async () => {
    app?.mount(host);
    await flushUi();
    await waitFor(() => {
      expect(mocks.invoke.mock.calls.some((call) => call[0] === 'get_companion_snapshot')).toBe(true);
      expect(mocks.invoke.mock.calls.some((call) => call[0] === 'get_companion_server_status')).toBe(true);
    });

    const chatStore = useChatStore();
    const generateButton = await waitFor(() => {
      const el = document.querySelector('[data-testid="haiku-generate-button"]');
      expect(el).toBeTruthy();
      expect((el as HTMLButtonElement).disabled).toBe(false);
      return el as HTMLButtonElement;
    });

    dispatchHover(generateButton);

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith(
        'start_haiku_stream',
        expect.objectContaining({
          text: 'ОС: Расскажи про event loop в JavaScript',
        })
      );
      expect(chatStore.isHaikuStreaming).toBe(true);
      expect(document.querySelector('.haiku-spinner')).toBeTruthy();
    });

    // Клик сразу после наведения игнорируется (защита от случайной отмены), ждём.
    await new Promise((resolve) => setTimeout(resolve, 350));
    generateButton.click();
    generateButton.click();

    await waitFor(() => {
      const cancelCalls = mocks.invoke.mock.calls.filter((call) => call[0] === 'cancel_haiku_streams');
      expect(cancelCalls).toHaveLength(1);
      expect(chatStore.isHaikuStreaming).toBe(false);
      expect(chatStore.haikuMessages).toHaveLength(0);
      expect(document.querySelector('.haiku-spinner')).toBeNull();
    });

    emitTauriEvent('haiku:delta', {
      request_id: 'haiku:e2e:1',
      delta: 'late text',
    });
    emitTauriEvent('haiku:done', {
      request_id: 'haiku:e2e:1',
    });
    await flushUi();

    expect(chatStore.isHaikuStreaming).toBe(false);
    expect(chatStore.haikuMessages).toHaveLength(0);

    dispatchHover(generateButton);
    await flushUi();

    const startCallsBeforeLeave = mocks.invoke.mock.calls.filter((call) => call[0] === 'start_haiku_stream');
    expect(startCallsBeforeLeave).toHaveLength(1);

    dispatchLeave(generateButton);
    dispatchHover(generateButton);

    await waitFor(() => {
      const startCalls = mocks.invoke.mock.calls.filter((call) => call[0] === 'start_haiku_stream');
      expect(startCalls).toHaveLength(2);
      expect(chatStore.isHaikuStreaming).toBe(true);
      expect(document.querySelector('.haiku-spinner')).toBeTruthy();
    });
  });

  it('keeps the partial answer text when the generation is stopped', async () => {
    // Бэкенд оставляет частичный ответ в таймлайне; снимок в этом тесте не подменяем пустым.
    const baseInvoke = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((commandName: string, ...rest: any[]) =>
      commandName === 'cancel_haiku_streams'
        ? Promise.resolve({ ok: true, actionResult: 'cancelled' })
        : baseInvoke(commandName, ...rest)
    );
    app?.mount(host);
    await flushUi();
    await waitFor(() => {
      expect(mocks.invoke.mock.calls.some((call) => call[0] === 'get_companion_snapshot')).toBe(true);
    });
    await flushUi();

    const chatStore = useChatStore();
    const generateButton = await waitFor(() => {
      const el = document.querySelector('[data-testid="haiku-generate-button"]');
      expect(el).toBeTruthy();
      return el as HTMLButtonElement;
    });
    dispatchHover(generateButton);
    await waitFor(() => expect(chatStore.isHaikuStreaming).toBe(true));

    emitTauriEvent('haiku:delta', { request_id: 'haiku:e2e:1', delta: 'Частичный ответ' });
    await flushUi();

    await new Promise((resolve) => setTimeout(resolve, 350));
    generateButton.click();

    await waitFor(() => expect(chatStore.isHaikuStreaming).toBe(false));
    expect(chatStore.haikuMessages).toHaveLength(1);
    expect(chatStore.haikuMessages[0].text).toBe('Частичный ответ');
    expect(chatStore.haikuMessages[0].status).toBe('final');

    emitTauriEvent('haiku:delta', { request_id: 'haiku:e2e:1', delta: ' поздний хвост' });
    await flushUi();
    expect(chatStore.haikuMessages[0].text).toBe('Частичный ответ');
  });
});
