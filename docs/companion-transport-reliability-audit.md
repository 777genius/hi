# Companion transport and synchronization reliability audit

Baseline: `main` at `2a48ada6362663166c03d0127dfcb2421f523759`. Scope is Companion LAN HTTP/SSE, mobile state synchronization and transport lifecycle. No provider, transcription-model or ReviewRouter changes.

## Reproduced from code inspection

1. **Initial connection and broken SSE recovery:** `bootstrap()` attempts one GET. On failure no EventSource is installed and no scheduled retry exists. A malformed SSE frame disposes EventSource, then only one resync is attempted. Recovery thus depends on a browser visibility/online event or manual reload.
2. **Process restart:** Companion token is persisted, but revision counters restart from zero. Phone rejects a valid lower-revision snapshot from the new process. A fresh server-instance identifier must distinguish epochs, preserving same-instance monotonic ordering.
3. **Unhandled promise rejection:** `void task.finally(...)` produces a rejected *new* promise when `resyncConnection` fails, even if callers handle the original task.
4. **SSE subscription gap:** the handler builds a snapshot before subscribing to `tokio::watch`; a publish between those operations may be missed. Concurrent publishers also need serialized snapshot/revision/broadcast order.
5. **Transport status and commands:** avoid reporting a successful live stream until SSE opens; bound reconnect with backoff, stop automatic retry when hidden/offline/expired/unmounted. Keep request-id retries for idempotent actions; do not automatically duplicate potentially non-idempotent AI/prompt actions across process restarts.

## Minimal change plan

- Backend: include a non-secret `controls.instanceId` in Companion snapshots, subscribe to watch before building the first SSE snapshot, bind SSE subscriptions to the server instance, serialize publishes and avoid logging token-bearing URLs.
- Phone: retry failed initial connections and corrupted/closed streams with capped exponential backoff; cancel timers on lifecycle transitions; restore by GET state first and then SSE; accept lower revisions only when the instance ID changes. Keep transport errors visible and avoid unhandled promise rejections.
- Add targeted unit/contract tests for revision epochs and retry lifecycle, plus real native Tauri HTTP/SSE E2E covering state, streaming, disconnect/re-enable and current desktop/phone parity.
- Maintain existing token authentication, port fallback and Cursor identity challenge. Never probe alternate ports using the bearer token; if a restart changes LAN port the user needs a fresh QR.

## Acceptance

1. Full frontend Vitest/typecheck/build plus real native Linux Tauri/WebDriver and Rust library tests pass at the exact PR head.
2. A dropped network/desktop server recovers without reload **when the endpoint returns on the same URL**; expired credentials do not retry forever.
3. No stale snapshots after server instance replacement, no initial-subscription event gap, no silent unscheduled reconnect failure.
4. Any constraints that cannot be exercised (real mobile background suspension, Wi-Fi switching, hours-long hardware soak, OS installer) are disclosed rather than marked PASS.
