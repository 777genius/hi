import type { ITokenRepository, StoredSession } from '../../domain/repositories/ITokenRepository';
import type { Session } from '../../domain/entities/Session';
import { createSession } from '../../domain/entities/Session';
import { createUser } from '../../domain/entities/User';

const STORAGE_KEY = 'auth_session';
const DEVICE_ID_KEY = 'device_id';

// Флаг для определения Tauri окружения
const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

const CMD_GET_AUTH_SESSION_SNAPSHOT = 'get_auth_session_snapshot';
const CMD_SET_AUTH_SESSION = 'set_auth_session';

type AuthSessionSnapshot = {
  revision: string;
  data: {
    device_id: string;
    session: null | {
      access_token: string;
      refresh_token: string | null;
      access_expires_at: string;
      refresh_expires_at: string | null;
      user: null | { id: string; email: string; email_verified: boolean };
    };
  };
};

async function readAuthSessionFromRust(): Promise<AuthSessionSnapshot | null> {
  if (!isTauri) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return (await invoke(CMD_GET_AUTH_SESSION_SNAPSHOT)) as AuthSessionSnapshot;
  } catch (e) {
    console.warn('[Auth] Failed to read auth session snapshot from Rust:', e);
    return null;
  }
}

async function writeAuthSessionToRust(session: StoredSession | null): Promise<void> {
  if (!isTauri) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    if (!session) {
      await invoke(CMD_SET_AUTH_SESSION, { session: null });
      return;
    }

    await invoke(CMD_SET_AUTH_SESSION, {
      session: {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        accessExpiresAt: session.accessExpiresAt,
        refreshExpiresAt: session.refreshExpiresAt,
        deviceId: session.deviceId,
        user: session.user
          ? {
              id: session.user.id,
              email: session.user.email,
              emailVerified: session.user.emailVerified,
            }
          : null,
      },
    });
  } catch (e) {
    console.warn('[Auth] Failed to write auth session to Rust:', e);
  }
}

/**
 * Реализация репозитория токенов
 * В Tauri: Rust является source-of-truth (persist + background refresh + sync between windows).
 * Для браузера/тестов: localStorage fallback.
 */
export class TokenRepository implements ITokenRepository {
  async save(session: Session): Promise<void> {
    let deviceId = session.deviceId;

    const data: StoredSession = {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      accessExpiresAt: session.accessExpiresAt.toISOString(),
      refreshExpiresAt: session.refreshExpiresAt?.toISOString(),
      deviceId: deviceId,
      user: session.user
        ? {
            id: session.user.id,
            email: session.user.email,
            emailVerified: session.user.emailVerified,
          }
        : undefined,
    };

    // Всегда обновляем localStorage как fallback (для тестов/preview) и как быстрый кеш.
    if (!deviceId) {
      deviceId = localStorage.getItem(DEVICE_ID_KEY) || `desktop-${crypto.randomUUID()}`;
      localStorage.setItem(DEVICE_ID_KEY, deviceId);
      data.deviceId = deviceId;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

    // В Tauri — пишем в Rust SoT (best-effort).
    await writeAuthSessionToRust(data);

    // Не делаем лишний snapshot-read здесь: стабильный device_id уже должен быть
    // проставлен в доменной сессии (server-bound) и сохранён в Rust SoT.
  }

  async get(): Promise<Session | null> {
    // В Tauri сначала читаем Rust SoT (device_id + session).
    if (isTauri) {
      const snap = await readAuthSessionFromRust();
      // A failed IPC read is not proof of logout. Preserve the local fallback
      // until the Rust source-of-truth can be reached again.
      if (snap !== null) {
      if (snap?.data?.device_id) {
        localStorage.setItem(DEVICE_ID_KEY, snap.data.device_id);
      }

      const s = snap?.data?.session;
      if (!s) {
        // Если в Rust сессии нет — чистим локальный кеш.
        localStorage.removeItem(STORAGE_KEY);
        return null;
      }

      const storedFromRust: StoredSession = {
        accessToken: s.access_token,
        refreshToken: s.refresh_token ?? undefined,
        accessExpiresAt: s.access_expires_at,
        refreshExpiresAt: s.refresh_expires_at ?? undefined,
        deviceId: snap.data.device_id,
        user: s.user
          ? {
              id: s.user.id,
              email: s.user.email,
              emailVerified: s.user.email_verified,
            }
          : undefined,
      };

      // Обновляем localStorage кеш.
      localStorage.setItem(STORAGE_KEY, JSON.stringify(storedFromRust));

      return createSession({
        accessToken: storedFromRust.accessToken,
        refreshToken: storedFromRust.refreshToken,
        accessExpiresAt: new Date(storedFromRust.accessExpiresAt),
        refreshExpiresAt: storedFromRust.refreshExpiresAt
          ? new Date(storedFromRust.refreshExpiresAt)
          : undefined,
        deviceId: storedFromRust.deviceId,
        user: storedFromRust.user
          ? createUser({
              id: storedFromRust.user.id,
              email: storedFromRust.user.email,
              emailVerified: storedFromRust.user.emailVerified,
            })
          : undefined,
      });
      }
    }

    // Browser/test fallback (also used after a temporary Tauri IPC failure)
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    let stored: StoredSession | null = null;
    try {
      stored = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!stored) return null;

    try {
      return createSession({
        accessToken: stored.accessToken,
        refreshToken: stored.refreshToken,
        accessExpiresAt: new Date(stored.accessExpiresAt),
        refreshExpiresAt: stored.refreshExpiresAt
          ? new Date(stored.refreshExpiresAt)
          : undefined,
        deviceId: stored.deviceId,
        user: stored.user
          ? createUser({
              id: stored.user.id,
              email: stored.user.email,
              emailVerified: stored.user.emailVerified,
            })
          : undefined,
      });
    } catch {
      return null;
    }
  }

  async clear(): Promise<void> {
    localStorage.removeItem(STORAGE_KEY);
    if (isTauri) {
      await writeAuthSessionToRust(null);
    }
  }

  getDeviceId(): string {
    // Важно: интерфейс sync. В Tauri реальный source-of-truth — Rust, но
    // здесь возвращаем localStorage кеш. Он будет синхронизирован при `get()`/`save()`.
    let deviceId = localStorage.getItem(DEVICE_ID_KEY);
    if (!deviceId) {
      deviceId = `desktop-${crypto.randomUUID()}`;
      localStorage.setItem(DEVICE_ID_KEY, deviceId);
    }
    return deviceId;
  }
}

// Singleton для использования в apiClient и DI контейнере
let tokenRepositoryInstance: TokenRepository | null = null;

export function getTokenRepository(): TokenRepository {
  if (!tokenRepositoryInstance) {
    tokenRepositoryInstance = new TokenRepository();
  }
  return tokenRepositoryInstance;
}

// Для тестов
export function resetTokenRepository(): void {
  tokenRepositoryInstance = null;
}
