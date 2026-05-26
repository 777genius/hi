import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { isTauriAvailable } from '@/utils/tauri';
import {
  CMD_GET_APP_CONFIG_SNAPSHOT,
  TOPIC_APP_CONFIG,
  createStoreTauriTopicSync,
} from '@/windowing/stateSync';
import type { RevisionSyncHandle } from '@/windowing/stateSync';
import type { AppConfigSnapshotData, TauriSnapshotEnvelope } from '@/windowing/stateSync';
import type { AnswerAudience, AnswerImperfectionLevel, AnswerLanguage } from '@/features/settings/domain/types';

export const useAppConfigStore = defineStore('appConfig', () => {
  const revision = ref('0');
  const isLoaded = ref(false);
  const isSyncing = ref(false);

  const recordingHotkey = ref('CmdOrCtrl+Shift+X');
  const autoCopyToClipboard = ref(false);
  const autoPasteText = ref(false);
  const microphoneSensitivity = ref(95);
  const selectedAudioDevice = ref('');
  const selectedOutputAudioDevice = ref('');
  const interviewMemoryEnabled = ref(true);
  const answerLanguage = ref<AnswerLanguage>('ru');
  const answerAudience = ref<AnswerAudience>('internal');
  const naturalAnswerStyleEnabled = ref(false);
  const answerImperfectionLevel = ref<AnswerImperfectionLevel>('off');

  let syncHandle: RevisionSyncHandle | null = null;

  function applySnapshot(data: AppConfigSnapshotData, rev: string): void {
    revision.value = rev;
    recordingHotkey.value = data.recording_hotkey ?? recordingHotkey.value;
    // Auto-copy/auto-paste intentionally stay disabled even if an old config snapshot has them enabled.
    autoCopyToClipboard.value = false;
    autoPasteText.value = false;
    microphoneSensitivity.value = data.microphone_sensitivity ?? microphoneSensitivity.value;
    selectedAudioDevice.value = data.selected_audio_device ?? '';
    selectedOutputAudioDevice.value = data.selected_output_audio_device ?? '';
    interviewMemoryEnabled.value = data.interview_memory_enabled ?? true;
    answerLanguage.value = data.answer_language ?? 'ru';
    answerAudience.value = data.answer_audience ?? 'internal';
    naturalAnswerStyleEnabled.value = data.natural_answer_style_enabled ?? false;
    answerImperfectionLevel.value = data.answer_imperfection_level ?? 'off';
    isLoaded.value = true;
  }

  async function refresh(): Promise<void> {
    if (!isTauriAvailable() || !syncHandle) return;
    await syncHandle.refresh();
  }

  async function startSync(): Promise<boolean> {
    if (!isTauriAvailable()) return false;
    // Идемпотентность: если уже запущено — считаем, что успешно.
    if (syncHandle) return true;

    const handle = createStoreTauriTopicSync<AppConfigSnapshotData>({
      topic: TOPIC_APP_CONFIG,
      commandName: CMD_GET_APP_CONFIG_SNAPSHOT,
      label: 'appConfig',
      applier: {
        apply(snapshot: TauriSnapshotEnvelope<AppConfigSnapshotData>) {
          applySnapshot(snapshot.data, snapshot.revision);
        },
      },
    });

    try {
      await handle.start();
      syncHandle = handle;
      isSyncing.value = true;
      return true;
    } catch (err) {
      handle.stop();
      console.error('[appConfig] sync start failed:', err);
      return false;
    }
  }

  function stopSync(): void {
    if (syncHandle) {
      syncHandle.stop();
      syncHandle = null;
    }
    isSyncing.value = false;
  }

  return {
    revision,
    isLoaded,
    isSyncing,
    recordingHotkey,
    autoCopyToClipboard,
    autoPasteText,
    microphoneSensitivity,
    selectedAudioDevice,
    selectedOutputAudioDevice,
    interviewMemoryEnabled,
    answerLanguage,
    answerAudience,
    naturalAnswerStyleEnabled,
    answerImperfectionLevel,

    hasSelectedAudioDevice: computed(() => Boolean(selectedAudioDevice.value)),
    hasSelectedOutputAudioDevice: computed(() => Boolean(selectedOutputAudioDevice.value)),

    refresh,
    startSync,
    stopSync,
    applySnapshot,
  };
});
