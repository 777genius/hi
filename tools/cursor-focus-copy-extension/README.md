# Clipboard Tools

Локальное Cursor/VS Code extension с небольшими clipboard-утилитами для редактора.

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
