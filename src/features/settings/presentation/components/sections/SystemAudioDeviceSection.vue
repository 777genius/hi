<script setup lang="ts">
/**
 * Секция выбора источника системного звука (output device)
 */

import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import SettingGroup from '../shared/SettingGroup.vue';
import { useSettings } from '../../composables/useSettings';
import type { AudioDeviceOption } from '../../../domain/types';

const { t } = useI18n();
const { selectedOutputAudioDevice, availableOutputAudioDevices } = useSettings();

const deviceOptions = computed<AudioDeviceOption[]>(() => {
  const devices = availableOutputAudioDevices.value || [];
  return [
    { value: '', label: t('settings.systemDevice.default') },
    ...devices.map((name: string) => ({
      value: name,
      label: name,
    })),
  ];
});
</script>

<template>
  <SettingGroup
    :title="t('settings.systemDevice.label')"
    :hint="t('settings.systemDevice.hint')"
  >
    <v-select
      v-model="selectedOutputAudioDevice"
      :items="deviceOptions"
      item-title="label"
      item-value="value"
      density="comfortable"
      hide-details
      prepend-inner-icon="mdi-volume-high"
    />
  </SettingGroup>
</template>

