# HackInterview Focus Copy Browser Bridge

This unpacked Chromium extension keeps the currently focused editable field cached in a local native host. The macOS helper uses it on `Ctrl+Shift+A` for the universal copy path and on `Ctrl+Shift+S` for a browser editor-API copy path.

## Install

```bash
pnpm copy-helper:browser-extension:install
```

Then open:

- Brave: `brave://extensions`
- Chrome: `chrome://extensions`
- Edge: `edge://extensions`

Enable Developer mode, click **Load unpacked**, and select this directory.

After loading or changing the extension files, click reload for the unpacked extension on the browser extensions page, then reload already-open site tabs if they still show `Extension context invalidated`.

Expected extension id:

```text
oaheacojmffccgcimpghndlkggkpidjo
```

## Notes

- The extension requests the `debugger` permission for an opt-in CDP fallback. It is disabled by default because Chrome/Brave shows a visible "started debugging this browser" bar whenever `chrome.debugger` attaches. Start the helper with `FOCUS_COPY_ENABLE_BROWSER_CDP=1` only when that visible fallback is acceptable.
- To hide that bar in Brave, launch Brave with Chromium's silent debugger flag before using CDP:

```bash
pnpm copy-helper:brave:restart-cdp
FOCUS_COPY_ENABLE_BROWSER_CDP=1 pnpm tauri dev
```

If Brave is already running, macOS ignores new Chromium flags. Use the restart command above or close Brave first and then run `pnpm copy-helper:brave:open-cdp`.
- `Ctrl+Shift+S` tries focused browser editor APIs directly, without `Cmd+A`/`Cmd+C` and without visible selection. Current adapters cover Monaco, CodeMirror 5/6, Ace, textarea/input, Quill, TinyMCE, ProseMirror-like editors, Slate, Lexical, Draft.js, and CodeJar fallbacks.
- Monaco adapter cache is disabled by default for `Ctrl+Shift+A` while CDP is being tested. Re-enable it explicitly with `FOCUS_COPY_ENABLE_MONACO_CACHE=1`. `Ctrl+Shift+S` bypasses that cache flag and asks the active tab for fresh editor API text.
- Works best for normal `input`, `textarea`, `contenteditable`, and many DOM-backed editors.
- Does not copy password fields.
- Cannot run on restricted browser pages such as `chrome://` or the Chrome Web Store.
- For custom canvas editors, a per-site adapter may still be needed because the text is not present in the DOM.
