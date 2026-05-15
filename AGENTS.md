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
