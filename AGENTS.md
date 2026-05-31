# AGENTS.md

## Project Run Notes

- To run the desktop frontend against the production backend on Render with real Brave/CDP focus-copy support:

  ```bash
  pnpm copy-helper:brave:restart-cdp
  VITE_API_URL=https://api.voicetext.site VOICE_TO_TEXT_BACKEND_URL=wss://api.voicetext.site FOCUS_COPY_ENABLE_BROWSER_CDP=1 pnpm tauri dev
  ```

- To run the desktop frontend against production STT but the new local Memory Platform:

  ```bash
  pnpm memory-platform:stack
  pnpm copy-helper:brave:restart-cdp
  pnpm tauri:dev:memory-platform
  ```

- The production backend is deployed through Render. Use the available Render MCP when checking deploy status, logs, or production backend state.
- For local backend testing, the VoicetextAI backend lives at:

  ```text
  /Users/belief/dev/projects/VoicetextAI/backend
  ```

- When touching transcription/STT behavior, prefer testing both against the Render backend and, when needed, against the local backend above.
- Interview memory now defaults to desktop `ActiveContext`. For the new memory stack, prefer the Memory Platform run:

  ```bash
  pnpm copy-helper:brave:restart-cdp
  pnpm tauri:dev:memory-platform
  ```

- The desktop bridge resolves memory behavior through `INTERVIEW_MEMORY_MODE` first. Supported values are `disabled`, `shadow_ingest`, `shadow_retrieve`, `assistive_context`, `active_context`, and `local_only`. When unset, the bridge resolves to `active_context`. `INTERVIEW_MEMORY_ENABLED=1` remains a legacy explicit shortcut for `active_context`; `INTERVIEW_MEMORY_ENABLED=false` or `INTERVIEW_MEMORY_ACTIVE_CONTEXT=false` disables the default. `INTERVIEW_MEMORY_FORCE_DISABLED=true` wins over every other memory flag. The Settings memory switch writes `AppConfig.interview_memory_enabled`; when it is false, the runtime resolved mode is `disabled` without restart. `INTERVIEW_MEMORY_FORCE_LOCAL_ONLY=true` avoids backend memory calls and keeps only the minimal local prompt fallback.
- The desktop memory bridge supports `INTERVIEW_MEMORY_API_VARIANT=auto|platform|legacy`. `auto` tries the Memory Platform v1 API first (`/v1/episodes`, `/v1/context`) and falls back to legacy compatibility routes only when v1 endpoints are unavailable. It must remain best-effort for ingest and must fall back to local context if active context retrieval fails.
- For local Memory Platform canary while keeping STT on production, use `INTERVIEW_MEMORY_API_VARIANT=platform`, `INTERVIEW_MEMORY_API_URL=http://127.0.0.1:7788`, and `INTERVIEW_MEMORY_AUTH_TOKEN=<memory-service-token>` for the memory bridge. Keep `VITE_API_URL=https://api.voicetext.site` and `VOICE_TO_TEXT_BACKEND_URL=wss://api.voicetext.site` if the rest of the app should remain pointed at production.
