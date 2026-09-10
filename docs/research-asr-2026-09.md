# ASR model & diarization research (2026-09-10)

Scope: what `local-transcribe` should run in a browser tab, with no backend, through
`@huggingface/transformers` v4.2.0 (ONNX Runtime Web, WebGPU + WASM fallback), for **en / zh / yue
/ ja / tl / mixed**. Constraints taken from [`ADR-0007`](./adr/0007-switch-to-transformers-js.md)
and `src/lib/engine.worker.ts` (`dtypeFor`: fp32 encoder + q8 decoder on WASM, fp16 encoder + q4
decoder on WebGPU; hand-rolled repetition guard; `return_timestamps: 'word'`).

Every HuggingFace id below was verified to return HTTP 200 from
`https://huggingface.co/api/models/<id>` on 2026-09-10. Ids that did **not** resolve are called out
so nobody re-adds them. File sizes are read from the HF blob API, not estimated.

---

## The three findings that matter most

1. **`@huggingface/transformers` v4.2.0 is the newest release that exists.** npm `dist-tags.latest`
   is `4.2.0`, published 2026-04-22; there is no 4.3 and no 4.2.x patch
   ([npm](https://www.npmjs.com/package/@huggingface/transformers),
   [GitHub releases](https://github.com/huggingface/transformers.js/releases)). Section 5 is
   therefore short: there is nothing to upgrade to, and every gap we work around by hand is still
   a real gap today, not a stale-version artifact.
2. **The catalog is missing the two model families that would actually move the needle**:
   `cohere_asr` (Cohere Transcribe, Apache-2.0, #1 on the Open ASR Leaderboard, first-class
   transformers.js support) and the Cantonese-specialist small models. Whisper is *bad* at
   Cantonese — 14.6% CER for large-v3 on MDCC against 5.7% for a 130M-parameter Cantonese
   Conformer that is 135 MB on disk.
3. **Diarization in-browser is cheap and unblocked.** The whole stack — pyannote segmentation
   (6.0 MB), a WeSpeaker embedder (26.5 MB), Silero VAD (2.2 MB) — is ~35 MB of ONNX, all
   loadable by the library we already ship, all MIT/permissive. The missing piece is clustering,
   which is ~200 lines of JS.

---

## 1. Candidate table

**Verdict:** the useful frontier moved from "which Whisper size" to "which *dedicated* ASR
architecture". Three of the four models that beat Whisper large-v3 at a fraction of the size
(Cohere Transcribe, Parakeet CTC, SenseVoice) are reachable from this app today — two through
transformers.js directly, one only through a sherpa-onnx WASM build we do not have. Gemma 4 E4B is
in the table only to show the shape we are avoiding.

Legend for **Engine**: `tjs` = loads today via `pipeline('automatic-speech-recognition', ...)` in
v4.2.0; `tjs-raw` = architecture is supported as a model class but is not in the pipeline's
`model_type` switch; `sherpa` = needs a sherpa-onnx WASM build beside transformers.js; `none` = no
browser path exists.

The v4.2.0 ASR pipeline dispatches on `model_type` and accepts exactly:
`whisper`, `lite-whisper`, `wav2vec2`, `wav2vec2-bert`, `unispeech`, `unispeech-sat`, `hubert`,
`parakeet_ctc`, `moonshine`, `cohere_asr`
(`packages/transformers/src/pipelines/automatic-speech-recognition.js` @ tag 4.2.0). Anything else
throws.

| # | Model id | Released | Params | Usable size (dtype) | Languages | ONNX | Engine | WebGPU | Word timestamps | WER/CER (source) | Browser caveats |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | [`onnx-community/cohere-transcribe-03-2026-ONNX`](https://huggingface.co/onnx-community/cohere-transcribe-03-2026-ONNX) | 2026-03-26 | 2B (>90% in the Conformer encoder) | q4f16 enc 1.44 GB + dec 98 MB ≈ **1.53 GB**; q4 enc 2.02 GB + dec 109 MB | 14: en de fr it es pt el nl pl ar vi **zh ja** ko | yes, official | **tjs** (`cohere_asr`) | yes (official WebGPU [Space](https://huggingface.co/spaces/CohereLabs/Cohere-Transcribe-WebGPU)) | **no — model has none** | **4.67** avg WER, Open ASR Leaderboard, 2026-09 snapshot ([results dataset](https://datasets-server.huggingface.co/rows?dataset=hf-audio/open-asr-leaderboard-results)); 5.42 at launch vs whisper-large-v3 7.44 ([Cohere Labs blog](https://huggingface.co/blog/CohereLabs/cohere-transcribe-03-2026-release)) | No timestamps, **no diarization, no language auto-detect**, and the card explicitly says it hallucinates on silence and "benefits from prepending a noise gate or VAD". No yue, no tl. Base repo `CohereLabs/cohere-transcribe-03-2026` is gated; the ONNX mirror is **not** |
| 2 | [`onnx-community/whisper-large-v3-turbo_timestamped`](https://huggingface.co/onnx-community/whisper-large-v3-turbo_timestamped) *(shipping)* | 2024-10 base | 809M | fp16 enc 1.27 GB + q4 dec 334 MB ≈ **1.6 GB** | 99 | yes | tjs | yes (required in practice) | **yes** (`output_attentions=True` export) | 6.36 avg WER / RTFx 791 (leaderboard); FLEURS Cantonese 43.3% CER vs large-v3 10.5% ([vocova 2026](https://vocova.app/blog/ai-transcription-accuracy-benchmark-2026)) | Turbo is *far worse than large-v3 on Cantonese* — a 4× CER regression. Open issues on this export's word timings: [transformers.js#1357](https://github.com/huggingface/transformers.js/issues/1357), upstream [transformers#37248](https://github.com/huggingface/transformers/issues/37248) |
| 3 | [`Xenova/whisper-small`](https://huggingface.co/Xenova/whisper-small) / [`.en`](https://huggingface.co/Xenova/whisper-small.en) *(shipping)* | 2022 | 244M | fp32 enc 353 MB + q8 dec 157 MB ≈ **510 MB** | 99 / en | yes | tjs | yes | yes | FLEURS: en 6.6 WER, ja 16.4 CER, zh 19.5 CER, **yue unsupported** ([vocova](https://vocova.app/blog/ai-transcription-accuracy-benchmark-2026)); LibriSpeech fp32 3.48/11.88 ([arXiv 2511.08093](https://arxiv.org/html/2511.08093v2)) | Not on the Open ASR Leaderboard at all any more. `onnx-community/whisper-small_timestamped` is an identical-size drop-in with an explicit cross-attention export if the Xenova one ever regresses |
| 4 | [`onnx-community/whisper-medium_timestamped`](https://huggingface.co/onnx-community/whisper-medium_timestamped) | 2025-12-16 | 769M | fp16 enc 615 MB + q4 dec 469 MB ≈ **1.08 GB** | 99 | yes | tjs | yes | yes | — | Previously tried and dropped. Only new evidence is that a *timestamped* export now exists; nothing says quality improved. Leave out |
| 5 | [`distil-whisper/distil-large-v3.5-ONNX`](https://huggingface.co/distil-whisper/distil-large-v3.5-ONNX) | 2025-03 | 756M | ~1.1 GB at fp16/q4 (repo is 14.8 GB across all dtypes) | **en only** | yes | tjs | yes | yes | **5.40** avg WER / RTFx 879 (leaderboard) — better than large-v3-turbo's 6.36 | This is genuinely new evidence versus the distil-v3 that was dropped: v3.5 now *beats* turbo on the leaderboard and is ~1.5× faster on long-form. English-only, so it can only replace `small.en`, at 2× the download |
| 6 | [`onnx-community/lite-whisper-large-v3-turbo-ONNX`](https://huggingface.co/onnx-community/lite-whisper-large-v3-turbo-ONNX) | 2025 | <809M | — | 99 | yes | tjs (`lite-whisper`) | yes | **no** ([open discussion](https://huggingface.co/onnx-community/lite-whisper-large-v3-turbo-ONNX/discussions/1)) | no published number found | Low adoption, no timestamps, no WER. Skip |
| 7 | [`moonshine-ai/moonshine-streaming-small`](https://huggingface.co/moonshine-ai/moonshine-streaming-small) (Moonshine v2) | 2026-02-10 | **123M** | 561 MB fp32 safetensors; community int8 ONNX 358 MB ([`Mazino0/...`](https://huggingface.co/Mazino0/moonshine-streaming-small-onnx)) | en | community only | **none** (`moonshine_streaming` not in the switch) | — | no | **7.84** avg over the 8 Open-ASR sets; medium (245M) **6.65**, tiny (34M) 12.01 ([model card](https://huggingface.co/moonshine-ai/moonshine-streaming-small)) | This is the model to want and cannot have: 123M params at whisper-large-v3-turbo accuracy. New architecture, no `onnx-community` export, not in transformers.js. **Watch item #1** |
| 8 | [`moonshine-ai/moonshine-streaming-tiny-tl`](https://huggingface.co/moonshine-ai/moonshine-streaming-tiny-tl) | 2026-08-24 | 27M | 108 MB fp32 | **tl** | no | none | — | no | card reports best score 16.600, "flat around 17.16" | The only Tagalog-first model found anywhere. The card says outright: *"a snapshot of a run that had not finished"*, Stage A, refresh expected. Not shippable, but this is the first real sign Tagalog is coming |
| 9 | [`onnx-community/moonshine-base-zh-ONNX`](https://huggingface.co/onnx-community/moonshine-base-zh-ONNX) · [`-ja-`](https://huggingface.co/onnx-community/moonshine-base-ja-ONNX) | 2026-02-15 / 02-04 | 61M | q8 enc 20.7 MB + merged dec 42.8 MB = **63.5 MB**; fp32 247 MB | zh / ja | yes, official | **tjs** (`moonshine`) | yes | no | **no published number** — both cards are the empty auto-generated template | Moonshine v1 was dropped for English, but these are *new, language-specific* Feb-2026 models at 1/8 the size of whisper-small. Zero published evidence either way. Worth a 1-day A/B, not a blind ship |
| 10 | [`onnx-community/parakeet-ctc-0.6b-ONNX`](https://huggingface.co/onnx-community/parakeet-ctc-0.6b-ONNX) | 2025-10-14 | 600M | int8 **612 MB**, q4f16 **454 MB**, fp16 1.22 GB | **en only** | yes, official | **tjs** (`parakeet_ctc`) | yes | via CTC frame alignment (`return_timestamps: true`) | base `nvidia/parakeet-ctc-0.6b`: 1.87 WER LibriSpeech-clean | Non-autoregressive CTC ⇒ **structurally cannot loop**. That alone makes it attractive after the tiny/base repetition disaster. English-only. CC-BY-4.0 |
| 11 | [`nvidia/parakeet-tdt-0.6b-v3`](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) | 2025-08 | 600M | int8 ~630 MB (community exports) | **25 European languages** — no zh/yue/ja/tl | community ([`istupakov/...-onnx`](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx)) | none / sherpa (buggy) | via `parakeet.js` | — | **4.86** avg WER, RTFx 6076 (leaderboard) | transformers.js has no TDT/RNN-T decode loop ([issue #1310](https://github.com/huggingface/transformers.js/issues/1310), open). sherpa-onnx's WASM build crashes on Parakeet TDT ([sherpa-onnx#2200](https://github.com/k2-fsa/sherpa-onnx/issues/2200)). **Wrong languages anyway** |
| 12 | [`nvidia/canary-1b-v2`](https://huggingface.co/nvidia/canary-1b-v2) | 2025-08 | 978M | — | 25 European | community (`istupakov`) | none | — | — | 5.71 avg WER (leaderboard) | No CJK, no Tagalog. Not applicable |
| 13 | [`FunAudioLLM/SenseVoiceSmall`](https://huggingface.co/FunAudioLLM/SenseVoiceSmall) → [`csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09`](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09) | 2024-07; yue-tuned 2025-09 | 234M | **int8 237 MB single file** (fp32 938 MB) | **zh · yue · ja · ko · en** | yes (sherpa layout) | **sherpa** | no (WASM only) | no | Cantonese CER: MDCC **5.43**, CommonVoice-yue **6.87**, HK 8.68 ([WSYue-ASR leaderboard](https://huggingface.co/ASLP-lab/WSYue-ASR)) vs whisper-large-v3 14.63 / 12.85 / 16.36 | The single best language-coverage-per-megabyte model in this table and it maps exactly onto our five languages. Blocked only by "we don't have a sherpa-onnx WASM engine". SenseVoice's own licence tag is ambiguous — check before shipping |
| 14 | [`csukuangfj/sherpa-onnx-wenetspeech-yue-u2pp-conformer-ctc-zh-en-cantonese-int8-2025-09-10`](https://huggingface.co/csukuangfj/sherpa-onnx-wenetspeech-yue-u2pp-conformer-ctc-zh-en-cantonese-int8-2025-09-10) | 2025-09-10 | **130M** | **int8 135 MB** | yue + zh + en | yes | **sherpa** | no | CTC alignment | MDCC **5.73**, CV-yue **7.72**, WSYue-eval-short 5.05 ([leaderboard](https://huggingface.co/ASLP-lab/WSYue-ASR)) | Converted from [`ASLP-lab/WSYue-ASR`](https://huggingface.co/ASLP-lab/WSYue-ASR) (WenetSpeech-Yue, 21.8 kh Cantonese corpus), Apache-2.0. **135 MB beats a 1.6 GB Whisper by 2.5× on Cantonese CER.** Best small model in this document |
| 15 | [`csukuangfj/sherpa-onnx-fire-red-asr-large-zh_en-2025-02-16`](https://huggingface.co/csukuangfj/sherpa-onnx-fire-red-asr-large-zh_en-2025-02-16) ([base](https://huggingface.co/FireRedTeam/FireRedASR-AED-L)) | 2025-02 | 1.1B | int8 enc 1.29 GB + dec 446 MB = **1.74 GB** | zh + en | yes | sherpa | no | no | AISHELL-1 0.55 CER, WenetSpeech-Net 4.88 — but **Cantonese MDCC 34.53**, CV-yue 43.93 ([WSYue leaderboard](https://huggingface.co/ASLP-lab/WSYue-ASR)) | Superb Mandarin, useless Cantonese, 1.74 GB, WASM-only. Apache-2.0. Not worth the engine |
| 16 | [`Qwen/Qwen3-ASR-0.6B`](https://huggingface.co/Qwen/Qwen3-ASR-0.6B) / [`1.7B`](https://huggingface.co/Qwen/Qwen3-ASR-1.7B) | 2026-01-29 | 0.6B / 1.7B | 1.88 GB safetensors (0.6B) | 30 langs **incl. Cantonese** + 22 Chinese dialects | community only, unvetted | none | — | — | `Qwen3-ASR-1.7B-hf` **4.31** avg WER (leaderboard) | Apache-2.0, genuinely strong, genuinely relevant languages — and there is no `onnx-community` export and no transformers.js `model_type`. **Watch item #2** |
| 17 | [`onnx-community/Voxtral-Mini-3B-2507-ONNX`](https://huggingface.co/onnx-community/Voxtral-Mini-3B-2507-ONNX) | 2025-07 | 3B + audio tower | q4f16: audio 384 MB + embed 252 MB + decoder **2.07 GB** ≈ **2.7 GB** | 8 (no zh/yue/ja/tl) | yes | tjs-raw | yes (demo exists) | no | 5.54 avg WER (leaderboard) | 2.7 GB download for languages we don't target. [`Voxtral-Mini-4B-Realtime-2602-ONNX`](https://huggingface.co/onnx-community/Voxtral-Mini-4B-Realtime-2602-ONNX) adds zh/ja but is ~2.9 GB at q4f16 and not in the ASR pipeline switch |
| 18 | [`onnx-community/mms-1b-all-ONNX`](https://huggingface.co/onnx-community/mms-1b-all-ONNX) | 2025-09-09 | 1B | q4f16 **571 MB**, int8 970 MB | 1000+ **incl. tgl + yue** | yes, official | **tjs** (`wav2vec2`) | yes | CTC alignment | mms-1b-fl102 FLEURS mean WER 39.8 over 102 languages (not per-language) | The only *loadable* Tagalog path in this document. Two problems: `facebook/mms-*` is **CC-BY-NC-4.0**, and per-language adapter selection (`target_lang`) is not something the transformers.js ASR pipeline exposes. Needs a spike before it's a plan |
| 19 | [`microsoft/Phi-4-multimodal-instruct-onnx`](https://huggingface.co/microsoft/Phi-4-multimodal-instruct-onnx) | 2025-02 | 5.6B | int4 GPU build only | multi | yes, but CUDA/DirectML | **none** | no | no | 6.14 avg WER at release | The ONNX export targets ONNX Runtime GenAI on CUDA/DirectML, not WASM or WebGPU-web. Not feasible, full stop |
| 20 | [`ibm-granite/granite-speech-5.0-470m-turboctc`](https://huggingface.co/ibm-granite/granite-speech-5.0-470m-turboctc) | **2026-08-25** | **470M** | 946 MB fp32 safetensors | en | none yet | none (`granite_speech5_ctc`) | — | CTC alignment | **5.04** avg WER at **RTFx 12,945** — the fastest model on the leaderboard | Non-autoregressive CTC, Apache-2.0, explicitly aimed at "laptops, smartphones and edge devices". Needs `transformers>=5.16.0`; no ONNX export exists 2 weeks after release. **Watch item #3** |
| 21 | [`onnx-community/whisper-small-cantonese-ONNX`](https://huggingface.co/onnx-community/whisper-small-cantonese-ONNX) ([base](https://huggingface.co/alvanlii/whisper-small-cantonese)) | 2025-09-19 | 244M | fp32 enc 353 MB + q8 merged dec 315 MB = **668 MB**; q4f16 enc 54 MB + dec 145 MB = **199 MB** | **yue** | yes, official | **tjs** | yes | not exported with cross-attn — expect the chunk-timestamp fallback | CV17 **7.93 CER** (no punct) / 9.72 (punct) ([card](https://huggingface.co/alvanlii/whisper-small-cantonese)); third-party per-domain CER 8.0–25.6 ([cantonese_asr_eval](https://github.com/AlienKevin/cantonese_asr_eval)) | The only Cantonese model that drops into the current engine with zero new infrastructure. Weak on code-switching (25.6% CER) — which is exactly what Cantonese meetings are |
| 22 | [`khleeloo/whisper-large-v3-cantonese`](https://huggingface.co/khleeloo/whisper-large-v3-cantonese) | 2024 | 1.55B | no ONNX export | yue | **no** | none | — | — | CV17 7.26, CV15 8.77 ([card](https://huggingface.co/khleeloo/whisper-large-v3-cantonese)) | Would need self-export via Optimum. `alvanlii/whisper-largev3-cantonese` **does not resolve** — do not cite it. [`JackyHoCL/whisper-large-v3-turbo-cantonese-yue-english`](https://huggingface.co/JackyHoCL/whisper-large-v3-turbo-cantonese-yue-english) exists but its claimed 0.64% CER is not credible (prior checkpoint: 8.86%) |
| 23 | [`onnx-community/kotoba-whisper-bilingual-v1.0-ONNX`](https://huggingface.co/onnx-community/kotoba-whisper-bilingual-v1.0-ONNX) | 2025-08-06 | 756M | q4f16 enc 370 MB + dec 164 MB = **534 MB**; fp16 1.27 GB + 239 MB | **ja + en** | yes, official | tjs | yes | probably not (no `_timestamped`) | v2.0 CER: CommonVoice-8 9.2, JSUT 8.4, ReazonSpeech **11.6** vs whisper-large-v3 14.9 ([card](https://huggingface.co/kotoba-tech/kotoba-whisper-v2.0)) | Beats whisper-large-v3 on in-domain Japanese at half the size and ~6× the speed; loses slightly on CommonVoice. A real Japanese upgrade over `whisper-small` (16.4 CER) |
| 24 | [`BELLE-2/Belle-whisper-large-v3-turbo-zh`](https://huggingface.co/BELLE-2/Belle-whisper-large-v3-turbo-zh) | 2024 | 809M | **no ONNX** | zh | no | none | — | — | AISHELL-1 3.07 / WenetSpeech-meeting 13.36 vs stock turbo 8.64 / 20.31 ([card](https://huggingface.co/BELLE-2/Belle-whisper-large-v3-turbo-zh)) | A 24–64% relative CER win over the turbo we already ship, for Mandarin — but somebody has to export it. Cheapest self-export in this document |
| 25 | [`LWobole/whisper-small-tagalog`](https://huggingface.co/LWobole/whisper-small-tagalog) | 2026 | 244M | no ONNX | tl | no | none | — | — | WER 16.66 on its own eval (FLEURS `fil_ph` only) | Trained on FLEURS alone; almost certainly worse than stock Whisper on real Tagalog. Not recommended |
| 26 | [`google/gemma-4-E4B-it`](https://huggingface.co/google/gemma-4-E4B-it) — **comparison only** | 2026-07-02 | 4.5B effective / **8B with embeddings**; ~300M audio encoder | **15.99 GB** single bf16 safetensors; LM Studio ships ~5.9 GB quantized | 140+ | **none** | **none** | — | no | FLEURS **0.080** (E2B 0.090; 12B 0.069 ex-Chinese), CoVoST 35.54 BLEU ([card](https://huggingface.co/google/gemma-4-E4B-it)) | See below |

### Why Gemma 4 E4B is the wrong shape here, concretely

The steer is right and the numbers make it obvious.

- **Download.** 15.99 GB bf16, ~5.9 GB in a good quantization. Our current heaviest catalog entry is
  1.6 GB and we already gate it behind WebGPU. Cache Storage on iOS Safari is evicted aggressively
  and the quota is a fraction of that; a 6 GB first-run download is not a product.
- **Memory.** 8B parameters *with* embeddings and a **262,144-token vocabulary**. The embedding
  table alone at q4 is larger than all of whisper-small. On WebGPU the whole weight set must fit in
  GPU buffers; on WASM it must fit in a 32-bit `ArrayBuffer` address space that tops out near 4 GB.
  The 4 GB WASM ceiling makes the fallback path structurally impossible, so there is no graceful
  degradation — the model either has WebGPU with several GB of VRAM or it does not run.
- **Decode speed.** Whisper emits ~1 token per word from a 4-layer (turbo) decoder. Gemma 4 E4B is
  a 42-layer general decoder over a 262K vocabulary, so every output token costs one full pass
  through a 4.5B-parameter transformer plus a 262K-wide logit projection. For a one-hour meeting
  that is tens of thousands of decoder passes against Whisper's cheap cross-attention decode. On
  WASM that is not slow, it is hours.
- **Shape mismatch.** The card caps audio at **30 seconds per clip** and delivers ASR via a
  prompt ("Transcribe the following speech segment…"). We would be paying 8B parameters of coding
  and reasoning capacity to run a 30-second window at a time, with no timestamps, no VAD, and no
  way to stop it from answering instead of transcribing.
- **And it isn't even better.** FLEURS 0.080 for E4B is roughly Whisper-large-v3-class multilingual
  accuracy. Cohere Transcribe's 2B — 10× smaller, encoder-heavy, purpose-built — beats it and runs
  in the browser today.

The lesson generalizes: for this app the winning shape is **encoder-heavy, decoder-light**
(Cohere Transcribe puts >90% of parameters in the encoder; Parakeet and SenseVoice are
non-autoregressive entirely). Audio-in LLMs are the opposite shape.

---

## 2. Per-language × per-device matrix

**Verdict:** on WebGPU we have a good answer for en/zh/ja today and a mediocre one for yue; on
WASM-only devices Whisper-small is the ceiling and it is genuinely bad at zh (19.5 CER),
ja (16.4 CER) and unusable for yue. Tagalog has no good answer on any device.

Realtime factors are marked **not measured** where no source publishes one. There is no credible
public in-browser WASM-vs-WebGPU RTF number for Whisper — HF's own claim is a generic "up to 100×
faster than WASM" from the [v3 announcement](https://huggingface.co/blog/transformersjs-v3), not a
Whisper measurement. The app already has a `benchmark` message in
`engine.worker.ts`; that is where real numbers should come from.

| Language | WebGPU laptop | Download | WASM-only / phone | Download |
|---|---|---|---|---|
| **en** | `distil-large-v3.5-ONNX` (5.40 WER) if we accept English-only; else keep `large-v3-turbo_timestamped` | ~1.1 GB / 1.6 GB | `Xenova/whisper-small.en` — unchanged. `parakeet-ctc-0.6b-ONNX` q4f16 is the loop-proof alternative | 510 MB / 454 MB |
| **zh** (Mandarin) | **Cohere Transcribe** (no timestamps) or `large-v3-turbo` (8.0 CER FLEURS) | 1.53 GB / 1.6 GB | `whisper-small` is poor (19.5 CER). `moonshine-base-zh-ONNX` is 63 MB and untested — the only cheap experiment available | 510 MB / 63 MB |
| **yue** (Cantonese) | `whisper-small-cantonese-ONNX` (7.93 CER) beats `large-v3-turbo` (43.3 CER) at 1/8 the size. **Do not use turbo for Cantonese** | 199 MB q4f16 | same model, fp32-encoder variant | 668 MB |
| **ja** | `kotoba-whisper-bilingual-v1.0-ONNX` (11.6 CER ReazonSpeech) or `large-v3-turbo` (5.8 CER FLEURS) | 534 MB / 1.6 GB | `whisper-small` (16.4 CER) or `moonshine-base-ja-ONNX` at 63 MB, unmeasured | 510 MB / 63 MB |
| **tl** (Tagalog) | `large-v3-turbo` (no published number), or `mms-1b-all-ONNX` if the NC licence and adapter problem are solved | 1.6 GB / 571 MB | `whisper-small` multilingual. Honestly: unknown quality, no benchmark exists | 510 MB |
| **mixed / code-switch** | `large-v3-turbo` with `language: undefined`. Cohere Transcribe is explicitly **bad** here ("inconsistent performance on code-switched audio", no auto-LID) | 1.6 GB | `whisper-small` multilingual | 510 MB |

Honest gaps in this table:
- **No published Tagalog WER for any Whisper size.** OpenAI's FLEURS appendix has one; it could not
  be extracted from the PDF, and no reproduction publishes it. Treat every Tagalog claim as untested.
- **No Cantonese number for `whisper-small` at all** — the vocova benchmark lists it as
  "not supported". Our catalog currently rates `yue: 1` for it, which is generous.
- **RTF for every row is unmeasured in-browser.**

---

## 3. Small models under ~300 MB that beat `whisper-small`

**Verdict:** four exist, and three of them are for our exact non-English languages. The catch is
that the two strongest need a sherpa-onnx WASM engine we do not have.

| Model | Size | Beats `whisper-small` at | Evidence |
|---|---|---|---|
| **WenetSpeech-Yue u2pp Conformer CTC** (`sherpa-onnx-wenetspeech-yue-...-int8-2025-09-10`) | **135 MB** | Cantonese, by a mile. MDCC 5.73 CER vs whisper-large-v3's 14.63 (small doesn't support yue) | [WSYue-ASR leaderboard](https://huggingface.co/ASLP-lab/WSYue-ASR), Apache-2.0 |
| **SenseVoice-Small yue-tuned int8** | **237 MB** | zh, yue, ja and ko simultaneously. MDCC 5.43, CV-yue 6.87, and per the third-party [cantonese_asr_eval](https://github.com/AlienKevin/cantonese_asr_eval) it beats Cantonese-finetuned Whisper on 5 of 6 domains (code-switch 9.05% vs 25.57%) | WSYue leaderboard + cantonese_asr_eval |
| **`whisper-small-cantonese-ONNX` at q4f16** | **199 MB** | Cantonese, and it loads in the current engine unchanged | CV17 7.93 CER |
| **`moonshine-base-zh` / `-ja-ONNX` at q8** | **63.5 MB** | unknown — 8× smaller than whisper-small, official onnx-community export, `moonshine` is in the pipeline switch | **no published WER.** Cards are empty templates. This is a cheap experiment, not a claim |

Two more that are under 300 MB *as weights* but not reachable:
`moonshine-streaming-small` (123M params, 7.84 avg WER — better than large-v3-turbo) has no
transformers.js support; `granite-speech-5.0-470m-turboctc` (5.04 WER, RTFx 12,945) has no ONNX
export.

Note on quantization, since the engine's `dtypeFor` policy rests on it: the peer-reviewed
measurement ([arXiv 2511.08093](https://arxiv.org/html/2511.08093v2), Table 2) confirms *dynamic*
int8 on whisper-small costs ~0.24 WER on test-clean and ~1.8 on test-other versus fp32, while
static quantization costs 2.5 WER. On GPU, dynamic int8 actually *beat* fp32 (3.41 vs 3.48). The
current fp32-encoder/q8-decoder split is the right call and now has a citation.

---

## 4. Multi-speaker diarization in the browser

**Verdict:** buildable now, ~35 MB of extra weights, ~4–6 days of work, and it slots into the
existing worker without a second engine. `EditSegment.speakerId` is already reserved in
`src/lib/types.ts`.

### Components

| Component | Id | Size | Engine | Numbers | Licence |
|---|---|---|---|---|---|
| Segmentation | [`onnx-community/pyannote-segmentation-3.0`](https://huggingface.co/onnx-community/pyannote-segmentation-3.0) | **6.0 MB** fp32 / 3.0 MB fp16 / 1.5 MB int8 | transformers.js `AutoModelForAudioFrameClassification` + `processor.post_process_speaker_diarization()` | pyannote 3.1 full pipeline DER: AMI-IHM 18.8, DIHARD3 21.4, VoxConverse 11.2 ([pyannote.ai](https://www.pyannote.ai/blog/how-to-evaluate-speaker-diarization-performance)) — the ONNX segmentation model alone is one stage of that | MIT, **ungated** |
| Speaker embedding | [`onnx-community/wespeaker-voxceleb-resnet34-LM`](https://huggingface.co/onnx-community/wespeaker-voxceleb-resnet34-LM) | **26.5 MB** fp32 / 13.3 fp16 / 6.7 int8 | transformers.js / onnxruntime-web | no ONNX-parity EER published — do not quote a number | permissive |
| VAD | [`onnx-community/silero-vad`](https://huggingface.co/onnx-community/silero-vad) | **2.2 MB** / 0.6 MB int8 | onnxruntime-web direct | Silero v6.0 claims 16% fewer errors on noisy audio than v5 ([release](https://github.com/snakers4/silero-vad/releases/tag/v6.0)) | MIT |
| Clustering | — | 0 | ~200 lines of JS | agglomerative with cosine distance, threshold or fixed-k | — |

Rejected alternatives:
- **`pyannote/speaker-diarization-3.1` and `community-1`** — gated on HF, and pyannote ≥3.1
  deliberately *dropped* onnxruntime. Only the segmentation sub-model is mirrored in ONNX. Not usable.
- **`nvidia/diar_sortformer_4spk-v1`** (123M end-to-end, DIHARD3 DER 14.76) — ONNX export is
  broken by dynamic slicing ([NeMo #14733](https://github.com/NVIDIA-NeMo/NeMo/issues/14733)),
  it is **CC-BY-NC-4.0**, and it caps at 4 speakers. No.
- **sherpa-onnx offline diarization** — real, with a working
  [WASM Space](https://huggingface.co/spaces/k2-fsa/web-assembly-speaker-diarization-sherpa-onnx)
  that bundles the same pyannote segmentation model plus a 3D-Speaker ERes2Net embedder. But it
  requires a custom Emscripten build (there is no browser npm package — `sherpa-onnx@1.13.7` on npm
  is the Node addon, no `browser` field), and it publishes no DER. Same models, much more plumbing.
- **transformers.js `pipeline('speaker-diarization')`** — does not exist. The task list in v4.2.0
  has no diarization, no VAD, no audio-frame-classification pipeline
  ([issue #322](https://github.com/huggingface/transformers.js/issues/322) closed without one).
  The model-class path is what works.

### Recommended architecture, inside `engine.worker.ts`

Diarization is a *second pass over the same PCM*, run after transcription, never interleaved —
this keeps the single-engine-slot invariant in `loadEngine` intact.

1. **VAD sweep** — Silero VAD over the full Int16 PCM at 16 kHz, 512-sample frames. Produces speech
   regions. Cost is trivial (2.2 MB model, ~1 ms per second of audio). *This is worth shipping on
   its own, ahead of diarization* — see §5.
2. **Transcribe** — unchanged, except chunks are cut on VAD boundaries instead of a blind 25 s grid.
3. **Segment** — pyannote-segmentation-3.0 over sliding 10 s windows with 1 s hop, on speech regions
   only. Output is powerset logits over ≤3 concurrent speakers per frame; `post_process_speaker_diarization`
   turns them into local turns.
4. **Embed** — for each turn longer than ~0.5 s, run WeSpeaker on that slice → one 256-d vector.
   Typical meeting: a few hundred embeddings.
5. **Cluster** — agglomerative clustering with cosine distance over the embeddings. Threshold when
   speaker count is unknown; fixed-k when the user supplies it. Emit a global `speakerId` per turn.
6. **Align** — for each `AsrWord`, assign the `speakerId` of the diarization turn with maximum
   temporal overlap with `[word.start, word.end]`. This is the whisperX / `whisper-diarization`
   pattern, and it is the only sane approach given our word timestamps already exist. Ties and
   overlapping speech resolve to the higher-overlap turn; overlap-speech words get one speaker,
   which is a known limitation of the approach, not a bug in ours.
7. **Write** — set `EditSegment.speakerId`, re-splitting an `EditSegment` where the speaker changes
   mid-segment.

### Cost estimate

- **Extra download:** 35 MB fp32, 9 MB if we take int8 on all three. Against a 510 MB–1.6 GB model
  download this is noise.
- **Extra memory:** all three models together are smaller than one Whisper decoder layer. Peak stays
  dominated by the ASR model.
- **Extra time:** no source publishes a browser diarization-vs-transcription ratio; anyone who tells
  you a number is guessing. Structurally: segmentation is a 6 MB CNN over the whole file
  (one pass, cheap), embedding is a 26 MB ResNet run a few hundred times (also cheap), clustering is
  O(n²) over a few hundred vectors (milliseconds). Expect **well under the transcription cost**, but
  measure it via the existing `benchmark` path before promising anything in the UI.
- **Effort: 4–6 days.** ~1 day VAD + chunk-boundary integration, ~2 days segmentation + embedding +
  clustering in the worker, ~1 day the word→speaker alignment and the `EditSegment` split, ~1–2 days
  UI (speaker labels, rename, colour) and the WASM fallback.

### WASM-safe fallback

On low-tier devices, or if the two extra models blow the RAM ceiling, degrade to
**VAD-pause turn-splitting**: run Silero VAD only (2.2 MB), treat any silence gap longer than
~700 ms as a candidate speaker turn, and label turns `Speaker A / B / …` alternately with no
identity claim — plus let the user merge and rename turns in the editor. This gets 80% of the
usability (paragraph breaks at turn boundaries, per-turn labels the user can fix) for 2.2 MB and
about half a day of work. Ship this first; it is also the honest UX when clustering confidence is low.

---

## 5. Decode-quality gains without changing models

**Verdict:** there is no library upgrade available, and the two biggest wins left are ours to build:
VAD-gated chunking, and keeping the repetition guard we already have.

**Library upgrade: not available.** `4.2.0` is npm `latest`, published 2026-04-22, and no release
has shipped in the ~4.5 months since
([npm](https://www.npmjs.com/package/@huggingface/transformers),
[releases](https://github.com/huggingface/transformers.js/releases)). For the record, the recent
history is v4.0.0 (2026-03-30, native C++ WebGPU execution provider, monorepo, `ModelRegistry`),
v4.1.0 (Gemma 4 support, new `q1`/`q2`/`q1f16`/`q2f16` dtypes), v4.2.0 (tool calling). Nothing
ASR-related since v3.8.0. v4.2.0 pins `onnxruntime-web@1.26.0-dev.20260416` — a nightly, which is
worth knowing when debugging ORT behaviour.

**The Python fallback thresholds are still absent.** Grepping the repo at tag 4.2.0 for
`compression_ratio_threshold`, `logprob_threshold`, `no_speech_threshold`,
`condition_on_prev_tokens` and `temperature_fallback` returns **zero hits in source, issues and
PRs**. `WhisperGenerationConfig` has none of them and `generate()` has no re-decode loop. Nobody has
even filed a request. The hand-rolled `looksDegenerate` + `no_repeat_ngram_size` + single
temperature escalation in `transcribeOne` is not a stopgap — it is the only implementation that
exists in this ecosystem. Keep it, and keep the comment explaining why.

**`prompt_ids` does not work.** `WhisperGenerationConfig.prompt_ids` is declared with full JSDoc,
but in `modeling_whisper.js` the destructure is literally commented out (`// prompt_ids = null,`),
so passing it is a silent no-op.
[PR #1540](https://github.com/huggingface/transformers.js/pull/1540) implements it (a ~20-line
change closing [#923](https://github.com/huggingface/transformers.js/issues/923) and
[#1028](https://github.com/huggingface/transformers.js/issues/1028)) and has been **open and
unmerged since 2026-02-22**. So an "initial prompt / vocabulary hints" feature — jargon, names,
Cantonese romanizations — is not available without patching or vendoring. Given the PR is small
and the upstream repo is quiet, vendoring it is defensible if the feature is wanted; it is not
available off the shelf.

**VAD-gated chunking is the real win, and it is ours to build.** The maintainers explicitly declined
to add VAD ([issue #821](https://github.com/huggingface/transformers.js/issues/821): they mirror
Python `transformers` and will not add what isn't there), and pointed instead at running
`onnx-community/silero-vad` as a separate model — the pattern used in HF's own
[moonshine-web Space](https://huggingface.co/spaces/webml-community/moonshine-web). For us it
replaces two weaker heuristics at once:

- `hasDetectableSignal` is a raw peak threshold at 26/32768. It passes room tone, HVAC and mic
  self-noise straight into Whisper, which is exactly the condition that produces hallucinated text
  from silence.
- `MANUAL_CHUNK_SECONDS = 25` cuts on a blind grid, so roughly every chunk boundary lands
  mid-word. Whisper then has to recover context it cannot see, and the boundary is where repetition
  loops most often start.

Cutting chunks at VAD-detected pauses fixes both: no silence-only chunk is ever decoded, and every
chunk starts and ends at a real speech boundary. 2.2 MB, one extra ONNX session, and it is a
prerequisite for both diarization (§4) and for any AED model whose card warns about silence
(Cohere Transcribe's does, explicitly).

**Other decode knobs available in v4.2.0** and worth a pass: `max_new_tokens: 160` is currently a
fixed per-25 s-chunk cap; dense Mandarin or fast English can exceed it and get truncated. Moonshine's
card suggests a duration-proportional token limit (`6.5 tokens/second`) as an anti-hallucination
device — the same idea, scaled to chunk length, would be safer than a constant.

---

## 6. Proposal

Ranked by (user-visible impact) ÷ (cost × risk). Opinionated.

### 1. Ship Silero VAD gating — *do this first*

**Change:** load `onnx-community/silero-vad` (int8, 0.6 MB) alongside the ASR model in the worker.
Replace `hasDetectableSignal` with a VAD pass, and cut `plannedChunks` on speech boundaries instead
of a 25 s grid.
**Impact:** fewer hallucinated lines on quiet passages, fewer repetition loops at chunk seams,
less wasted compute on silence (a meeting recording that is 30% silence gets ~30% faster).
**Download:** +0.6–2.2 MB. **Risk:** low; it is additive and the current behaviour is the fallback.
**Effort:** ~1 day.

### 2. Fix Cantonese — add `onnx-community/whisper-small-cantonese-ONNX`

**Change:** add one catalog entry, `yue: 3`, `hfId: 'onnx-community/whisper-small-cantonese-ONNX'`,
q4f16 on WebGPU (199 MB) / fp32-encoder on WASM (668 MB). Simultaneously **drop `large-v3-turbo`'s
`yue` rating from 2 to 0** so `recommendModel` stops steering Cantonese users at it.
**Impact:** the single largest quality change available. Turbo scores 43.3% CER on FLEURS Cantonese;
this model scores 7.93% on CommonVoice-yue. Today a Cantonese user gets the worst model in the
catalog because it is ranked highest by family.
**Download:** 199 MB — *less* than whisper-small. **Risk:** medium-low. The export has no
cross-attention, so word timestamps degrade to chunk timestamps; `transcribeOne` already handles
this (the `/cross attentions|output_attentions/i` retry), but it means Cantonese transcripts have
coarser timing. Code-switched Cantonese-English is its weak spot (25.6% CER).
**Effort:** ~0.5 day plus verification on real audio.

### 3. Diarization MVP — VAD turns first, clustering second

**Change:** as §4. Phase A ships the VAD-pause turn heuristic and the `speakerId` plumbing through
`EditSegment` and the editor UI. Phase B adds `pyannote-segmentation-3.0` +
`wespeaker-voxceleb-resnet34-LM` + agglomerative clustering, gated on the `high` capability tier.
**Impact:** "who said what" is the top missing feature for meeting audio and the reason people fall
back to cloud tools.
**Download:** +2.2 MB (phase A), +35 MB (phase B). **Risk:** medium — clustering quality is the
unknown, which is exactly why phase A ships a user-correctable fallback first.
**Effort:** ~1.5 days phase A, ~3–4 days phase B.

### 4. Add Cohere Transcribe as the WebGPU accuracy tier for en / zh / ja

**Change:** add `onnx-community/cohere-transcribe-03-2026-ONNX`, `requiresWebGPU: true`,
`dtype: 'q4f16'` (1.53 GB), `languages: { en: 3, zh: 3, ja: 3, yue: 0, tl: 0 }`, marked
"no word-level timings".
**Impact:** #1 on the Open ASR Leaderboard (4.67 avg WER vs 6.36 for our turbo), Apache-2.0,
official transformers.js support, at **the same download size as `large-v3-turbo`**. For English,
Mandarin and Japanese it is a straight upgrade.
**Risk: this is the highest-risk item and the reason it is fourth.** The model has **no timestamps
at all**, no diarization, no language auto-detection. Our two-layer transcript
([ADR-0005](./adr/0005-transcript-two-layer-model.md)) is built on word timings; supporting a
timestamp-free model means interpolating word times across the chunk span, which degrades the
editor's seek-to-word behaviour and breaks the diarization alignment in §4. It also needs the VAD
of item 1 to be safe against silence.
**Effort:** ~1 day for the catalog + dtype work, ~2 days for honest timestamp interpolation and a
UI affordance that says timings are approximate. **Do item 1 first, and do not ship this without
the interpolation.**

### 5. Self-export the two fine-tunes that only lack an ONNX build

**Change:** run Optimum exports of `BELLE-2/Belle-whisper-large-v3-turbo-zh` (Mandarin: 24–64%
relative CER improvement over the stock turbo we ship) and optionally
`khleeloo/whisper-large-v3-cantonese` (CV17 7.26 CER), publish them to a HF account, and add them
via the existing sideload-by-id path.
**Impact:** meaningful Mandarin and Cantonese gains with no new engine and no new architecture.
**Download:** same class as turbo (~1.6 GB). **Risk:** low technically, but it is maintenance we own
forever, and it is a one-off offline job, not app work.
**Effort:** ~1 day per model, plus storage.

### 6. Do **not** add a sherpa-onnx WASM engine yet

The two best small models in this document — SenseVoice-yue int8 (237 MB, zh+yue+ja+ko+en) and the
WenetSpeech-Yue Conformer (135 MB, best Cantonese CER anywhere) — are behind this door, and it is
tempting. It should stay shut for now because:

- there is **no browser npm package**; `sherpa-onnx@1.13.7` ships a Node addon with no `browser`
  field, so this means maintaining a custom Emscripten build in our own CI;
- models are baked into a preloaded `.data` file rather than fetched by id, which fights
  [ADR-0008](./adr/0008-model-lifecycle-management.md)'s lifecycle and the Cache-Storage story;
- it adds a second inference runtime, a second dtype policy, a second failure mode and a second
  memory pool inside a worker built around one engine slot;
- and item 2 gets most of the Cantonese win for one catalog line.

**Revisit when** either (a) SenseVoice or the WenetSpeech-Yue Conformer gets an `onnx-community`
export that transformers.js can load, or (b) Cantonese usage justifies a whole second runtime. The
sherpa route is the *right* answer for Cantonese quality; it is just not the right answer yet.

### Watch list

| Watch | Trigger to act |
|---|---|
| **Moonshine v2 / `moonshine_streaming`** — 123M params at 7.84 avg WER, 245M at **6.65** (better than large-v3-turbo) | an `onnx-community` export **and** a `moonshine_streaming` case in the transformers.js pipeline switch |
| **`granite-speech-5.0-470m-turboctc`** — 5.04 WER at RTFx 12,945, Apache-2.0, explicitly edge-targeted | any ONNX export; released 2026-08-25 so this is plausible within months |
| **`Qwen/Qwen3-ASR-0.6B/1.7B`** — 30 languages including Cantonese and 22 Chinese dialects, Apache-2.0, 4.31 avg WER | an official ONNX export; the community ones are unvetted |
| **`moonshine-ai/moonshine-streaming-tiny-tl`** — the only Tagalog-first model that exists | the promised post-Stage-A refresh, plus an ONNX export |
| **`prompt_ids`** ([PR #1540](https://github.com/huggingface/transformers.js/pull/1540)) | merge, or a decision to vendor the 20-line patch |
| **`onnx-community/whisper-large-v3-turbo_timestamped` word timings** ([#1357](https://github.com/huggingface/transformers.js/issues/1357)) | worth re-verifying against our own output; there is an open report of incorrect word timestamps on this exact export |

### Things explicitly not recommended

`whisper-tiny` / `whisper-base` (unchanged: they loop), `whisper-medium` (a `_timestamped` export
now exists, but nothing says quality improved), Moonshine v1 English, Kyutai STT (no ONNX at any
size), Voxtral Mini 3B (2.7 GB for languages we don't target), Phi-4-multimodal (ONNX targets
CUDA/DirectML only), Canary and Parakeet TDT v3 (European languages only), Sortformer (broken ONNX
export, CC-BY-NC, 4-speaker cap), `facebook/mms-*` (CC-BY-NC-4.0 plus an unsolved adapter-selection
problem), `LWobole/whisper-small-tagalog` (FLEURS-only training), and
[`alvanlii/wav2vec2-BERT-cantonese`](https://huggingface.co/alvanlii/wav2vec2-BERT-cantonese)
(the architecture *is* in the pipeline switch, but it is 2.4 GB of fp32 safetensors with no ONNX
export and a CER of 10.27 on CommonVoice-16 yue — worse than the 199 MB Whisper fine-tune in
item 2).

Finally: **`alvanlii/whisper-largev3-cantonese` does not resolve.** That author has exactly three
Cantonese repos — `whisper-small-cantonese`, `distil-whisper-small-cantonese`,
`wav2vec2-BERT-cantonese`. Every id cited in [`docs/models.md`](./models.md) was re-checked in this
pass and all of them still resolve; that file's size and device columns are what has gone stale,
not its ids.
