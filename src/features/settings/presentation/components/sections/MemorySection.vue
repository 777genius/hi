<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import SettingGroup from '../shared/SettingGroup.vue';
import { useSettings } from '../../composables/useSettings';

const { t } = useI18n();
const { interviewMemoryEnabled } = useSettings();
</script>

<template>
  <SettingGroup :title="t('settings.memory.label')">
    <v-switch
      v-model="interviewMemoryEnabled"
      color="primary"
      density="comfortable"
      hide-details
      inset
      :label="interviewMemoryEnabled ? t('settings.memory.enabled') : t('settings.memory.disabled')"
    />
    <div class="text-caption text-medium-emphasis mt-1">
      {{ t('settings.memory.hint') }}
    </div>
  </SettingGroup>
</template>
