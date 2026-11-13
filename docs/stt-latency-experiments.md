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

## Spike: Qwen3-ASR (transcribe-cpp 0.4.1, Q8_0, same clips, vacancy glossary as vocabulary)

FLEURS test, 120 clips (40 per language), M1 Max under background load:

| Model | median decode | EN | RU | UK |
|---|---|---|---|---|
| Whisper Turbo Q8 (current) | 740 ms | 4.8% | 7.3% | 7.4% |
| Qwen3-ASR 1.7B + vocabulary | 793 ms | 3.0% | 7.9% | 41.6% |
| Qwen3-ASR 1.7B, no vocabulary | 634 ms | 2.9% | 6.7% | 62.6% |
| Qwen3-ASR 0.6B + vocabulary | 481 ms | 3.9% | 11.2% | 85.0% |

Qwen is better on English, equal on Russian, but Ukrainian is not supported (garbage), the vocabulary prompt costs
~160 ms because it goes through the 1.7B language model, and with vocabulary it is not faster than Turbo.
On 9 term-dense TTS phrases: EN 0/53 errors vs 2/53, RU 6/44 vs 9/44, UK 13/42 vs 9/42 (too few to be significant).
Decision: no switch; it would need a second model for Ukrainian.

## Spike: transcribe-cpp 0.4.2 and Qwen3-ASR vs Turbo, both with the vocabulary (term-dense phrases)

60 TTS interview phrases (30 EN, 30 RU, 3.6-6.5 s, 2-5 glossary terms each, Russian terms read the Russian way),
the real glossary as vocabulary, auto language, Q8_0 models, M1 Max under load. "Corrected" WER applies the
glossary aliases to the output like the app does. Key terms: 44 in-prompt and 64 out-of-prompt occurrences in EN,
44 and 63 in RU.

| Config | median decode | WER EN / RU (corrected) | key terms in-prompt EN / RU |
|---|---|---|---|
| Turbo, 0.4.1, vocabulary (current) | 820 ms (noisy run) | 3.6% / 15.9% | 39/44, 36/44 |
| Turbo, 0.4.2, vocabulary | 739 ms | 4.3% / 16.1% | 37/44, 36/44 |
| Turbo, 0.4.2, no vocabulary | 700 ms | 6.5% / 22.8% | 30/44, 22/44 |
| Qwen3-ASR 1.7B, vocabulary | 615 ms | 6.7% / 22.8% | 35/44, 23/44 |
| Qwen3-ASR 1.7B, no vocabulary | 452 ms | 8.2% / 39.8% | 29/44, 12/44 |

- 0.4.2 only drops the "Glossary:" prefix of the Whisper prompt: 83 instead of 84 of 141 terms are dropped, i.e. one
  more term fits. Accuracy is the same within noise (3 words in EN). Not worth the bump.
- The vocabulary helps Turbo a lot (RU 22.8% -> 15.9%, EN 6.5% -> 3.6%).
- Qwen with the vocabulary is faster here (short clips) but clearly worse on terms than Turbo with the vocabulary,
  although on FLEURS (plain sentences) it was better on English. Turbo wins on term-dense speech.
- Most remaining Turbo misses are spelling variants missing from the aliases ("Sidekick", "Active Record", "Argo CD",
  "Nest JS", "Event Bridge", "Open telemetry", "C I C D"), which cost nothing to fix in the glossary.
