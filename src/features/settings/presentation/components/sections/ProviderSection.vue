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
  { value: SttProviderType.ParakeetUltra, label: 'Parakeet Ultra · Local (Apple Silicon)' },
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
    <div v-if="provider === SttProviderType.ParakeetUltra" class="text-caption text-medium-emphasis mt-2">
      Offline recognition on Mac Apple Silicon. After ~700 ms of silence,
      the completed phrase is sent to the same conversation history and AI context.
      Download Parakeet Ultra Q8 in Handy first (or configure
      HACKINTERVIEW_PARAKEET_MODEL_PATH). RU, EN and UK are auto-detected.
    </div>
  </SettingGroup>
</template>
