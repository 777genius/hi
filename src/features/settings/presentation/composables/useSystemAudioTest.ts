/**
 * Composable для тестирования захвата системного звука (output/loopback).
 */

import { ref, onUnmounted } from 'vue';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { tauriSettingsService } from '../../infrastructure/adapters/TauriSettingsService';

export function useSystemAudioTest() {
  const isTesting = ref(false);
  const audioLevel = ref(0);
  const error = ref<string | null>(null);

  let levelUnlisten: UnlistenFn | null = null;

  async function start(deviceName: string | null): Promise<void> {
    try {
      error.value = null;
      audioLevel.value = 0;

      levelUnlisten = await tauriSettingsService.listenSystemAudioLevel((level) => {
        audioLevel.value = level;
      });

      await tauriSettingsService.startSystemAudioTest(deviceName);
      isTesting.value = true;
    } catch (err) {
      console.error('Ошибка запуска теста системного звука:', err);
      error.value = String(err);
      cleanup();
    }
  }

  async function stop(): Promise<number[]> {
    try {
      const audioSamples = await tauriSettingsService.stopSystemAudioTest();
      isTesting.value = false;
      audioLevel.value = 0;
      cleanup();
      return audioSamples;
    } catch (err) {
      console.error('Ошибка остановки теста системного звука:', err);
      error.value = String(err);
      isTesting.value = false;
      cleanup();
      return [];
    }
  }

  function playAudio(samples: number[]): void {
    if (!samples.length) return;

    const sampleRate = 16000;
    const audioContext = new AudioContext({ sampleRate });
    const buffer = audioContext.createBuffer(1, samples.length, sampleRate);

    const channelData = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) {
      channelData[i] = samples[i] / 32767.0;
    }

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.start();
  }

  function cleanup(): void {
    if (levelUnlisten) {
      levelUnlisten();
      levelUnlisten = null;
    }
  }

  onUnmounted(() => {
    cleanup();
  });

  return {
    isTesting,
    audioLevel,
    error,
    start,
    stop,
    playAudio,
    cleanup,
  };
}

