# Local STT latency experiments (Whisper Large-v3-Turbo, M1 Max)

Time from the end of speech to the final text is `silence endpoint (450 ms) + decode`. For Turbo
the decode is ~0.65 s and almost all of it is the encoder over a fixed 30 s window
(`TRANSCRIBE_PERF_DEBUG`: encoder 550-670 ms, cross-attention 10 ms, prompt 23 ms, 23 decoder steps ~50 ms).

| Idea | Result | Decision |
|---|---|---|
| Shorter encoder window (patched GGUF `stt.frontend.nb_max_frames`, 10-20 s) | decode 660 -> 270-420 ms, but Ukrainian WER 8.8% -> 50%, Russian 62%, long clips loop ("Продисменты Продисменты ...") | rejected |
| Turbo Q5_K_M / Q4_K_M | slower (790 / 730 ms vs 672 ms) and less accurate (WER 7.8 / 8.4 vs 7.2) | rejected, Q8_0 stays |
| `n_threads` 4 / 8, `kv_type` f16 | no change within noise (Metal does the work) | no change |
| Flash attention | already on by default in the encoder | no change |
| Smaller vocabulary / no prompt | prompt + vocabulary cost ~17-23 ms | no change |
| CoreML encoder | not built into transcribe-cpp (features: metal, cuda, vulkan, openmp) | not possible |
| Native streaming | `supports_streaming=false` for Parakeet Ultra, Whisper and Turbo | not possible |
| Speculative decode at a 150 ms pause, reused by the final when the audio is identical | Turbo final after speech end, 10 clips, mean 1.50 -> 1.25 s; Parakeet median 0.66 -> 0.57 s; final texts identical | **implemented** |
| Speculative pause 300 ms | no gain over no speculation | rejected |
| One shared model for microphone and system audio | two channels decoding at once: p50 1.35 s / p95 1.9 s with 2 copies and with 1 shared model; saves 0.9 GB | **implemented** |
