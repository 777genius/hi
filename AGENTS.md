# AGENTS.md

## Project Run Notes

- To run the desktop frontend against the production backend on Render with real Brave/CDP focus-copy support:

  ```bash
  pnpm copy-helper:brave:restart-cdp
  VITE_API_URL=https://api.voicetext.site VOICE_TO_TEXT_BACKEND_URL=wss://api.voicetext.site FOCUS_COPY_ENABLE_BROWSER_CDP=1 pnpm tauri dev
  ```

- The production backend is deployed through Render. Use the available Render MCP when checking deploy status, logs, or production backend state.
- For local backend testing, the VoicetextAI backend lives at:

  ```text
  /Users/belief/dev/projects/VoicetextAI/backend
  ```

- When touching transcription/STT behavior, prefer testing both against the Render backend and, when needed, against the local backend above.
- Interview memory now defaults to desktop `ActiveContext`. Backend routes still require backend config `interview_memory.enabled=true`, which maps to env `INTERVIEW_MEMORY__ENABLED=true` with the current backend config loader. The normal production-backend desktop run is:

  ```bash
  pnpm copy-helper:brave:restart-cdp
  VITE_API_URL=https://api.voicetext.site VOICE_TO_TEXT_BACKEND_URL=wss://api.voicetext.site FOCUS_COPY_ENABLE_BROWSER_CDP=1 pnpm tauri dev
  ```

- The desktop bridge resolves memory behavior through `INTERVIEW_MEMORY_MODE` first. Supported values are `disabled`, `shadow_ingest`, `shadow_retrieve`, `assistive_context`, `active_context`, and `local_only`. When unset, the bridge resolves to `active_context`. `INTERVIEW_MEMORY_ENABLED=1` remains a legacy explicit shortcut for `active_context`; `INTERVIEW_MEMORY_ENABLED=false` or `INTERVIEW_MEMORY_ACTIVE_CONTEXT=false` disables the default. `INTERVIEW_MEMORY_FORCE_DISABLED=true` wins over every other memory flag. The Settings memory switch writes `AppConfig.interview_memory_enabled`; when it is false, the runtime resolved mode is `disabled` without restart. `INTERVIEW_MEMORY_FORCE_LOCAL_ONLY=true` avoids backend memory calls and keeps only the minimal local prompt fallback.
- The desktop memory bridge calls `/api/v1/interview-memory/ingest` and `/api/v1/interview-memory/context`. It must remain best-effort for ingest and must fall back to local context if active context retrieval fails.
- For local memory backend canary while keeping STT on production, use `INTERVIEW_MEMORY_API_URL=http://127.0.0.1:8080` for the memory bridge and `INTERVIEW_MEMORY_AUTH_TOKEN=<local-user-jwt>` as the explicit memory-only auth override. Keep `VITE_API_URL=https://api.voicetext.site` and `VOICE_TO_TEXT_BACKEND_URL=wss://api.voicetext.site` if the rest of the app should remain pointed at production.
