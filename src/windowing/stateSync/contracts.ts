/**
 * Контракты данных для state-sync (Tauri snapshot'ы).
 *
 * Здесь только типы (без логики), чтобы:
 * - не дублировать shape снапшотов по проекту
 * - уменьшить риск дрейфа между Rust и TS
 */

import type { SttProviderType } from '@/types';
import type { UiLocale, UiTheme } from '@/i18n.locales';
import type { SnapshotEnvelope } from '@statesync/core';
import type { AnswerAudience, AnswerImperfectionLevel, AnswerLanguage } from '@/features/settings/domain/types';

/**
 * Публичный снапшот app-config, который можно безопасно раздавать во все окна.
 * Соответствует Rust `AppConfigSnapshotData`.
 */
export type AppConfigSnapshotData = {
  microphone_sensitivity: number;
  recording_hotkey: string;
  auto_copy_to_clipboard: boolean;
  auto_paste_text: boolean;
  selected_audio_device: string | null;
  selected_output_audio_device: string | null;
  interview_memory_enabled: boolean;
  answer_language: AnswerLanguage;
  answer_audience: AnswerAudience;
  natural_answer_style_enabled: boolean;
  answer_imperfection_level: AnswerImperfectionLevel;
};

/**
 * Публичный снапшот stt-config, который можно безопасно раздавать во все окна.
 * Соответствует Rust `SttConfigSnapshotData`.
 */
export type SttConfigSnapshotData = {
  provider: SttProviderType;
  language: string;

  auto_detect_language: boolean;
  enable_punctuation: boolean;
  filter_profanity: boolean;

  deepgram_api_key: string | null;
  assemblyai_api_key: string | null;
  model: string | null;

  keep_connection_alive: boolean;

  deepgram_keyterms: string | null;
};

/** Соответствует Rust `AuthStateData`. */
export type AuthStateSnapshotData = {
  is_authenticated: boolean;
};

/**
 * Полный снапшот auth-session (device_id + tokens).
 * Соответствует Rust `AuthSessionSnapshotData`.
 *
 * Важно: содержит секреты (access/refresh), поэтому использовать только внутри приложения.
 */
export type AuthSessionSnapshotData = {
  device_id: string;
  session: null | {
    access_token: string;
    refresh_token: string | null;
    access_expires_at: string;
    refresh_expires_at: string | null;
    user: null | {
      id: string;
      email: string;
      email_verified: boolean;
    };
  };
};

/**
 * UI preferences (Rust SoT в Tauri).
 * Соответствует Rust `UiPreferences`.
 */
export type UiPreferencesSnapshotData = {
  theme: UiTheme;
  locale: UiLocale;
  use_system_theme: boolean;
};

export type CompanionRecordingStatus =
  | 'Idle'
  | 'Starting'
  | 'Recording'
  | 'Processing'
  | 'Error';

export type CompanionMessage = {
  id: string;
  seq: number;
  kind: string;
  role: string;
  status: string;
  text: string;
  createdAtMs: number;
  sessionId?: number | null;
  requestId?: string | null;
  generation?: number | null;
  insertAfterId?: string | null;
  sttIndex?: number | null;
  deleted?: boolean;
  attachments?: CompanionAttachment[] | null;
  candidates?: CompanionLlmCandidate[] | null;
  activeCandidateId?: string | null;
};

export type CompanionAttachment = {
  id: string;
  kind: string;
  mime: string;
  dataUrl: string;
};

export type CompanionLlmCandidate = {
  id: string;
  label: string;
  provider: string;
  model: string;
  status: string;
  text: string;
  error?: string | null;
};

export type CompanionSnapshotData = {
  authRequired: boolean;
  recording: {
    status: CompanionRecordingStatus;
    activeSessionId: number;
  };
  microphone: {
    muted: boolean;
    enabled: boolean;
    supported: boolean;
    source: string;
    systemMuted: boolean;
    systemSupported: boolean;
    systemSource: string;
    appMuted: boolean;
    appEnabled: boolean;
  };
  memory?: {
    mode: string;
    apiVariant?: string;
    apiBaseUrl?: string;
    backendIngestEnabled: boolean;
    backendPromptContextEnabled: boolean;
    minimalLocalPromptContextEnabled: boolean;
    sessionId: string;
    lastContextStatus: 'ok' | 'fallback' | 'disabled' | 'auth_missing' | string;
    lastContextError?: string | null;
    lastContextLatencyMs?: number | null;
    lastIngestStatus: 'ok' | 'skipped' | 'failed' | string;
    lastIngestError?: string | null;
    lastUpdatedAtMs?: number | null;
  };
  controls: {
    historyFloorSeq: number;
    contextFloorSeq: number;
    conversationGeneration: number;
    companionModeEnabled: boolean;
    desktopBlackoutEnabled: boolean;
    lastAction?: string | null;
  };
  live: {
    partialText?: string | null;
    finalText?: string | null;
    partialStartedAtMs?: number | null;
    microphonePartialText?: string | null;
    microphonePartialStartedAtMs?: number | null;
  };
  timeline: CompanionMessage[];
};

export type CompanionActionResponse = {
  ok: boolean;
  actionResult: string;
  snapshot: TauriSnapshotEnvelope<CompanionSnapshotData>;
};

export type CompanionServerStatus = {
  enabled: boolean;
  port?: number | null;
  token?: string | null;
  localUrl?: string | null;
  localNetworkUrl?: string | null;
};

// Переиспользуем envelope из state-sync, чтобы не плодить дубли.
export type TauriSnapshotEnvelope<T> = SnapshotEnvelope<T>;
