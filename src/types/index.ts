// Domain types mirroring Rust backend

export enum RecordingStatus {
  Idle = 'Idle',
  Starting = 'Starting', // Запись инициализируется
  Recording = 'Recording',
  Processing = 'Processing',
  Error = 'Error',
}

export interface Transcription {
  text: string;
  is_final: boolean;
  confidence?: number;
  language?: string;
  timestamp: number;
}

export interface PartialTranscriptionPayload {
  session_id: number;
  source?: 'system' | 'microphone';
  text: string;
  timestamp: number;
  is_segment_final: boolean; // true когда сегмент финализирован (но речь продолжается)
  start: number; // start время utterance в секундах (от Deepgram)
  duration: number; // длительность utterance в секундах (от Deepgram)
}

export interface FinalTranscriptionPayload {
  session_id: number;
  source?: 'system' | 'microphone';
  text: string;
  confidence?: number;
  language?: string;
  timestamp: number;
  start?: number;
  duration?: number;
}

export interface RecordingStatusPayload {
  session_id: number;
  status: RecordingStatus;
  stopped_via_hotkey?: boolean;
}

export interface ErrorPayload {
  message: string;
  code?: string;
}

export interface TranscriptionErrorPayload {
  session_id: number;
  error: string;
  error_type: 'connection' | 'configuration' | 'processing' | 'timeout' | 'authentication' | 'limit_exceeded';
  error_details?: TranscriptionErrorDetailsPayload;
}

export interface TranscriptionErrorDetailsPayload {
  category?:
    | 'offline'
    | 'dns'
    | 'tls'
    | 'refused'
    | 'reset'
    | 'timeout'
    | 'http'
    | 'server_unavailable'
    | 'closed'
    | 'rate_limited'
    | 'limit_exceeded'
    | 'unknown';
  httpStatus?: number;
  wsCloseCode?: number;
  ioErrorKind?: string;
  osError?: number;
  serverCode?: string;
}

export enum ConnectionQuality {
  Good = 'Good',
  Poor = 'Poor',
  Recovering = 'Recovering',
}

export interface ConnectionQualityPayload {
  session_id: number;
  quality: ConnectionQuality;
  reason?: string;
}

export interface MicrophoneMuteStatePayload {
  muted: boolean;
  supported: boolean;
  source: string;
  detail?: string;
}

export interface SignalMessagePayload {
  id: string;
  platform: 'signal';
  sender: string;
  conversationId?: string | null;
  text: string;
  timestamp: number;
}

export interface HaikuDeltaPayload {
  request_id: string;
  delta: string;
  candidate_id?: string | null;
  candidate_label?: string | null;
  provider?: string | null;
  model?: string | null;
}

export interface HaikuDonePayload {
  request_id: string;
  candidate_id?: string | null;
  candidate_label?: string | null;
  provider?: string | null;
  model?: string | null;
}

export interface HaikuErrorPayload {
  request_id: string;
  error: string;
  candidate_id?: string | null;
  candidate_label?: string | null;
  provider?: string | null;
  model?: string | null;
}

export interface HaikuCandidateStartPayload {
  request_id: string;
  candidate_id: string;
  candidate_label: string;
  provider: string;
  model: string;
}

export interface CodeExplainDeltaPayload {
  request_id: string;
  delta: string;
}

export interface CodeExplainDonePayload {
  request_id: string;
}

export interface CodeExplainErrorPayload {
  request_id: string;
  error: string;
}

// Event names (must match Rust backend)
export const EVENT_TRANSCRIPTION_PARTIAL = 'transcription:partial';
export const EVENT_TRANSCRIPTION_FINAL = 'transcription:final';
export const EVENT_RECORDING_STATUS = 'recording:status';
export const EVENT_TRANSCRIPTION_ERROR = 'transcription:error';
export const EVENT_CONNECTION_QUALITY = 'connection:quality';
export const EVENT_SIGNAL_MESSAGE = 'signal:message';
export const EVENT_HAIKU_DELTA = 'haiku:delta';
export const EVENT_HAIKU_DONE = 'haiku:done';
export const EVENT_HAIKU_ERROR = 'haiku:error';
export const EVENT_HAIKU_CANDIDATE_START = 'haiku:candidate-start';
export const EVENT_CODE_EXPLAIN_DELTA = 'code_explain:delta';
export const EVENT_CODE_EXPLAIN_DONE = 'code_explain:done';
export const EVENT_CODE_EXPLAIN_ERROR = 'code_explain:error';
export const EVENT_ERROR = 'app:error';
export const EVENT_RECORDING_WINDOW_SHOWN = 'recording:window-shown';
export const EVENT_MICROPHONE_MUTE_STATE = 'microphone:mute-state';

// STT Configuration types
export enum SttProviderType {
  Mock = 'mock',
  AssemblyAI = 'assemblyai',
  Deepgram = 'deepgram',
  Backend = 'backend',
  WhisperLocal = 'whisperlocal',
  ParakeetUltra = 'parakeetultra',
  WhisperLargeV3 = 'whisperlargev3',
  GoogleCloud = 'googlecloud',
  Azure = 'azure',
}

/** On-device models that share one VAD-utterance pipeline (mirrors Rust `is_local_utterance`). */
export function isLocalUtteranceProvider(provider: SttProviderType): boolean {
  return provider === SttProviderType.ParakeetUltra || provider === SttProviderType.WhisperLargeV3;
}

export interface SttConfig {
  provider: SttProviderType;
  language: string;
  auto_detect_language: boolean;
  enable_punctuation: boolean;
  filter_profanity: boolean;
  deepgram_api_key?: string;
  assemblyai_api_key?: string;
  model?: string;
}

// Whisper Model Management types
export interface WhisperModelInfo {
  name: string;
  size_bytes: number;
  size_human: string;
  download_url: string;
  description: string;
  speed_factor: number;
  quality_factor: number;
}

export interface WhisperModelDownloadProgress {
  model_name: string;
  downloaded: number;
  total: number;
  progress: number;
}

// Whisper events
export const EVENT_WHISPER_DOWNLOAD_STARTED = 'whisper-model:download-started';
export const EVENT_WHISPER_DOWNLOAD_PROGRESS = 'whisper-model:download-progress';
export const EVENT_WHISPER_DOWNLOAD_COMPLETED = 'whisper-model:download-completed';

// App update types/events
export interface AppUpdateInfo {
  version: string;
  body: string;
}

export interface AppUpdateDownloadProgress {
  version: string;
  downloaded: number;
  total: number | null;
  progress: number | null;
}

export const EVENT_UPDATE_AVAILABLE = 'update:available';
export const EVENT_UPDATE_DOWNLOAD_STARTED = 'update:download-started';
export const EVENT_UPDATE_DOWNLOAD_PROGRESS = 'update:download-progress';
export const EVENT_UPDATE_INSTALLING = 'update:installing';

// Settings focus events (между окнами)
export const EVENT_SETTINGS_FOCUS_UPDATES = 'settings:focus-updates';
