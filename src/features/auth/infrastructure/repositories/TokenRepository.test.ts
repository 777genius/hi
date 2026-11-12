import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

const cachedSession = {
  accessToken: 'cached-access',
  refreshToken: 'cached-refresh',
  accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  deviceId: 'desktop-123',
};

function setCachedSession(): void {
  localStorage.setItem('auth_session', JSON.stringify(cachedSession));
}

describe('TokenRepository Tauri IPC failure recovery', () => {
  beforeEach(() => {
    vi.resetModules();
    invokeMock.mockReset();
    localStorage.clear();
    Object.defineProperty(window, '__TAURI__', {
      configurable: true,
      value: {},
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, '__TAURI__');
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('keeps an existing session and storage intact when Rust snapshot read temporarily fails', async () => {
    setCachedSession();
    invokeMock.mockRejectedValue(new Error('temporary IPC failure'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { TokenRepository } = await import('./TokenRepository');

    const result = await new TokenRepository().get();

    expect(result?.accessToken).toBe('cached-access');
    expect(result?.refreshToken).toBe('cached-refresh');
    expect(localStorage.getItem('auth_session')).toBe(JSON.stringify(cachedSession));
    expect(warning).toHaveBeenCalled();
  });

  it('respects an explicit empty Rust session and removes the stale local cache', async () => {
    setCachedSession();
    invokeMock.mockResolvedValue({
      revision: '1',
      data: { device_id: 'desktop-123', session: null },
    });
    const { TokenRepository } = await import('./TokenRepository');

    expect(await new TokenRepository().get()).toBeNull();
    expect(localStorage.getItem('auth_session')).toBeNull();
  });

  it('uses Rust as the source of truth again after an IPC outage', async () => {
    setCachedSession();
    invokeMock
      .mockRejectedValueOnce(new Error('temporary IPC failure'))
      .mockResolvedValueOnce({
        revision: '2',
        data: {
          device_id: 'desktop-123',
          session: {
            access_token: 'new-rust-access',
            refresh_token: 'new-rust-refresh',
            access_expires_at: new Date(Date.now() + 60_000).toISOString(),
            refresh_expires_at: null,
            user: null,
          },
        },
      });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { TokenRepository } = await import('./TokenRepository');
    const repo = new TokenRepository();

    expect((await repo.get())?.accessToken).toBe('cached-access');
    expect((await repo.get())?.accessToken).toBe('new-rust-access');
    expect(JSON.parse(localStorage.getItem('auth_session') || '{}').accessToken)
      .toBe('new-rust-access');
  });

  it('returns null for a corrupt local fallback instead of throwing when IPC is offline', async () => {
    localStorage.setItem('auth_session', 'not json');
    invokeMock.mockRejectedValue(new Error('IPC offline'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { TokenRepository } = await import('./TokenRepository');

    await expect(new TokenRepository().get()).resolves.toBeNull();
  });
});
