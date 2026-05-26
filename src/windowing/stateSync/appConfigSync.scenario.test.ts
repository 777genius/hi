import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useAppConfigStore } from '@/stores/appConfig';
import {
  CMD_GET_APP_CONFIG_SNAPSHOT,
  CMD_UPDATE_APP_CONFIG,
  TOPIC_APP_CONFIG,
} from '@/windowing/stateSync';

// Это не "настоящий e2e" (без запуска Tauri), но сценарий максимально близок:
// settings → update_app_config → invalidation → main window refreshes snapshot.

const invokeMock = vi.fn();
const listenMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => invokeMock(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: any[]) => listenMock(...args),
}));

describe('scenario: app-config sync across windows (mocked tauri)', () => {
  let invalidationHandler: ((event: any) => void) | null = null;

  beforeEach(() => {
    (window as any).__TAURI__ = {};
    invalidationHandler = null;
    invokeMock.mockReset();
    listenMock.mockReset();

    listenMock.mockImplementation(async (_eventName: string, handler: any) => {
      invalidationHandler = handler;
      return () => {};
    });
  });

  it('after update_app_config, main store observes new value via state-sync invalidation', async () => {
    // Source of truth on "Rust side"
    let currentRevision = '0';
    let currentData = {
      recording_hotkey: 'CmdOrCtrl+Shift+X',
      auto_copy_to_clipboard: false,
      auto_paste_text: false,
      microphone_sensitivity: 95,
      selected_audio_device: null,
      selected_output_audio_device: null,
      interview_memory_enabled: true,
      answer_language: 'en' as const,
      answer_audience: 'internal' as const,
      natural_answer_style_enabled: true,
      answer_imperfection_level: 'light' as const,
    };

    invokeMock.mockImplementation(async (commandName: string, args?: any) => {
      if (commandName === CMD_GET_APP_CONFIG_SNAPSHOT) {
        return { revision: currentRevision, data: currentData };
      }

      if (commandName === CMD_UPDATE_APP_CONFIG) {
        // "Rust" applies change and emits invalidation
        if (typeof args?.autoCopyToClipboard === 'boolean') {
          currentData = { ...currentData, auto_copy_to_clipboard: args.autoCopyToClipboard };
        }
        if (typeof args?.interviewMemoryEnabled === 'boolean') {
          currentData = { ...currentData, interview_memory_enabled: args.interviewMemoryEnabled };
        }
        if (typeof args?.answerLanguage === 'string') {
          currentData = { ...currentData, answer_language: args.answerLanguage };
        }
        if (typeof args?.answerAudience === 'string') {
          currentData = { ...currentData, answer_audience: args.answerAudience };
        }
        if (typeof args?.naturalAnswerStyleEnabled === 'boolean') {
          currentData = {
            ...currentData,
            natural_answer_style_enabled: args.naturalAnswerStyleEnabled,
          };
        }
        if (typeof args?.answerImperfectionLevel === 'string') {
          currentData = { ...currentData, answer_imperfection_level: args.answerImperfectionLevel };
        }
        currentRevision = String(BigInt(currentRevision) + BigInt(1));

        invalidationHandler?.({
          payload: {
            topic: TOPIC_APP_CONFIG,
            revision: currentRevision,
            sourceId: 'settings',
            timestampMs: Date.now(),
          },
        });

        return null;
      }

      throw new Error(`Unexpected invoke: ${commandName}`);
    });

    // "Main window" pinia instance
    const piniaMain = createPinia();
    setActivePinia(piniaMain);
    const appConfigMain = useAppConfigStore(piniaMain);

    await appConfigMain.startSync();
    expect(appConfigMain.autoCopyToClipboard).toBe(false);
    expect(appConfigMain.interviewMemoryEnabled).toBe(true);
    expect(appConfigMain.answerLanguage).toBe('en');
    expect(appConfigMain.answerAudience).toBe('internal');

    // "Settings window" triggers a stale auto-copy update; app store keeps auto actions disabled.
    await invokeMock(CMD_UPDATE_APP_CONFIG, { autoCopyToClipboard: true });

    await vi.waitFor(() => {
      expect(appConfigMain.autoCopyToClipboard).toBe(false);
    });

    await invokeMock(CMD_UPDATE_APP_CONFIG, { interviewMemoryEnabled: false });

    await vi.waitFor(() => {
      expect(appConfigMain.interviewMemoryEnabled).toBe(false);
    });

    await invokeMock(CMD_UPDATE_APP_CONFIG, {
      answerLanguage: 'ru',
      answerAudience: 'client',
      naturalAnswerStyleEnabled: false,
      answerImperfectionLevel: 'off',
    });

    await vi.waitFor(() => {
      expect(appConfigMain.answerLanguage).toBe('ru');
      expect(appConfigMain.answerAudience).toBe('client');
      expect(appConfigMain.naturalAnswerStyleEnabled).toBe(false);
      expect(appConfigMain.answerImperfectionLevel).toBe('off');
    });
  });
});
