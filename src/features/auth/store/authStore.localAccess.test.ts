import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useAuthStore } from './authStore';

describe('local access', () => {
  beforeEach(() => { setActivePinia(createPinia()); });

  it('opens local UI without creating an authentication session or token', () => {
    const store = useAuthStore();
    expect(store.isAuthenticated).toBe(false);
    store.setLocalAccess();
    expect(store.isAuthenticated).toBe(true);
    expect(store.localAccess).toBe(true);
    expect(store.session).toBeNull();
    expect(store.accessToken).toBeUndefined();
  });
});
