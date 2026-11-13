import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { isTauriAvailable } from '@/utils/tauri';

type AudioPermissionStatus = {
  system_audio_granted: boolean;
  microphone_granted: boolean;
};

export function useAudioPermissions() {
  const systemAudioGranted = ref(true);
  const microphoneGranted = ref(true);
  const lastError = ref<string | null>(null);

  let pollTimer: number | null = null;

  async function refresh(): Promise<void> {
    if (!isTauriAvailable()) return;
    try {
      const s = await invoke<AudioPermissionStatus>('get_audio_permission_status');
      systemAudioGranted.value = Boolean(s?.system_audio_granted);
      microphoneGranted.value = Boolean(s?.microphone_granted);
      lastError.value = null;
    } catch (err) {
      // Если команда недоступна/ошибка рантайма — не блокируем UX.
      lastError.value = String(err);
      systemAudioGranted.value = true;
      microphoneGranted.value = true;
    }
  }

  async function requestSystemAudioPermission(): Promise<void> {
    if (!isTauriAvailable()) return;
    try {
      await invoke<boolean>('request_system_audio_permission');
    } catch {
      // no-op
    } finally {
      await refresh();
    }
  }

  async function requestMicrophonePermission(): Promise<void> {
    if (!isTauriAvailable()) return;
    try {
      await invoke('request_microphone_permission');
    } catch {
      // no-op
    } finally {
      await refresh();
    }
  }

  const isAnyMissing = computed(() => !systemAudioGranted.value || !microphoneGranted.value);

  function startPolling(): void {
    if (pollTimer) return;
    pollTimer = window.setInterval(() => {
      void refresh();
    }, 1000);
  }

  function stopPolling(): void {
    if (!pollTimer) return;
    window.clearInterval(pollTimer);
    pollTimer = null;
  }

  onMounted(async () => {
    await refresh();
    if (!microphoneGranted.value) void requestMicrophonePermission();
    if (isAnyMissing.value) startPolling();
  });

  watch(
    () => isAnyMissing.value,
    (missing) => {
      if (missing) startPolling();
      else stopPolling();
    }
  );

  onUnmounted(() => {
    stopPolling();
  });

  return {
    systemAudioGranted,
    microphoneGranted,
    isAnyMissing,
    lastError,
    refresh,
    requestSystemAudioPermission,
    requestMicrophonePermission,
    startPolling,
    stopPolling,
  };
}

