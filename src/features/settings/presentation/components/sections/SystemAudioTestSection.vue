<script setup lang="ts">
/**
 * Секция теста системного звука (output/loopback) с визуализацией уровня
 */

import { useI18n } from 'vue-i18n';
import { useSettings } from '../../composables/useSettings';
import { useSystemAudioTest } from '../../composables/useSystemAudioTest';
import AudioVisualizer from '../../../../../presentation/components/AudioVisualizer.vue';
import { SystemTestAudioSource } from '../../composables/useSystemTestAudioSource';

const systemTestSource = new SystemTestAudioSource();

const { t } = useI18n();
const { selectedOutputAudioDevice } = useSettings();
const { isTesting, audioLevel, error, start, stop, playAudio } = useSystemAudioTest();

async function handleStart() {
  await start(selectedOutputAudioDevice.value || null);
}

async function handleStop() {
  const samples = await stop();
  if (samples.length > 0) {
    playAudio(samples);
  }
}
</script>

<template>
  <v-card class="system-test-card" variant="tonal" rounded="lg">
    <AudioVisualizer :active="isTesting" :source="systemTestSource" />
    <v-card-text class="system-test-content pa-4">
      <div class="system-test-title text-body-1 font-weight-medium mb-2">
        {{ t('settings.systemTest.label') }}
      </div>

      <div class="text-caption text-medium-emphasis mb-3">
        <p class="mb-1">{{ t('settings.systemTest.hintLine1') }}</p>
        <p class="mb-0">{{ t('settings.systemTest.hintLine2') }}</p>
      </div>

      <div class="d-flex flex-column ga-3">
        <v-btn
          v-if="!isTesting"
          color="primary"
          variant="flat"
          class="align-self-start"
          @click="handleStart"
        >
          <v-icon start>mdi-volume-high</v-icon>
          {{ t('settings.systemTest.start') }}
        </v-btn>

        <v-btn
          v-else
          color="error"
          variant="flat"
          class="align-self-start system-test-btn--recording"
          @click="handleStop"
        >
          <v-icon start>mdi-stop</v-icon>
          {{ t('settings.systemTest.stop') }}
        </v-btn>

        <div v-if="isTesting" class="audio-level">
          <div class="text-caption text-medium-emphasis mb-1">
            {{ t('settings.systemTest.audioLevel') }}
          </div>
          <v-progress-linear
            :model-value="audioLevel * 100"
            height="24"
            rounded
            :color="audioLevel > 0.7 ? 'error' : audioLevel > 0.4 ? 'warning' : 'success'"
          />
        </div>

        <v-alert
          v-if="error"
          type="error"
          variant="tonal"
          density="compact"
        >
          {{ error }}
        </v-alert>
      </div>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.system-test-card {
  margin-bottom: var(--spacing-xl);
  border: 1px solid rgba(var(--v-theme-on-surface), 0.12);
  position: relative;
  overflow: hidden;
}

.system-test-content {
  position: relative;
  z-index: 1;
}

.system-test-btn--recording {
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.8;
  }
}
</style>

