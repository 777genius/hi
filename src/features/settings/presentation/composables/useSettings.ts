/**
 * Главный composable для работы с настройками
 * Инкапсулирует загрузку, сохранение и валидацию конфигурации
 */

import { computed, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { DEFAULT_STT_PROVIDER, SttProviderType } from '@/types';
import { invoke } from '@tauri-apps/api/core';
import { isTauriAvailable } from '@/utils/tauri';
import {
  bumpUiPrefsRevision,
  CMD_UPDATE_UI_PREFERENCES,
  readUiPreferencesFromStorage,
  writeUiPreferencesCacheToStorage,
} from '@/windowing/stateSync';
import { normalizeUiLocale, normalizeSttLanguage, normalizeUiTheme } from '@/i18n.locales';
import { useSettingsStore } from '../../store/settingsStore';
import { tauriSettingsService } from '../../infrastructure/adapters/TauriSettingsService';
import { useAppConfigStore } from '@/stores/appConfig';
import { useSttConfigStore } from '@/stores/sttConfig';
import type { AnswerAudience, AnswerImperfectionLevel, AnswerLanguage, SttConfigData } from '../../domain/types';

// Кэшируем определение macOS - это не меняется во время работы
const IS_MACOS = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

export function useSettings() {
  const { locale } = useI18n();
  const store = useSettingsStore();

  // Computed для реактивных свойств
  const provider = computed({
    get: () => store.provider,
    set: (value: SttProviderType) => store.setProvider(value),
  });

  const language = computed({
    get: () => store.language,
    set: (value: string) => store.setLanguage(value, { persist: false }),
  });

  const deepgramApiKey = computed({
    get: () => store.deepgramApiKey,
    set: (value: string) => store.setDeepgramApiKey(value),
  });

  const assemblyaiApiKey = computed({
    get: () => store.assemblyaiApiKey,
    set: (value: string) => store.setAssemblyaiApiKey(value),
  });

  const whisperModel = computed({
    get: () => store.whisperModel,
    set: (value: string) => store.setWhisperModel(value),
  });

  const recordingHotkey = computed({
    get: () => store.recordingHotkey,
    set: (value: string) => store.setRecordingHotkey(value),
  });

  const microphoneSensitivity = computed({
    get: () => store.microphoneSensitivity,
    set: (value: number) => store.setMicrophoneSensitivity(value, { persist: false }),
  });

  const selectedAudioDevice = computed({
    get: () => store.selectedAudioDevice,
    set: (value: string) => store.setSelectedAudioDevice(value),
  });

  const selectedOutputAudioDevice = computed({
    get: () => store.selectedOutputAudioDevice,
    set: (value: string) => store.setSelectedOutputAudioDevice(value),
  });

  const autoCopyToClipboard = computed({
    get: () => store.autoCopyToClipboard,
    set: (value: boolean) => store.setAutoCopyToClipboard(value),
  });

  const autoPasteText = computed({
    get: () => store.autoPasteText,
    set: (value: boolean) => store.setAutoPasteText(value),
  });

  const interviewMemoryEnabled = computed({
    get: () => store.interviewMemoryEnabled,
    set: (value: boolean) => store.setInterviewMemoryEnabled(value),
  });

  const answerLanguage = computed({
    get: () => store.answerLanguage,
    set: (value: AnswerLanguage) => store.setAnswerLanguage(value),
  });

  const answerAudience = computed({
    get: () => store.answerAudience,
    set: (value: AnswerAudience) => store.setAnswerAudience(value),
  });

  const naturalAnswerStyleEnabled = computed({
    get: () => store.naturalAnswerStyleEnabled,
    set: (value: boolean) => store.setNaturalAnswerStyleEnabled(value),
  });

  const answerImperfectionLevel = computed({
    get: () => store.answerImperfectionLevel,
    set: (value: AnswerImperfectionLevel) => store.setAnswerImperfectionLevel(value),
  });

  const deepgramKeyterms = computed({
    get: () => store.deepgramKeyterms,
    set: (value: string) => store.setDeepgramKeyterms(value),
  });

  /**
   * Загрузить все настройки из бэкенда
   */
  async function loadConfig(): Promise<void> {
    store.setLoading(true);
    store.clearError();

    try {
      // В web preview/тестах без Tauri нельзя дергать invoke-команды.
      // Поэтому грузим только из localStorage и/или уже инициализированных sync-store'ов.
      if (!isTauriAvailable()) {
        const sttConfigStoreInstance = useSttConfigStore();
        const appConfigStoreInstance = useAppConfigStore();

        // STT-язык: берём из localStorage (сохранённый ранее) или дефолт
        const storedSttLang = normalizeSttLanguage(localStorage.getItem('sttLanguage') || localStorage.getItem('uiLocale'));
        const uiLocale = normalizeUiLocale(localStorage.getItem('uiLocale'));
        locale.value = uiLocale;
        localStorage.setItem('uiLocale', uiLocale);
        localStorage.setItem('sttLanguage', storedSttLang);

        store.setProvider(DEFAULT_STT_PROVIDER);
        store.setLanguage(storedSttLang, { persist: false });

        if (appConfigStoreInstance.isLoaded) {
          store.setMicrophoneSensitivity(appConfigStoreInstance.microphoneSensitivity, { persist: false });
          store.setRecordingHotkey(appConfigStoreInstance.recordingHotkey);
          store.setAutoCopyToClipboard(false);
          store.setAutoPasteText(false);
          store.setSelectedAudioDevice(appConfigStoreInstance.selectedAudioDevice);
          store.setSelectedOutputAudioDevice(appConfigStoreInstance.selectedOutputAudioDevice);
          store.setInterviewMemoryEnabled(appConfigStoreInstance.interviewMemoryEnabled);
          store.setAnswerLanguage(appConfigStoreInstance.answerLanguage);
          store.setAnswerAudience(appConfigStoreInstance.answerAudience);
          store.setNaturalAnswerStyleEnabled(appConfigStoreInstance.naturalAnswerStyleEnabled);
          store.setAnswerImperfectionLevel(appConfigStoreInstance.answerImperfectionLevel);
        } else {
          store.setMicrophoneSensitivity(95, { persist: false });
          store.setRecordingHotkey('CmdOrCtrl+Shift+X');
          store.setAutoCopyToClipboard(false);
          store.setAutoPasteText(false);
          store.setSelectedAudioDevice('');
          store.setSelectedOutputAudioDevice('');
          store.setInterviewMemoryEnabled(true);
          store.setAnswerLanguage('en');
          store.setAnswerAudience('internal');
          store.setNaturalAnswerStyleEnabled(false);
          store.setAnswerImperfectionLevel('light');
        }

        // В web режиме аудио-устройства/permission недоступны
        store.setAvailableAudioDevices([]);
        store.setAvailableOutputAudioDevices([]);
        store.setAccessibilityPermission(true);

        // API ключи и whisper-модель не используются в backend-only.
        store.setDeepgramApiKey('');
        store.setAssemblyaiApiKey('');

        // Если sttConfig store уже загружен (например, в тестах) — можно синхронизировать
        if (sttConfigStoreInstance.isLoaded) {
          const sttLang = normalizeSttLanguage(sttConfigStoreInstance.language);
          store.setLanguage(sttLang, { persist: false });
          store.setDeepgramKeyterms(sttConfigStoreInstance.deepgramKeyterms ?? '');
          const fallbackLocale = normalizeUiLocale(localStorage.getItem('uiLocale'));
          locale.value = fallbackLocale;
          localStorage.setItem('uiLocale', fallbackLocale);
          localStorage.setItem('sttLanguage', sttLang);
        }

        return;
      }

      // Загружаем STT конфиг — из sync store если уже загружен, иначе invoke
      const sttConfigStoreInstance = useSttConfigStore();
      if (sttConfigStoreInstance.isLoaded) {
        store.setProvider(sttConfigStoreInstance.provider);
        store.setLanguage(sttConfigStoreInstance.language, { persist: false });
        store.setDeepgramKeyterms(sttConfigStoreInstance.deepgramKeyterms ?? '');
      } else {
        const sttConfig = await tauriSettingsService.getSttConfig();
        store.setProvider(sttConfig.provider);
        store.setLanguage(sttConfig.language, { persist: false });
        store.setDeepgramKeyterms(sttConfig.deepgram_keyterms ?? '');
      }
      // API ключи и whisper-модель больше не используются в настройках (backend-only).
      store.setDeepgramApiKey('');
      store.setAssemblyaiApiKey('');

      // Язык интерфейса независим от языка распознавания.
      const sttLang = normalizeSttLanguage(store.language);
      store.setLanguage(sttLang, { persist: false });
      const uiLocale = normalizeUiLocale(localStorage.getItem('uiLocale'));
      locale.value = uiLocale;
      localStorage.setItem('uiLocale', uiLocale);
      localStorage.setItem('sttLanguage', sttLang);

      // Загружаем App конфиг — из sync store если уже загружен, иначе invoke
      const appConfigStoreInstance = useAppConfigStore();
      if (appConfigStoreInstance.isLoaded) {
        store.setMicrophoneSensitivity(appConfigStoreInstance.microphoneSensitivity, { persist: false });
        store.setRecordingHotkey(appConfigStoreInstance.recordingHotkey);
        store.setAutoCopyToClipboard(false);
        store.setAutoPasteText(false);
        store.setSelectedAudioDevice(appConfigStoreInstance.selectedAudioDevice);
        store.setSelectedOutputAudioDevice(appConfigStoreInstance.selectedOutputAudioDevice);
        store.setInterviewMemoryEnabled(appConfigStoreInstance.interviewMemoryEnabled);
        store.setAnswerLanguage(appConfigStoreInstance.answerLanguage);
        store.setAnswerAudience(appConfigStoreInstance.answerAudience);
        store.setNaturalAnswerStyleEnabled(appConfigStoreInstance.naturalAnswerStyleEnabled);
        store.setAnswerImperfectionLevel(appConfigStoreInstance.answerImperfectionLevel);
      } else {
        try {
          const appConfig = await tauriSettingsService.getAppConfig();
          store.setMicrophoneSensitivity(appConfig.microphone_sensitivity ?? 95, { persist: false });
          store.setRecordingHotkey(appConfig.recording_hotkey ?? 'CmdOrCtrl+Shift+X');
          store.setAutoCopyToClipboard(false);
          store.setAutoPasteText(false);
          store.setSelectedAudioDevice(appConfig.selected_audio_device ?? '');
          store.setSelectedOutputAudioDevice(appConfig.selected_output_audio_device ?? '');
          store.setInterviewMemoryEnabled(appConfig.interview_memory_enabled ?? true);
          store.setAnswerLanguage(appConfig.answer_language ?? 'ru');
          store.setAnswerAudience(appConfig.answer_audience ?? 'internal');
          store.setNaturalAnswerStyleEnabled(appConfig.natural_answer_style_enabled ?? false);
          store.setAnswerImperfectionLevel(appConfig.answer_imperfection_level ?? 'off');
        } catch (err) {
          console.log('App config не загружен, используем значения по умолчанию');
          store.setInterviewMemoryEnabled(true);
          store.setAnswerLanguage('en');
          store.setAnswerAudience('internal');
          store.setNaturalAnswerStyleEnabled(false);
          store.setAnswerImperfectionLevel('light');
        }
      }

      // Загружаем список аудио устройств
      try {
        const devices = await tauriSettingsService.getAudioDevices();
        store.setAvailableAudioDevices(devices);
      } catch (err) {
        console.error('Ошибка загрузки аудио устройств:', err);
      }

      // Загружаем список output устройств (источники системного звука)
      try {
        const devices = await tauriSettingsService.getOutputAudioDevices();
        store.setAvailableOutputAudioDevices(devices);
      } catch (err) {
        console.error('Ошибка загрузки output аудио устройств:', err);
      }

      // Проверяем Accessibility разрешение на macOS
      if (IS_MACOS) {
        try {
          const hasPermission =
            await tauriSettingsService.checkAccessibilityPermission();
          store.setAccessibilityPermission(hasPermission);
        } catch (err) {
          console.error('Ошибка проверки Accessibility:', err);
        }
      }
    } catch (err) {
      console.error('Ошибка загрузки конфигурации:', err);
      store.setError(String(err));
    } finally {
      store.setLoading(false);
    }
  }

  /**
   * Сохранить все настройки в бэкенд
   */
  async function saveConfig(): Promise<boolean> {
    store.setSaveStatus('saving');
    store.clearError();

    try {
      // Важно: даём Vue применить последние изменения из v-model (например, если пользователь
      // только что отпустил слайдер и сразу нажал "Сохранить").
      await nextTick();

      const normalizeKeyterms = (v: string | null | undefined): string | null => {
        const s = String(v ?? '').trim();
        return s ? s : null;
      };

      // Сохраняем STT конфиг
      const expectedKeyterms = normalizeKeyterms(store.deepgramKeyterms);
      const sttConfigData: Partial<SttConfigData> & Pick<SttConfigData, 'provider' | 'language'> = {
        // Backend is the default, but local Parakeet is an explicit choice.
        provider: store.provider,
        language: store.language,
        deepgramApiKey: null,
        assemblyaiApiKey: null,
        model: null,
        deepgramKeyterms: expectedKeyterms,
      };

      await tauriSettingsService.updateSttConfig(sttConfigData);

      // Проверяем, что STT настройки реально применились в Rust SoT.
      try {
        const stt1 = await tauriSettingsService.getSttConfig();
        const isApplied = (stt: Awaited<ReturnType<typeof tauriSettingsService.getSttConfig>>) =>
          stt.language === store.language &&
          stt.provider === store.provider &&
          normalizeKeyterms(stt.deepgram_keyterms) === expectedKeyterms;

        if (!isApplied(stt1)) {
          await tauriSettingsService.updateSttConfig(sttConfigData);
          const stt2 = await tauriSettingsService.getSttConfig();
          if (!isApplied(stt2)) {
            throw new Error(
              `STT настройки не сохранились: ожидали language=${store.language}, deepgram_keyterms=${expectedKeyterms ?? 'null'}, получили language=${stt2.language}, deepgram_keyterms=${normalizeKeyterms(stt2.deepgram_keyterms) ?? 'null'}`,
            );
          }
        }
      } catch (verifyErr) {
        throw verifyErr;
      }

      // Сохраняем App конфиг
      // Отдельно сохраняем чувствительность: это критично для UX, и так мы избегаем
      // любых странностей сериализации/комбинации полей в одном invoke.
      await tauriSettingsService.updateAppConfig({
        microphone_sensitivity: store.microphoneSensitivity,
      });

      // Остальные поля можно сохранить вторым вызовом.
      await tauriSettingsService.updateAppConfig({
        recording_hotkey: store.recordingHotkey,
        selected_audio_device: store.selectedAudioDevice,
        selected_output_audio_device: store.selectedOutputAudioDevice,
        interview_memory_enabled: store.interviewMemoryEnabled,
        answer_language: store.answerLanguage,
        answer_audience: store.answerAudience,
        natural_answer_style_enabled: store.naturalAnswerStyleEnabled,
        answer_imperfection_level: store.answerImperfectionLevel,
      });

      // Жёсткая проверка: иногда UI может думать что сохранили, но по факту snapshot остался старым.
      // Такое лучше ловить сразу, иначе пользователь видит "сохранилось", а при следующем открытии снова 95.
      try {
        const snap1 = await tauriSettingsService.getAppConfig();
        if (
          snap1.microphone_sensitivity !== store.microphoneSensitivity ||
          snap1.interview_memory_enabled !== store.interviewMemoryEnabled ||
          snap1.answer_language !== store.answerLanguage ||
          snap1.answer_audience !== store.answerAudience ||
          snap1.natural_answer_style_enabled !== store.naturalAnswerStyleEnabled ||
          snap1.answer_imperfection_level !== store.answerImperfectionLevel
        ) {
          // Повторяем только критичные app-config поля — минимальный безопасный ретрай.
          await tauriSettingsService.updateAppConfig({
            microphone_sensitivity: store.microphoneSensitivity,
            interview_memory_enabled: store.interviewMemoryEnabled,
            answer_language: store.answerLanguage,
            answer_audience: store.answerAudience,
            natural_answer_style_enabled: store.naturalAnswerStyleEnabled,
            answer_imperfection_level: store.answerImperfectionLevel,
          });
          const snap2 = await tauriSettingsService.getAppConfig();
          if (
            snap2.microphone_sensitivity !== store.microphoneSensitivity ||
            snap2.interview_memory_enabled !== store.interviewMemoryEnabled ||
            snap2.answer_language !== store.answerLanguage ||
            snap2.answer_audience !== store.answerAudience ||
            snap2.natural_answer_style_enabled !== store.naturalAnswerStyleEnabled ||
            snap2.answer_imperfection_level !== store.answerImperfectionLevel
          ) {
            throw new Error(
              `Настройки не сохранились: sensitivity ${store.microphoneSensitivity}/${snap2.microphone_sensitivity}, interviewMemory ${store.interviewMemoryEnabled}/${snap2.interview_memory_enabled}, answerLanguage ${store.answerLanguage}/${snap2.answer_language}`,
            );
          }
        }
      } catch (verifyErr) {
        throw verifyErr;
      }

      // UI preferences (theme/locale/system-theme) сохраняем только по "Save".
      persistUiPreferences();

      store.setSaveStatus('success');
      return true;
    } catch (err) {
      console.error('Ошибка сохранения конфигурации:', err);
      store.setError(String(err));
      store.setSaveStatus('error');
      return false;
    }
  }

  /**
   * Запросить Accessibility разрешение (macOS)
   */
  async function requestAccessibilityPermission(): Promise<void> {
    try {
      await tauriSettingsService.requestAccessibilityPermission();

      // Проверяем разрешение через 2 секунды
      setTimeout(async () => {
        if (IS_MACOS) {
          const hasPermission =
            await tauriSettingsService.checkAccessibilityPermission();
          store.setAccessibilityPermission(hasPermission);
        }
      }, 2000);
    } catch (err) {
      console.error('Ошибка запроса Accessibility:', err);
      store.setError(String(err));
    }
  }

  /** Сохранить выбранный язык интерфейса отдельно от языка распознавания. */
  function syncLocale(opts?: { persist?: boolean }): void {
    const shouldPersist = opts?.persist ?? true;
    const uiLocale = normalizeUiLocale(localStorage.getItem('uiLocale'));
    const prev = localStorage.getItem('uiLocale');

    locale.value = uiLocale;
    document.documentElement.dataset.uiLocale = uiLocale;

    if (!shouldPersist) return;

    localStorage.setItem('sttLanguage', store.language);
    if (prev !== uiLocale) localStorage.setItem('uiLocale', uiLocale);
    if (!isTauriAvailable() && prev !== uiLocale) bumpUiPrefsRevision();

    // Синхронизация через state-sync: сохраняем в Rust и уведомляем другие окна
    if (isTauriAvailable()) {
      try {
        void invoke(CMD_UPDATE_UI_PREFERENCES, {
          theme: normalizeUiTheme(store.theme),
          locale: uiLocale,
          use_system_theme: Boolean(store.useSystemTheme),
        });
      } catch {}
    }
  }

  function persistUiPreferences(): void {
    const uiLocale = normalizeUiLocale(localStorage.getItem('uiLocale'));

    // Применяем локально (preview уже мог быть, но это идемпотентно)
    locale.value = uiLocale;
    document.documentElement.dataset.uiLocale = uiLocale;

    // Пишем в localStorage как в кэш "последнее применённое"
    writeUiPreferencesCacheToStorage({
      ...readUiPreferencesFromStorage(),
      theme: normalizeUiTheme(store.theme),
      locale: uiLocale,
      useSystemTheme: Boolean(store.useSystemTheme),
    });

    // STT язык тоже держим в localStorage (для web preview / fallback)
    localStorage.setItem('sttLanguage', store.language);

    if (!isTauriAvailable()) {
      bumpUiPrefsRevision();
      return;
    }

    try {
      void invoke(CMD_UPDATE_UI_PREFERENCES, {
        theme: normalizeUiTheme(store.theme),
        locale: uiLocale,
        use_system_theme: Boolean(store.useSystemTheme),
      });
    } catch {}
  }

  return {
    // Store state (через computed для v-model)
    provider,
    language,
    deepgramApiKey,
    assemblyaiApiKey,
    whisperModel,
    recordingHotkey,
    microphoneSensitivity,
    selectedAudioDevice,
    selectedOutputAudioDevice,
    autoCopyToClipboard,
    autoPasteText,
    interviewMemoryEnabled,
    answerLanguage,
    answerAudience,
    naturalAnswerStyleEnabled,
    answerImperfectionLevel,
    deepgramKeyterms,

    // Store state (через computed для корректной реактивности)
    isWhisperProvider: computed(() => store.isWhisperProvider),
    isCloudProvider: computed(() => store.isCloudProvider),
    isSaving: computed(() => store.isSaving),
    isLoading: computed(() => store.isLoading),
    errorMessage: computed(() => store.errorMessage),
    availableAudioDevices: computed(() => store.availableAudioDevices),
    availableOutputAudioDevices: computed(() => store.availableOutputAudioDevices),
    hasAccessibilityPermission: computed(() => store.hasAccessibilityPermission),

    // Утилиты
    isMacOS: IS_MACOS,

    // Действия
    loadConfig,
    saveConfig,
    syncLocale,
    requestAccessibilityPermission,
    persistUiPreferences,
    clearError: () => store.clearError(),
  };
}
