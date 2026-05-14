# HackInterview Focus Copy Browser Bridge

This unpacked Chromium extension keeps the currently focused editable field cached in a local native host. The macOS helper uses it on `Ctrl+Shift+A` as the primary invisible browser path, then falls back to Accessibility or AppleScript paths.

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
- Monaco adapter cache is disabled by default while CDP is being tested. Re-enable it explicitly with `FOCUS_COPY_ENABLE_MONACO_CACHE=1`.
- Works best for normal `input`, `textarea`, `contenteditable`, and many DOM-backed editors.
- Does not copy password fields.
- Cannot run on restricted browser pages such as `chrome://` or the Chrome Web Store.
- For custom canvas editors, a per-site adapter may still be needed because the text is not present in the DOM.
