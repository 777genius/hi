<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import SettingGroup from '../shared/SettingGroup.vue';
import { useSettings } from '../../composables/useSettings';

const { t } = useI18n();
const { deepgramKeyterms } = useSettings();

const TOKEN_LIMIT = 500;
const TERM_LIMIT = 100;

function countKeytermsTokens(input: string): number {
  return input
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)
    .reduce((sum, term) => sum + term.split(/\s+/).length, 0);
}

function countTerms(input: string): number {
  return input.split(',').map(t => t.trim()).filter(Boolean).length;
}

const tokenCount = computed(() => countKeytermsTokens(deepgramKeyterms.value));
const termCount = computed(() => countTerms(deepgramKeyterms.value));
const isOverTokenLimit = computed(() => tokenCount.value > TOKEN_LIMIT);
const isOverTermLimit = computed(() => termCount.value > TERM_LIMIT);
const hasError = computed(() => isOverTokenLimit.value || isOverTermLimit.value);

const errorMessages = computed(() => {
  const msgs: string[] = [];
  if (isOverTermLimit.value) msgs.push(t('settings.keyterms.termLimitExceeded'));
  if (isOverTokenLimit.value) msgs.push(t('settings.keyterms.limitExceeded'));
  return msgs;
});
</script>

<template>
  <SettingGroup :title="t('settings.keyterms.label')">
    <v-textarea
      v-model="deepgramKeyterms"
      :placeholder="t('settings.keyterms.placeholder')"
      rows="2"
      auto-grow
      density="comfortable"
      variant="outlined"
      :error="hasError"
      :error-messages="errorMessages"
    />
    <div class="d-flex justify-space-between align-center mt-1">
      <span class="text-caption text-medium-emphasis">
        {{ t('settings.keyterms.hint') }}
      </span>
      <span
        class="text-caption"
        :class="hasError ? 'text-error' : 'text-medium-emphasis'"
      >
        {{ t('settings.keyterms.termCount', { count: termCount }) }}
      </span>
    </div>
  </SettingGroup>
</template>
