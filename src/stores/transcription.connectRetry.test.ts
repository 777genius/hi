import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useTranscriptionStore } from './transcription';

const invokeMock = vi.fn();
const listenMock = vi.fn();

const tokenRepoMock = vi.hoisted(() => ({
  get: vi.fn(),
  clear: vi.fn(),
}));

const authStoreMock = vi.hoisted(() => ({
  isAuthenticated: true,
  session: { user: { id: 'u1' } },
  accessToken: 'access_old',
  reset: vi.fn(),
  setAuthenticated: vi.fn(),
  setSessionExpired: vi.fn(),
}));

const authContainerMock = vi.hoisted(() => ({
  refreshTokensUseCase: {
    execute: vi.fn(),
  },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => invokeMock(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: any[]) => listenMock(...args),
}));

vi.mock('../utils/tauri', () => ({
  isTauriAvailable: () => true,
}));

vi.mock('../features/auth/infrastructure/repositories/TokenRepository', () => ({
  getTokenRepository: () => tokenRepoMock,
}));

vi.mock('../features/auth/infrastructure/di/authContainer', () => ({
  getAuthContainer: () => authContainerMock,
}));

vi.mock('../features/auth/store/authStore', () => ({
  useAuthStore: () => authStoreMock,
}));

vi.mock('../features/auth/domain/entities/Session', () => ({
  canRefreshSession: () => true,
  isAccessTokenExpired: () => false,
}));

describe('transcription connect-retry reliability', () => {
  beforeEach(() => {
    setActivePinia(createPinia());

    invokeMock.mockReset();
    listenMock.mockReset();
    tokenRepoMock.get.mockReset();
    tokenRepoMock.clear.mockReset();
    authStoreMock.reset.mockReset();
    authStoreMock.setAuthenticated.mockReset();
    authContainerMock.refreshTokensUseCase.execute.mockReset();

    // initialize() не вызываем, но пусть listen будет безопасным.
    listenMock.mockResolvedValue(() => {});

    tokenRepoMock.get.mockResolvedValue({
      refreshToken: 'refresh',
      accessToken: 'access_old',
      refreshExpiresAt: new Date('2999-01-01'),
      accessExpiresAt: new Date('2999-01-01'),
      user: { id: 'u1' },
    });

    authContainerMock.refreshTokensUseCase.execute.mockResolvedValue({
      accessToken: 'access_new',
    });
  });

  it('не залипает на "Подключение..." при 401 даже после refresh', async () => {
    let startRecordingCalls = 0;

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'start_recording') {
        startRecordingCalls++;
        return Promise.reject(
          'Authentication error: 401 Unauthorized. Токен недействителен/истёк — попробуй перелогиниться.'
        );
      }
      // set_authenticated / show_auth_window / stop_recording и т.п.
      return Promise.resolve(null);
    });

    const store = useTranscriptionStore();

    await store.startRecording();

    expect(startRecordingCalls).toBeGreaterThanOrEqual(2);
    expect(store.isConnecting).toBe(false);
    expect(store.status).toBe('Idle');
    expect(authStoreMock.reset).toHaveBeenCalled();

    const calledShowAuth = invokeMock.mock.calls.some((c) => c[0] === 'show_auth_window');
    expect(calledShowAuth).toBe(true);
  });

  it('не помечает текущую сессию закрытой при reconcile race (Idle во время старта)', async () => {
    const handlers = new Map<string, any>();

    listenMock.mockImplementation(async (eventName: string, handler: any) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    // reconcileBackendStatus() внутри вызовет get_recording_status → вернём Idle (race)
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_recording_status') return Promise.resolve('Idle');
      return Promise.resolve(null);
    });

    const store = useTranscriptionStore();
    await store.initialize();

    const statusHandler = handlers.get('recording:status');
    expect(typeof statusHandler).toBe('function');

    // Сначала прилетел Starting с session_id=32 (мы в start flow)
    await statusHandler({ payload: { session_id: 32, status: 'Starting', stopped_via_hotkey: false } });
    expect(store.status).toBe('Starting');

    // Затем window_shown / reconcile успевает увидеть Idle (race) — НЕ должны закрыть session 32
    await store.reconcileBackendStatus('test_race');
    expect(store.status).toBe('Starting');

    // Потом прилетает Recording для той же сессии — обязаны принять и перейти в Recording
    await statusHandler({ payload: { session_id: 32, status: 'Recording', stopped_via_hotkey: false } });
    expect(store.status).toBe('Recording');
  });

  it('показывает понятную причину когда микрофон недоступен', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'start_recording') {
        return Promise.reject(
          'Internal error: Failed to start audio capture: Capture error: Failed to build audio stream: The requested device is no longer available. For example, it has been unplugged. (type: processing)'
        );
      }
      return Promise.resolve(null);
    });

    const store = useTranscriptionStore();
    await store.startRecording();

    expect(store.isConnecting).toBe(false);
    expect(store.status).toBe('Error');
    expect(store.errorType).toBe('processing');
    expect(store.error).toContain('Микрофон недоступен');
  });

  it('предлагает открыть настройки когда выбранный микрофон не найден', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'start_recording') {
        return Promise.reject(
          "Failed to start audio capture: Failed to create audio capture with device 'Old Mic': device not found"
        );
      }
      return Promise.resolve(null);
    });

    const store = useTranscriptionStore();
    await store.startRecording();

    expect(store.status).toBe('Error');
    expect(store.errorType).toBe('configuration');
    expect(store.error).toContain('Выбранный микрофон недоступен');
    expect(store.canOpenSettingsForDevice).toBe(true);
  });

  it('не показывает overlapping interim второй строкой после segment-final', async () => {
    const handlers = new Map<string, any>();
    listenMock.mockImplementation(async (eventName: string, handler: any) => {
      handlers.set(eventName, handler);
      return () => {};
    });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_recording_status') return Promise.resolve('Recording');
      return Promise.resolve(null);
    });

    const store = useTranscriptionStore();
    await store.initialize();

    const statusHandler = handlers.get('recording:status');
    const partialHandler = handlers.get('transcription:partial');
    expect(typeof statusHandler).toBe('function');
    expect(typeof partialHandler).toBe('function');

    try {
      await statusHandler({ payload: { session_id: 7, status: 'Recording', stopped_via_hotkey: false } });
      await partialHandler({
        payload: {
          session_id: 7,
          source: 'system',
          text: 'Ты слышишь, что я говорю?',
          timestamp: 1,
          is_segment_final: true,
          start: 0,
          duration: 2.1,
        },
      });
      await partialHandler({
        payload: {
          session_id: 7,
          source: 'system',
          text: 'Ты слышишь, что',
          timestamp: 2,
          is_segment_final: false,
          start: 2.1,
          duration: 0.8,
        },
      });

      expect(store.displayText).toBe('Ты слышишь, что я говорю?');
    } finally {
      store.cleanup();
    }
  });

  it('не съедает короткое повторение при live отображении', async () => {
    const handlers = new Map<string, any>();
    listenMock.mockImplementation(async (eventName: string, handler: any) => {
      handlers.set(eventName, handler);
      return () => {};
    });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_recording_status') return Promise.resolve('Recording');
      return Promise.resolve(null);
    });

    const store = useTranscriptionStore();
    await store.initialize();

    const statusHandler = handlers.get('recording:status');
    const partialHandler = handlers.get('transcription:partial');

    try {
      await statusHandler({ payload: { session_id: 8, status: 'Recording', stopped_via_hotkey: false } });
      await partialHandler({
        payload: {
          session_id: 8,
          source: 'system',
          text: 'да',
          timestamp: 1,
          is_segment_final: true,
          start: 0,
          duration: 0.4,
        },
      });
      await partialHandler({
        payload: {
          session_id: 8,
          source: 'system',
          text: 'да',
          timestamp: 2,
          is_segment_final: false,
          start: 0.4,
          duration: 0.3,
        },
      });

      expect(store.displayText).toBe('да да');
    } finally {
      store.cleanup();
    }
  });

  it('конкатенирует finalized chunks как в Deepgram docs и не съедает повтор на границе', async () => {
    const handlers = new Map<string, any>();
    listenMock.mockImplementation(async (eventName: string, handler: any) => {
      handlers.set(eventName, handler);
      return () => {};
    });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_recording_status') return Promise.resolve('Recording');
      return Promise.resolve(null);
    });

    const store = useTranscriptionStore();
    await store.initialize();

    const statusHandler = handlers.get('recording:status');
    const partialHandler = handlers.get('transcription:partial');
    const finalHandler = handlers.get('transcription:final');

    try {
      await statusHandler({ payload: { session_id: 9, status: 'Recording', stopped_via_hotkey: false } });
      await partialHandler({
        payload: {
          session_id: 9,
          source: 'system',
          text: 'my number is two two',
          timestamp: 1,
          is_segment_final: true,
          start: 0,
          duration: 3.26,
        },
      });
      await finalHandler({
        payload: {
          session_id: 9,
          source: 'system',
          text: 'two two three',
          timestamp: 2,
        },
      });

      expect(store.finalUtterances[store.finalUtterances.length - 1]?.text).toBe(
        'my number is two two two two three'
      );
      expect(store.displayText).toBe('my number is two two two two three');
    } finally {
      store.cleanup();
    }
  });

  it('не дублирует speech_final если он повторяет уже накопленный finalized range', async () => {
    const handlers = new Map<string, any>();
    listenMock.mockImplementation(async (eventName: string, handler: any) => {
      handlers.set(eventName, handler);
      return () => {};
    });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_recording_status') return Promise.resolve('Recording');
      return Promise.resolve(null);
    });

    const store = useTranscriptionStore();
    await store.initialize();

    const statusHandler = handlers.get('recording:status');
    const partialHandler = handlers.get('transcription:partial');
    const finalHandler = handlers.get('transcription:final');

    try {
      await statusHandler({ payload: { session_id: 10, status: 'Recording', stopped_via_hotkey: false } });
      await partialHandler({
        payload: {
          session_id: 10,
          source: 'system',
          text: 'hello world',
          timestamp: 1,
          is_segment_final: true,
          start: 0,
          duration: 1.5,
        },
      });
      await finalHandler({
        payload: {
          session_id: 10,
          source: 'system',
          text: 'hello world',
          timestamp: 2,
          start: 0,
          duration: 1.5,
        },
      });

      expect(store.finalUtterances[store.finalUtterances.length - 1]?.text).toBe('hello world');
    } finally {
      store.cleanup();
    }
  });
});
