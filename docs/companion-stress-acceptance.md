# Companion stress and real UI recovery acceptance

Baseline: `508b64a316a520382ff7fa5757987de4d33d35cf` (merged PR #7). This work does not change PR #8, authentication, STT providers, LLM providers, or recording architecture.

## Reproduced gap

The existing native transport E2E covers one transcript, HTTP/SSE parity, reconnect and socket revocation. The mobile component tests use mocked fetch/EventSource. Neither proves the rendered mobile page remains usable during a large message burst or after malformed snapshots.

The old snapshot guard accepts missing `live`, null timeline entries and invalid nested arrays, while the feed dereferences these fields. Local execution of the exact main source reproduced the feed exception and rejection of subsequent healthy lower-revision snapshots. The new guard also checks live timestamps and duplicate message IDs before acknowledging the revision. This does not imply that the Rust server normally emits malformed data.

## Implementation and limits

1. Native WebDriver coverage of the built Companion page with real browser HTTP/SSE: 300 messages, normal button clicks, dropped streams, lower-revision server restarts, stale updates and corrupted frames. A loopback-only deterministic server supplies faults; this is a real UI/network test, not proof of the Rust backend or physical phone behavior.
2. Separate native Rust Companion transport stress using the existing debug fixture: 240 accepted messages, the 200-message retention boundary, four concurrent writers, two subscribers and repeated disconnect/catch-up. Assertions compare exact retained contents and monotonic revisions. External memory ingestion is explicitly disabled; no production services or paid model calls.
3. Only snapshot fields dereferenced by the mobile feed are strengthened, preserving optional/unknown fields and existing valid snapshots. Targeted validation regressions are retained rather than a broad unit-test expansion.
4. Existing frontend/typecheck/build/Cursor and native Linux E2E must pass on the final HEAD before merge; post-merge checks are then inspected.

Initial estimate: 40–100 production lines, 350–600 test/helper lines, no new dependencies. Complexity 5/10; expected reliability benefit 8/10; pre-execution confidence 7/10 (engineering estimates, not measured results).

## Design and implementation review

- Pass 1: separate real UI + fault-injected network from real Rust transport. Do not call a mocked backend full product E2E. Reuse WebDriver and Node rather than adding Playwright.
- Pass 2: bound all waits and streams, bind test servers to loopback, close sockets/timers in finally blocks, do not log bearer tokens, do not retry failed tests to disguise regressions. Compare eventual complete snapshots rather than expecting watch/SSE to deliver every intermediate revision.
- Pass 3: validate optional live timestamps before revision acknowledgement; disable external memory ingestion for native synthetic traffic; compare the complete retained fixture set after overflow. Use a direct WebDriver protocol click for an intentionally disabled button so the framework does not wait for the response barrier it is supposed to test.

## Acceptance evidence

Implementation is included in this PR. Execution results are recorded in PR #9; tests are not accepted until the exact-head checks succeed. A physical iPhone/Android, real Wi-Fi handover, multi-hour device soak, actual microphone permissions and signed installers remain separate hardware acceptance, not CI claims.
