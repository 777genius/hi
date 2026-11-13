# Companion stress and real UI recovery acceptance

Baseline: `508b64a316a520382ff7fa5757987de4d33d35cf` (merged PR #7). This work does not change PR #8, authentication, STT providers, LLM providers, or recording architecture.

## Observed gap

The existing native transport E2E covers one transcript, HTTP/SSE parity, reconnect and socket revocation. The mobile component tests use mocked fetch/EventSource. Neither proves the rendered mobile page remains usable during a large message burst or after malformed snapshots.

Code inspection also shows the snapshot guard accepts missing `live`, null timeline entries and invalid nested arrays, while the feed dereferences these fields. Reproduce before changing the guard; do not label an unrun test PASS.

## Plan and limits

1. Add native WebDriver coverage of the built Companion page with real browser HTTP/SSE, bounded message bursts, normal button clicks, dropped streams, lower-revision server restarts, stale updates and corrupted frames. A loopback-only deterministic server supplies faults; this is a real UI/network test, not proof of the Rust backend or physical phone behavior.
2. Add a separate native Rust Companion transport stress scenario using the existing debug fixture: multiple subscribers, repeated bursts and disconnect/catch-up, with exact final message IDs/counts and monotonic revisions. No production services or paid model calls.
3. Strengthen only the snapshot fields dereferenced by the mobile feed, preserving optional/unknown fields and existing valid snapshots. Keep targeted validation regressions, not a broad unit-test expansion.
4. Run existing frontend/typecheck/build/Cursor and native Linux E2E on the final HEAD; inspect logs, review twice, merge only when green, and inspect post-merge checks.

Estimated changes: 40–100 production lines, 350–600 test/helper lines, no new dependencies. Complexity 5/10; expected reliability benefit 8/10; pre-execution confidence 7/10 (engineering estimates, not measured results).

## Design review passes

- Pass 1: separate real UI + fault-injected network from real Rust transport. Do not call a mocked backend full product E2E. Reuse WebDriver and Node rather than adding Playwright.
- Pass 2: bound all waits and streams, bind test servers to loopback, close sockets/timers in finally blocks, do not log bearer tokens, do not retry failed tests to disguise regressions. Compare eventual complete snapshots rather than expecting watch/SSE to deliver every intermediate revision.

## Acceptance evidence

Pending implementation and execution. A physical iPhone/Android, real Wi-Fi handover, multi-hour device soak, actual microphone permissions and signed installers remain separate hardware acceptance, not CI claims.
