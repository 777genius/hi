<script setup lang="ts">
/**
 * Главный компонент панели настроек
 * Объединяет все секции и управляет загрузкой/сохранением
 */

import { ref, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import UpdateDialog from '@/presentation/components/UpdateDialog.vue';
import { useSettings } from '../composables/useSettings';
import { useSettingsTheme } from '../composables/useSettingsTheme';
import { useSettingsStore } from '../../store/settingsStore';
import type { SettingsState } from '../../domain/types';
import { isTauriAvailable } from '@/utils/tauri';
import { invokeUpdateAppConfig } from '@/windowing/stateSync';

// Секции
import LanguageSection from './sections/LanguageSection.vue';
import ProviderSection from './sections/ProviderSection.vue';
import ThemeSection from './sections/ThemeSection.vue';
import HotkeySection from './sections/HotkeySection.vue';
import SystemAudioDeviceSection from './sections/SystemAudioDeviceSection.vue';
import SystemAudioTestSection from './sections/SystemAudioTestSection.vue';
import AudioDeviceSection from './sections/AudioDeviceSection.vue';
import MicTestSection from './sections/MicTestSection.vue';
import UpdatesSection from './sections/UpdatesSection.vue';
import KeytermsSection from './sections/KeytermsSection.vue';
import MemorySection from './sections/MemorySection.vue';
import AnswerStyleSection from './sections/AnswerStyleSection.vue';

const emit = defineEmits<{
  close: [];
}>();

const { t, locale } = useI18n();
const {
  loadConfig,
  saveConfig,
  isSaving,
  isLoading,
  errorMessage,
  clearError,
} = useSettings();

// Инициализация темы
const { initializeTheme } = useSettingsTheme();

// Диалог обновления
const showUpdateDialog = ref(false);
const settingsStore = useSettingsStore();

onMounted(async () => {
  initializeTheme();
  await loadConfig();
  captureBaseline();
  armLiveApply();
});

const baselineState = ref<SettingsState | null>(null);
const baselineUiLocale = ref<string>('');

const liveApplyArmed = ref(false);
let lastAppliedAudioDevice = '';
let lastAppliedOutputDevice = '';
let liveApplySeq = 0;

function snapshotSettingsState(): SettingsState {
  return {
    provider: settingsStore.provider,
    language: settingsStore.language,
    deepgramApiKey: settingsStore.deepgramApiKey,
    assemblyaiApiKey: settingsStore.assemblyaiApiKey,
    whisperModel: settingsStore.whisperModel,
    theme: settingsStore.theme,
    useSystemTheme: settingsStore.useSystemTheme,
    recordingHotkey: settingsStore.recordingHotkey,
    microphoneSensitivity: settingsStore.microphoneSensitivity,
    selectedAudioDevice: settingsStore.selectedAudioDevice,
    selectedOutputAudioDevice: settingsStore.selectedOutputAudioDevice,
    autoCopyToClipboard: settingsStore.autoCopyToClipboard,
    autoPasteText: settingsStore.autoPasteText,
    interviewMemoryEnabled: settingsStore.interviewMemoryEnabled,
    answerLanguage: settingsStore.answerLanguage,
    answerAudience: settingsStore.answerAudience,
    naturalAnswerStyleEnabled: settingsStore.naturalAnswerStyleEnabled,
    answerImperfectionLevel: settingsStore.answerImperfectionLevel,
    deepgramKeyterms: settingsStore.deepgramKeyterms,
  };
}

function captureBaseline(): void {
  baselineState.value = snapshotSettingsState();
  baselineUiLocale.value = String(locale.value ?? '');
}

function armLiveApply(): void {
  if (!isTauriAvailable()) {
    liveApplyArmed.value = false;
    return;
  }
  lastAppliedAudioDevice = settingsStore.selectedAudioDevice;
  lastAppliedOutputDevice = settingsStore.selectedOutputAudioDevice;
  liveApplyArmed.value = true;
}

async function applyAudioDevice(field: 'selectedAudioDevice' | 'selectedOutputAudioDevice', value: string): Promise<void> {
  if (!isTauriAvailable()) return;
  const seq = ++liveApplySeq;
  try {
    await invokeUpdateAppConfig({ [field]: value });
    if (seq !== liveApplySeq) return;
    if (field === 'selectedAudioDevice') {
      lastAppliedAudioDevice = value;
    } else {
      lastAppliedOutputDevice = value;
    }
    if (baselineState.value) {
      baselineState.value[field] = value;
    }
  } catch (err) {
    console.error('Не удалось применить аудиоустройство:', err);
  }
}

function discardDraftChanges(): void {
  if (baselineState.value) {
    settingsStore.applyState(baselineState.value);
  }
  if (baselineUiLocale.value) {
    locale.value = baselineUiLocale.value;
    document.documentElement.dataset.uiLocale = baselineUiLocale.value;
  }
}

function handleClose(arg?: unknown): void {
  // Этот хендлер используется как:
  // - @click (Vue передаёт MouseEvent)
  // - handleClose({ discard: false })
  // Поэтому принимаем unknown и различаем по форме.
  const shouldDiscard =
    typeof arg === 'object' && arg !== null && 'discard' in arg
      ? Boolean((arg as { discard?: boolean }).discard ?? true)
      : true;
  if (shouldDiscard) {
    discardDraftChanges();
  } else {
    captureBaseline();
  }
  emit('close');
}

async function handleSave() {
  const success = await saveConfig();
  if (success) {
    handleClose({ discard: false });
  }
}

watch(
  () => settingsStore.selectedAudioDevice,
  (next, prev) => {
    if (!isTauriAvailable()) return;
    if (!liveApplyArmed.value) return;
    if (next === prev || next === lastAppliedAudioDevice) return;
    void applyAudioDevice('selectedAudioDevice', next);
  },
);

watch(
  () => settingsStore.selectedOutputAudioDevice,
  (next, prev) => {
    if (!isTauriAvailable()) return;
    if (!liveApplyArmed.value) return;
    if (next === prev || next === lastAppliedOutputDevice) return;
    void applyAudioDevice('selectedOutputAudioDevice', next);
  },
);
</script>

<template>
  <div class="settings-overlay" @click.self="handleClose">
    <v-card class="settings-panel" elevation="0">
      <!-- Заголовок -->
      <v-card-title class="d-flex justify-space-between align-center pa-4">
        <span class="text-h6">{{ t('settings.title') }}</span>
        <v-btn
          icon="mdi-close"
          variant="text"
          size="small"
          @click="handleClose"
        />
      </v-card-title>

      <v-divider />

      <!-- Контент -->
      <v-card-text class="settings-content pa-4">
        <!-- Индикатор загрузки -->
        <div v-if="isLoading" class="d-flex justify-center py-8">
          <v-progress-circular indeterminate color="primary" />
        </div>

        <template v-else>
          <!-- Язык + тема в две колонки -->
          <div class="settings-two-cols">
            <LanguageSection />
            <ThemeSection />
          </div>

          <!-- Local or cloud STT choice (the default remains Backend) -->
          <ProviderSection />

          <!-- Ключевые термины -->
          <KeytermsSection />

          <!-- Interview memory -->
          <MemorySection />

          <!-- AI answer style -->
          <AnswerStyleSection />

          <!-- Горячая клавиша -->
          <HotkeySection />

          <!-- Источник системного звука -->
          <SystemAudioDeviceSection />

          <!-- Тест системного звука -->
          <SystemAudioTestSection />

          <!-- Выбор аудио устройства -->
          <AudioDeviceSection />

          <!-- Тест микрофона -->
          <MicTestSection />

          <!-- Обновления -->
          <UpdatesSection @show-update-dialog="showUpdateDialog = true" />

          <!-- Ошибка сохранения -->
          <v-alert
            v-if="errorMessage"
            type="error"
            variant="tonal"
            closable
            class="mt-4"
            @click:close="clearError"
          >
            {{ errorMessage }}
          </v-alert>
        </template>
      </v-card-text>

      <v-divider />

      <!-- Футер с кнопками -->
      <v-card-actions class="pa-4">
        <v-spacer />
        <v-btn
          variant="text"
          @click="handleClose"
        >
          {{ t('settings.cancel') }}
        </v-btn>
        <v-btn
          color="primary"
          :loading="isSaving"
          :disabled="isLoading"
          @click="handleSave"
        >
          {{ isSaving ? t('settings.saving') : t('settings.save') }}
        </v-btn>
      </v-card-actions>
    </v-card>

    <!-- Диалог обновления -->
    <UpdateDialog v-model="showUpdateDialog" />
  </div>
</template>

<style scoped>
.settings-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  z-index: 1000;
  -webkit-app-region: no-drag;
  background: rgba(0, 0, 0, 0.5);
}

.settings-panel {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  border-radius: 0 !important;
}

.settings-content {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}

/* Скроллбар для контента */
.settings-content::-webkit-scrollbar {
  width: 8px;
}

.settings-content::-webkit-scrollbar-track {
  background: transparent;
}

.settings-content::-webkit-scrollbar-thumb {
  background: rgba(var(--v-theme-on-surface), 0.2);
  border-radius: 4px;
}

.settings-content::-webkit-scrollbar-thumb:hover {
  background: rgba(var(--v-theme-on-surface), 0.3);
}

.settings-two-cols {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--spacing-xl);
}

@media (min-width: 600px) {
  .settings-two-cols {
    grid-template-columns: 1fr 1fr;
  }
}
</style>
