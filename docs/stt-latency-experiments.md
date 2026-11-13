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
| Thread QoS of the decoder (utility / user-initiated / none), measured on 9 clips x 4 rounds | median 691 / 675 / 666 ms: no difference, the work is on the GPU | no change |
| Turbo F16 instead of Q8_0 | median 647-663 vs 666-691 ms (3-4%), identical texts, +0.7 GB | rejected |
| transcribe-cpp 0.4.2 | only change relevant to us: vocabulary is rendered as a comma list instead of `Glossary: ...` (more terms may fit the 223-token budget); no speed changes | not adopted yet, needs an accuracy re-check |

## Spike: Whisper fine-tuned for a short encoder window (FUTO ACFT)

`MahmoudAshraf/acft-whisper-large-v3-turbo` is Turbo fine-tuned so the encoder works on a window shorter than 30 s
(the vanilla model collapses, see the table above). Converted with `scripts/convert-whisper.py` of transcribe.cpp
(the safetensors keys needed a `model.` prefix, `tokenizer.json` / `generation_config.json` came from
`openai/whisper-large-v3-turbo`), window set by patching `stt.frontend.nb_max_frames` / `n_samples` / `chunk_length`.
Language auto-detect, the vacancy glossary as vocabulary, greedy decoding, F16, M1 Max under heavy background load.

FLEURS test, 120 human-read clips of 3-13 s (40 per language):

| Model, window | median decode | WER all | EN | RU | UK |
|---|---|---|---|---|---|
| Turbo Q8 (current), 30 s | 710 ms | 6.4% | 4.8% | 7.3% | 7.4% |
| ACFT Turbo, 30 s | 676 ms | 6.9% | 4.4% | 7.7% | 9.1% |
| ACFT Turbo, 20 s | 469 ms | 7.2% | 4.7% | 8.0% | 9.6% |
| ACFT Turbo, 15 s | 368 ms | 6.8% | 4.5% | 7.7% | 8.8% |

The differences are inside the noise for 650-850 words per language; Ukrainian may be 1-2 points worse.
A clip longer than the window is chunked and goes wrong (10 s window: loops, 15 s window with a 15.1 s clip: an
invented trailing word), so a short-window model needs a fallback for long utterances.
