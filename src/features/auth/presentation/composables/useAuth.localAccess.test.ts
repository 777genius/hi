import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  initialize: vi.fn(),
}));

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../../../../utils/tauri', () => ({ isTauriAvailable: () => true }));
vi.mock('../../infrastructure/di/authContainer', () => ({
  getAuthContainer: () => ({ initializeAuthUseCase: { execute: mocks.initialize } }),
}));

import { useAuth } from './useAuth';
import { useAuthStore } from '../../store/authStore';

describe('local access startup', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mocks.invoke.mockReset();
    mocks.initialize.mockReset();
  });

  it('skips login and leaves the session empty only when the desktop opts in', async () => {
    mocks.invoke.mockResolvedValue({ data: { local_no_auth: true } });
    await useAuth().initialize();
    expect(useAuthStore().localAccess).toBe(true);
    expect(useAuthStore().session).toBeNull();
    expect(mocks.initialize).not.toHaveBeenCalled();
  });

  it('uses the normal login flow without the explicit flag', async () => {
    mocks.invoke.mockResolvedValue({ data: { local_no_auth: false } });
    mocks.initialize.mockResolvedValue({ isAuthenticated: false });
    await useAuth().initialize();
    expect(useAuthStore().localAccess).toBe(false);
    expect(mocks.initialize).toHaveBeenCalledOnce();
  });
});
