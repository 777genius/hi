# Clipboard Tools

Локальное Cursor/VS Code extension с небольшими clipboard-утилитами для редактора.

## Secure Companion endpoint discovery

By default, the extension reads the **active** Companion port and per-launch identity from the private `ClipboardTools/bridge.json`, written when Phone/Companion mode starts. There is no hard-coded localhost port fallback: if Companion is disabled, stale or unreachable, sending stops with an error.

Before transmitting either an access token or editor text, the extension performs an unauthenticated nonce challenge on `/api/identity`. The response must prove possession of the local Companion token and match the current instance identifier. An explicitly configured `clipboardTools.backendUrl` still requires identity verification.

If port 43821 is occupied by another program, Companion may use 43822, 43823 or an OS-assigned port. **Do not configure a fixed port merely to work around this**. Reopen Companion in the desktop app and run the command again.

## Command

- `Clipboard: Copy Active File`
- Default hotkey: `Ctrl+Shift+C`

`Ctrl+Shift+S` intentionally stays free.

Payload уходит в:

```text
http://127.0.0.1:43821/api/focus-copy/ingest
```

Extension берёт `X-Companion-Token` из настроек `clipboardTools.accessToken`, из env token или автоматически из локального bridge/config файла.

## Install

```bash
pnpm cursor-extension:install
```

После установки перезагрузите Cursor window, если окно уже было открыто.
