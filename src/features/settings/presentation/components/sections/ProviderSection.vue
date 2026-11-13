<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { SttProviderType } from '@/types';
import SettingGroup from '../shared/SettingGroup.vue';
import { useSettings } from '../../composables/useSettings';

const { t } = useI18n();
const { provider } = useSettings();
const providerOptions = computed(() => [
  { value: SttProviderType.Backend, label: 'Cloud STT (current backend)' },
  { value: SttProviderType.WhisperLargeV3, label: 'Whisper Large-v3 · Local (Apple Silicon) · most accurate' },
  { value: SttProviderType.ParakeetUltra, label: 'Parakeet Ultra · Local (Apple Silicon) · fastest' },
]);
</script>

<template>
  <SettingGroup :title="t('settings.provider.label')">
    <v-select
      v-model="provider"
      :items="providerOptions"
      item-title="label"
      item-value="value"
      density="comfortable"
      hide-details
    />
    <div v-if="provider === SttProviderType.WhisperLargeV3" class="text-caption text-medium-emphasis mt-2">
      Offline recognition on Mac Apple Silicon. Most accurate for RU, EN and UK and
      uses the terms from your glossary as a vocabulary, but each phrase appears about
      1 second after you stop speaking (no live preview). Needs ~1.7 GB per audio source.
      Download once: <code>hf download handy-computer/whisper-large-v3-gguf whisper-large-v3-Q8_0.gguf</code>
      (or set HACKINTERVIEW_WHISPER_MODEL_PATH).
    </div>
    <div v-else-if="provider === SttProviderType.ParakeetUltra" class="text-caption text-medium-emphasis mt-2">
      Offline recognition on Mac Apple Silicon. Fastest: the completed phrase appears
      ~0.1 s after you stop speaking, with live preview. Less accurate on technical terms
      (add them to the glossary). Download Parakeet Ultra Q8 in Handy first (or configure
      HACKINTERVIEW_PARAKEET_MODEL_PATH). RU, EN and UK are auto-detected.
    </div>
  </SettingGroup>
</template>
