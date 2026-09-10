# Model Research Notes — Web Transcribe + Native Translate

As of [ADR-0012](./adr/0012-split-web-transcription-native-translation.md), the web app Catalog is **transcription-only**. The ASR notes below describe Web Transcribe candidates; the Translation and voice notes are retained as Native Translate research candidates, not browser Catalog entries.

> The hard constraint is a three-way squeeze:
> **"runs resident on the S23 Ultra"** (small/quantized, measured memory) ✕ **"Cantonese + Hokkien"** (the good models are big) ✕ **"conveys tone, not word-for-word"** (favours larger neural models / LLMs). The picks below are where those three overlap; the honest gaps are called out explicitly.

---

## 1. Transcribe (speech → text) — Whisper family

Already supported by the engine; these are Catalog drop-ins.

| Need | HF id | ~Size | Device | Notes |
|---|---|---|---|---|
| Default multilingual | `Xenova/whisper-base` · `Xenova/whisper-small` | 210 / 480 MB | WASM ok | Handles zh/ja/ko/th well at `small`+ |
| **Mandarin** | `phaxz10/belle-whisper-large-v3-turbo-zh_timestamped` | 1613 MB (`fp16`+`q4`, WebGPU) | WebGPU only | BELLE-2 fine-tune of large-v3-turbo, self-exported with cross-attentions (recipe in the export README). 24-64% relative CER improvement over stock turbo per the research doc. Chunk timestamps: its word-level alignment drifts on sub-8 s chunks. |
| **English** | `onnx-community/parakeet-ctc-0.6b-ONNX` | 612 MB (`int8`, WASM) / 643 MB (`q4`, WebGPU; the fp16 variants produce NaN logits on WebGPU) | WASM ok | Replaced `Xenova/whisper-small.en` on 2026-09, which produced no usable transcript. NVIDIA Parakeet CTC 0.6B: non-autoregressive, so it **cannot** repetition-loop. Single-file export (`onnx/model_<dtype>.onnx` + `.onnx_data`), no `generation_config.json`. v4.2.0 routes `parakeet_ctc` through the wav2vec2 branch, which returns text only — word timestamps come from our own CTC frame alignment (80 ms/frame). CC-BY-4.0 |
| Max multilingual | `onnx-community/whisper-large-v3-turbo_timestamped` | ~1.5 GB | **WebGPU only** | Desktop / high-end tier. Must be the **`_timestamped`** export (plain repo lacks cross-attentions → word timestamps throw). Load `encoder_model`=**fp16** + `decoder_model_merged`=**q4**; the fp32 encoder drags in a 2.4 GB `.onnx_data` |
| **Max accuracy, en/zh/ja** | `onnx-community/cohere-transcribe-03-2026-ONNX` | ~1.54 GB | **WebGPU only** | Not Whisper — `cohere_asr`, a 2B Conformer, Apache-2.0, #1 on the Open ASR Leaderboard (4.67 avg WER vs turbo's 6.36). Loads through the normal ASR pipeline; `dtype: 'q4f16'` for both graphs, each with one `.onnx_data` sibling, plus `processor_config.json`. **No timestamps of any kind** → word times are interpolated ([ADR-0016](./adr/0016-timestamp-free-models.md)). No language auto-detect (pass an ISO code, not a Whisper language name), no `yue`, no `tl`, and the card warns it hallucinates on silence |
| **Cantonese ASR** *(shipping, `small-yue`)* | `onnx-community/whisper-small-cantonese-ONNX` | 670 MB WASM / 409 MB WebGPU | WASM ok | ONNX export of `alvanlii/whisper-small-cantonese` (CV17 7.93% CER). Load `encoder_model`=**fp16** + `decoder_model_merged`=**q4** on WebGPU, fp32 + q8 on WASM. Tokenizer has no `<|yue|>` → send `language: 'chinese'`; no cross-attentions → chunk-level timestamps only |
| Cantonese, lower latency | `alvanlii/distil-whisper-small-cantonese` | ~330 MB | WASM ok | Distilled = faster on the S23 |
| Cantonese, max quality | `khleeloo/whisper-large-v3-cantonese` · `simonl0909/whisper-large-v2-cantonese` | ~1.5 GB | **WebGPU only** | Desktop tier |

Note: base multilingual Whisper can already do **Cantonese speech → English text** today (its `translate` task). But Whisper's translate **only ever targets English** — it can never produce English → Cantonese. That asymmetry is the whole reason Native Translate needs a real MT Model, not a Whisper flag.

---

## 2. Native Translate (text → text) — on-device MT Models

**Tier A — ship on the S23 now:**

| HF id | ~Size (quant) | Best for | Trade-off |
|---|---|---|---|
| `Xenova/nllb-200-distilled-600M` | ~600 MB (q8) | **Breadth + meaning-faithful.** 200 languages incl. Cantonese | Heaviest Tier-A pick on mobile; no explicit tone control |
| `onnx-community/Qwen2.5-0.5B-Instruct` | ~0.5 B (q4) | **Tone/register-aware + strongest CJK** (prompt "polite/casual") | Small LLM → can hallucinate on colloquial Cantonese |
| Helsinki-NLP **Opus-MT** pairs, e.g. `Xenova/opus-mt-en-zh`, `Xenova/opus-mt-zh-en` | ~75–300 MB each | **Tiny + fast** for one fixed pair | One Model per direction; weak Cantonese/Hokkien |

**NLLB FLORES-200 codes** (for whoever wires it): English `eng_Latn` · Cantonese `yue_Hant` · Mandarin `zho_Hans`/`zho_Hant` · Japanese `jpn_Jpan` · Korean `kor_Hang` · Thai `tha_Thai` · Malay `zsm_Latn`.

**Recommended default to test:** `nllb-200-distilled-600M` for coverage + reliability; offer `Qwen2.5-0.5B-Instruct` as a "more natural / tone-aware (experimental)" alternative if it fits the Native Translate resident-memory budget.

---

## 3. Speech output — Built-in Voices, not a Model

Baseline: spoken output uses the **phone's own installed voices** through native OS APIs when they are local/offline. Nothing is bundled or downloaded for the first pass. Reasons, grounded in research:

- **MMS-TTS** (Meta, ~1,100 languages) — **has no Cantonese (`yue`) voice.** It even ships Min Nan (`mms-tts-nan`) and Korean (`mms-tts-kor`), but Cantonese is a known gap.
- **Kokoro-82M** (best small browser TTS) — **English-only** today; multilingual still in progress.
- **Android / Samsung installed voices** — the most likely path that can speak Cantonese on the S23 Ultra, *if* a `zh-HK` voice is installed. Availability is per-device; cloud-backed voices must not be used for the offline product promise.

A **Voice Check** confirms what the device can speak and nudges the user to install a missing pack — the speech-side analogue of the capability/Fit-check.

---

## 4. Larger candidates — best quality, but not first target

| HF id | Why it's great | Why it's out |
|---|---|---|
| `facebook/seamless-m4t-v2-large` | Direct speech↔speech, best Cantonese, and the **only** credible **Hokkien** path (grew out of Meta's Hokkien speech-translation work) | ~2.3 B; must prove it can stay resident and responsive on the S23 Ultra native stack |

Reserved until the native app proves the resident ASR + MT baseline.

---

## 5. Coverage & honest verdicts (English ↔ target)

| Destination / language | Text MT on-device | Spoken output on-device | Verdict |
|---|---|---|---|
| Hong Kong — **Cantonese** | ✅ NLLB `yue_Hant` / Qwen | ⚠️ only via installed `zh-HK` Built-in Voice | **Ship.** Strong text; speech depends on a voice pack |
| China / Taiwan — **Mandarin** | ✅ NLLB / Qwen / Opus | ✅ common `zh-CN`/`zh-TW` voices | **Ship** |
| Japan — **Japanese** | ✅ | ✅ `ja-JP` common | **Ship** |
| Korea — **Korean** | ✅ | ✅ `ko-KR` common | **Ship** |
| Thailand — **Thai** | ✅ | ⚠️ `th-TH` varies | **Ship** (voice may need install) |
| Malaysia / Singapore — **Malay** | ✅ NLLB `zsm_Latn` | ⚠️ `ms-MY` varies | **Ship** |
| Singapore — **Hokkien / Fukkien** | ❌ no on-device MT (NLLB lacks it) | (MMS `nan` *could* speak it) | **Defer.** Route Singapore/Malaysia via Mandarin + Malay + English |

**On "not literal":** every Tier-A Model translates *meaning*, not word-for-word, so the bar is cleared. But *register/politeness* control is realistically only via **Qwen prompting** (best-effort). Fully *expressive* tone-preserving translation (SeamlessExpressive) is off-device.

---

## Sources

- [Transformers.js docs](https://huggingface.co/docs/transformers.js/index) · [Transformers.js v4 / WebGPU](https://github.com/huggingface/transformers.js/)
- MT: [`Xenova/nllb-200-distilled-600M`](https://huggingface.co/Xenova/nllb-200-distilled-600M) · [NLLB-200 (Meta)](https://ai.meta.com/research/no-language-left-behind/) · [`onnx-community/Qwen2.5-1.5B`](https://huggingface.co/onnx-community/Qwen2.5-1.5B) · Opus-MT (Helsinki-NLP)
- Cantonese ASR: [`alvanlii/whisper-small-cantonese`](https://huggingface.co/alvanlii/whisper-small-cantonese) · [`alvanlii/distil-whisper-small-cantonese`](https://huggingface.co/alvanlii/distil-whisper-small-cantonese) · [`khleeloo/whisper-large-v3-cantonese`](https://huggingface.co/khleeloo/whisper-large-v3-cantonese)
- TTS: [`facebook/mms-tts`](https://huggingface.co/facebook/mms-tts) (no `yue`) · [Kokoro TTS (Xenova)](https://huggingface.co/posts/Xenova/503648859052804)
- Off-device: [`facebook/seamless-m4t-v2-large`](https://huggingface.co/facebook/seamless-m4t-v2-large) · [Fast-SeamlessM4T-ONNX](https://github.com/fabio-sim/Fast-SeamlessM4T-ONNX)
