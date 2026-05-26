<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import SettingGroup from '../shared/SettingGroup.vue';
import { useSettings } from '../../composables/useSettings';
import type { AnswerAudience, AnswerImperfectionLevel, AnswerLanguage } from '../../../domain/types';

const { t } = useI18n();
const {
  answerLanguage,
  answerAudience,
  naturalAnswerStyleEnabled,
  answerImperfectionLevel,
} = useSettings();

const languageOptions = computed<Array<{ value: AnswerLanguage; label: string }>>(() => [
  { value: 'en', label: t('settings.answerStyle.languageEnglish') },
  { value: 'ru', label: t('settings.answerStyle.languageRussian') },
  { value: 'auto', label: t('settings.answerStyle.languageAuto') },
]);

const imperfectionOptions = computed<Array<{ value: AnswerImperfectionLevel; label: string }>>(() => [
  { value: 'light', label: t('settings.answerStyle.imperfectionLight') },
  { value: 'off', label: t('settings.answerStyle.imperfectionOff') },
]);

const audienceOptions = computed<Array<{ value: AnswerAudience; label: string }>>(() => [
  { value: 'internal', label: t('settings.answerStyle.audienceInternal') },
  { value: 'client', label: t('settings.answerStyle.audienceClient') },
  { value: 'auto', label: t('settings.answerStyle.audienceAuto') },
]);
</script>

<template>
  <SettingGroup :title="t('settings.answerStyle.label')">
    <v-switch
      v-model="naturalAnswerStyleEnabled"
      color="primary"
      density="comfortable"
      hide-details
      inset
      :label="naturalAnswerStyleEnabled ? t('settings.answerStyle.enabled') : t('settings.answerStyle.disabled')"
    />

    <div class="settings-answer-grid mt-3">
      <v-select
        v-model="answerLanguage"
        :items="languageOptions"
        item-title="label"
        item-value="value"
        density="comfortable"
        hide-details
        :label="t('settings.answerStyle.languageLabel')"
      />

      <v-select
        v-model="answerAudience"
        :items="audienceOptions"
        item-title="label"
        item-value="value"
        density="comfortable"
        hide-details
        :disabled="!naturalAnswerStyleEnabled"
        :label="t('settings.answerStyle.audienceLabel')"
      />

      <v-select
        v-model="answerImperfectionLevel"
        :items="imperfectionOptions"
        item-title="label"
        item-value="value"
        density="comfortable"
        hide-details
        :disabled="!naturalAnswerStyleEnabled"
        :label="t('settings.answerStyle.imperfectionLabel')"
      />
    </div>

    <div class="text-caption text-medium-emphasis mt-2">
      {{ t('settings.answerStyle.hint') }}
    </div>
  </SettingGroup>
</template>

<style scoped>
.settings-answer-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--spacing-md);
}

@media (min-width: 600px) {
  .settings-answer-grid {
    grid-template-columns: 1fr 1fr;
  }
}

@media (min-width: 960px) {
  .settings-answer-grid {
    grid-template-columns: 1fr 1fr 1fr;
  }
}
</style>
