# macOS Focus Copy Helper

Native Swift helper for copying all text from the currently focused macOS input with `Ctrl+Shift+A`.

The helper tries the fastest paths first:

1. Read full text directly through Accessibility `AXValue` and write it to `NSPasteboard`.
2. Read text by full `AXStringForRangeParameterizedAttribute` without changing the visible selection.
3. Select the full text through `AXSelectedTextRange`, copy the selected text, then restore the previous caret or selection range.
4. As a last fallback, send `Cmd+C`, wait briefly for the pasteboard to change, then restore the previous caret or selection range.

## Run

```bash
pnpm copy-helper:run
```

The command builds `Telegram.app`, starts a small supervisor, and runs the helper directly. The helper must stay running to receive the global hotkey.

```bash
pnpm copy-helper:status
pnpm copy-helper:stop
```

## Build

```bash
pnpm copy-helper:build
```

If a Developer ID certificate is available, set `FOCUS_COPY_SIGNING_IDENTITY` on the first build.
Later builds reuse the existing bundle's Developer ID, so macOS keeps the same Accessibility identity.

The app bundle is created at:

```text
tools/macos-focus-copy-helper/dist/Telegram.app
```

The raw release binary is also created at:

```text
tools/macos-focus-copy-helper/.build/release/MacOSFocusCopyHelper
```

## Accessibility Permission

The helper needs macOS Accessibility permission. On first run it requests permission automatically.

If macOS does not show the prompt, open:

```text
System Settings > Privacy & Security > Accessibility
```

Then add or enable:

```text
tools/macos-focus-copy-helper/dist/Telegram.app
```

If macOS already has a stale permission row for the raw `.build` binary, remove it and add the `.app` bundle instead.

## Logs

```bash
pnpm copy-helper:logs
```

Log file:

```text
~/Library/Logs/HackInterview/MacOSFocusCopyHelper.log
```

## Accessibility Diagnosis

Check the permission seen by the helper app bundle itself:

```bash
pnpm copy-helper:check
```
