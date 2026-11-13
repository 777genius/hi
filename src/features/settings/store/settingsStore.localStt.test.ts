import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { SttProviderType } from '@/types';
import { useSettingsStore } from './settingsStore';

describe('local STT provider settings', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it('uses the established backend by default', () => {
    const store = useSettingsStore();
    expect(store.provider).toBe(SttProviderType.Backend);
    expect(store.currentState.provider).toBe(SttProviderType.Backend);
  });

  it('preserves explicit Parakeet Ultra selection and language in the saved UI draft', () => {
    const store = useSettingsStore();
    store.setProvider(SttProviderType.ParakeetUltra);
    store.setLanguage('ru', { persist: false });
    const snapshot = store.currentState;
    expect(snapshot.provider).toBe(SttProviderType.ParakeetUltra);
    expect(snapshot.language).toBe('ru');

    // Mimics opening Settings again and applying its last saved snapshot.
    setActivePinia(createPinia());
    const next = useSettingsStore();
    next.applyState(snapshot);
    expect(next.provider).toBe(SttProviderType.ParakeetUltra);
    expect(next.currentState.provider).toBe(SttProviderType.ParakeetUltra);
  });

  it('switches between local models and keeps each choice in the saved draft', () => {
    const store = useSettingsStore();
    store.setProvider(SttProviderType.WhisperLargeV3);
    expect(store.provider).toBe(SttProviderType.WhisperLargeV3);
    const snapshot = store.currentState;

    store.setProvider(SttProviderType.ParakeetUltra);
    expect(store.provider).toBe(SttProviderType.ParakeetUltra);

    setActivePinia(createPinia());
    const next = useSettingsStore();
    next.applyState(snapshot);
    expect(next.provider).toBe(SttProviderType.WhisperLargeV3);
  });

  it('switches back to backend without enabling unrelated STT providers', () => {
    const store = useSettingsStore();
    store.setProvider(SttProviderType.ParakeetUltra);
    store.setProvider(SttProviderType.Backend);
    expect(store.provider).toBe(SttProviderType.Backend);
    store.setProvider(SttProviderType.Deepgram);
    expect(store.provider).toBe(SttProviderType.Backend);
  });
});
