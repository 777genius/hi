// Общие константы/типы для state-sync протокола в Tauri окружении.
// Здесь нет логики — только контракт.

export const STATE_SYNC_INVALIDATION_EVENT = 'state-sync:invalidation' as const;

export type StateSyncInvalidationEventPayload = {
  topic: string;
  revision: string;
  sourceId?: string;
  timestampMs?: number;
};

// Snapshot commands (Rust SoT)
export const CMD_GET_APP_CONFIG_SNAPSHOT = 'get_app_config_snapshot' as const;
export const CMD_GET_STT_CONFIG_SNAPSHOT = 'get_stt_config_snapshot' as const;
export const CMD_GET_AUTH_STATE_SNAPSHOT = 'get_auth_state_snapshot' as const;
export const CMD_GET_AUTH_SESSION_SNAPSHOT = 'get_auth_session_snapshot' as const;
export const CMD_GET_UI_PREFERENCES_SNAPSHOT = 'get_ui_preferences_snapshot' as const;
export const CMD_GET_COMPANION_SNAPSHOT = 'get_companion_snapshot' as const;
export const CMD_GET_COMPANION_SERVER_STATUS = 'get_companion_server_status' as const;

// Write path (Rust SoT)
export const CMD_UPDATE_UI_PREFERENCES = 'update_ui_preferences' as const;
export const CMD_ENABLE_COMPANION_MODE = 'enable_companion_mode' as const;
export const CMD_DISABLE_COMPANION_MODE = 'disable_companion_mode' as const;
export const CMD_COMPANION_CLEAR_CONTEXT = 'companion_clear_context' as const;
export const CMD_COMPANION_CLEAR_HISTORY = 'companion_clear_history' as const;
export const CMD_COMPANION_REQUEST_AI = 'companion_request_ai' as const;
export const CMD_COMPANION_SEND_PROMPT = 'companion_send_prompt' as const;
export const CMD_SET_COMPANION_SYSTEM_PROMPT = 'set_companion_system_prompt' as const;

// Write path (Tauri commands)
export const CMD_UPDATE_APP_CONFIG = 'update_app_config' as const;
export const CMD_UPDATE_STT_CONFIG = 'update_stt_config' as const;
