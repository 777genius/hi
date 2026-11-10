# Local Parakeet Ultra + utterance VAD (draft E2E plan)

## Goal and acceptance
Produce final RU/UK/EN transcript **after each utterance**, with ~700 ms candidate silence, while the desktop system-output and microphone capture remain running for 1–2 hours. Each final goes through the existing `SttProvider::on_final` → canonical Rust companion timeline → SSE/mobile projection → existing on-demand LLM prompt. Do **not** automatically call the LLM on every VAD pause.

Scope: existing Tauri/Rust app, macOS Apple Silicon first. No new backend service, no rewrite of the STT/LLM pipelines, no new memory engine or account management, no release.

## Verified existing constraints
- Audio streams are already independent services and emit mono 16 kHz PCM16. The current VAD in `VadCaptureWrapper` is attached to **system** audio only and sends one 3-second silence notification; it must not stop the recording or be reused as per-utterance commit logic.
- `WhisperLocalProvider` buffers an entire recording until stop. Instead, a local Parakeet provider must continuously accept PCM and decode completed utterances asynchronously.
- **Both** Rust `update_stt_config` and Vue Settings currently force the backend provider. Selecting local STT requires updating them together; default stays Backend.
- Existing `TranscriptionService::stop_recording*` aborts the audio processor. Ensure the final audio tail and the last worker result are not lost on Stop; avoid unbounded queues.
- `companion_timeline` is the authority for LLM context. Avoid a second frontend transcript store or mobile-only mutation.

## Minimal implementation
1. Add one macOS-aarch64 `SttProvider` adapter backed by MIT `transcribe-cpp` Rust bindings (pin an exact release). Resolve a locally installed, checksum-verified Parakeet Ultra GGUF; fail clearly when missing. No unverified downloads or silent cloud fallback.
2. Add a per-provider utterance segmenter on top of **each** audio stream: 30 ms frames, bounded pre-roll (~150 ms), silence threshold initially 700 ms, tail (~150 ms), minimum speech duration (~90 ms), max utterance (~18–25 s). Keep session open after every final. Do not confuse an utterance boundary with recording stop.
3. Run model inference on background blocking workers with independent loaded-model handles for mic and system. The current `transcribe-cpp` model has a single active-compute lease; sharing one loaded handle between two streams would return `Busy`. Buffer jobs in a bounded queue. Never block the capture callback; signal overload rather than silently losing a segment.
4. Emit **only verified final** text for offline Ultra. Add origin/timing and route through existing callbacks, SSE, and LLM context. No provisional guess masquerading as final. A genuine interim transcript requires a streaming engine in a follow-up.
5. Restore explicit provider choice in desktop Settings without breaking Backend users; use auto-language detection for local Ultra (RU/EN/UK). Keep same provider across both sources for this slice. Live model-switching only when idle; no fake runtime hot-swap.
6. Change Stop to drain queued audio when safe. Ensure all outstanding decode callbacks complete before deactivating the recording session ID. Reconnect/restart must not commit stale text into a new session.

## Test gates
- Pure segmenter tests: no speech/no noise hallucination, 600 vs 700 vs 800 ms pauses, pre-roll/tail preservation, repeated utterances, long speech force split, Stop flush, cancelled job, queue saturation.
- E2E with real local model on macOS M1 Max 32 GB: mic and system **simultaneously** playing *different* RU/UK/EN speech, overlapping turns, interruptions, noisy/quiet speech, 1–2 hour soak, 0 dropped/duplicated finals, stable RSS and latency.
- Save Settings → reopen → actual provider; Backend ↔ local switch; missing/corrupt model errors; consented recording only.
- Companion snapshot and SSE see the exact final once. Trigger AI request immediately after final and assert prompt includes latest mic+system text (including role labels), without an extra automatic LLM request.
- Record P50/P95 (speech end → final text), WER/CER per language and mixed technical vocabulary against Deepgram Nova-3. Gate on measured output, not unmeasured promises.

## Trade-offs
- **Chosen:** Parakeet Ultra + VAD as the first minimal slice (accuracy, fast offline decoding, same Rust SDK can later add Nemotron).
- **Deferred:** in-speech live provisional text, simultaneous Ultra+Nemotron, automatic AI answer trigger, cross-platform packaging, generic model marketplace.
- Need CI build/lockfile update and real Mac packaged E2E before marking ready. Draft PR is **not** proof of completion.
