# Translate to English is a second MT stage, not Whisper's translate task

**Status:** accepted

"Translate to English" now means **transcribe in the source language, then machine-translate each Segment into the Edit Layer**. The ASR Layer keeps the source text, so the *raw* export is Mandarin/Japanese and the *corrected* export is English subtitles ([ADR-0005](./0005-transcript-two-layer-model.md)). Whisper's own `translate` task is no longer used anywhere; `AsrLayer.task` is always `'transcribe'`.

## Why not Whisper's translate task

It is a Whisper decoder feature and it does not survive contact with our Mandarin path:

- **`turbo-zh`** (the BELLE-2 fine-tune, our Mandarin Recommended Model) **loops** on `task: 'translate'` — the fine-tune was trained for Chinese transcription and the translate token pushes it straight into repetition-hallucination.
- **`large-v3-turbo`** silently ignores it and just transcribes, so the user gets Mandarin back after asking for English.
- `parakeet-en` has no decoder at all, `cohere-transcribe` has no translate mode, and `small-yue` is a single-language fine-tune that was never trained for it. That left exactly one model (`small`) where the switch did anything reliable — a switch that gated on the model was a promise we could not keep.

It is also structurally the wrong shape: Whisper translate only ever targets English *and* destroys the source text in the same pass, so there is nothing left for the raw layer to hold.

## The MT models

Marian (Helsinki-NLP Opus-MT) through `pipeline('translation', id, { dtype: 'q8' })` on Transformers.js 4.2.0, device `wasm` always — these are ~75 M-param int8 graphs where GPU dispatch overhead would dominate the arithmetic.

| Pair | HF id | Size (q8) |
|---|---|---|
| `zh-en` | `Xenova/opus-mt-zh-en` | 113 MB (encoder 52.9 + merged decoder 60.2 + tokenizer/config) |
| `ja-en` | `Xenova/opus-mt-ja-en` | ~108 MB (58 + 50) |

Measured: three sentences in 0.2 s on CPU. Batched 8 texts per `generate` call, `max_new_tokens = min(256, 4 × longest source character count + 16)`.

**One browser-only gotcha**: the q8 export loads fine under onnxruntime-**node** but onnxruntime-**web**'s extended QDQ pass rejects it outright —

> `Can't create a session. ERROR_CODE: 1 … qdq_actions.cc:137 TransposeDQWeightsForMatMulNBits Missing required scale: model.shared.weight_merged_0_scale`

so the pipeline is created with `session_options: { graphOptimizationLevel: 'basic' }`, which skips that whole family of rewrites. On a 77 M-param Marian the lost fusions cost nothing measurable, and the alternative is the ~310 MB fp32 graph. Don't drop that option when touching `loadMt`; it is the difference between working and not loading at all.

## Fallback: NLLB-200

Opus-MT only covers the pairs someone bothered to train, and the Xenova ONNX set has no `tl-en` and no `yue-en` at all. So **`Xenova/nllb-200-distilled-600M`** (`q8`: `onnx/encoder_model_quantized.onnx` 419 MB + `onnx/decoder_model_merged_quantized.onnx` 475 MB, ~900 MB all in) is the fallback for every language without one, and `TranslationPair` gains a fourth value, `'nllb'`.

It is one multilingual graph, so it has to be told both ends of the direction: the request carries a **FLORES-200 `srcLang`** (`tgl_Latn`, `spa_Latn`, …) and the pipeline is called with `{ src_lang, tgt_lang: 'eng_Latn' }`. `TRANSLATION_SOURCES` in `translation.ts` is the whole table — code, Whisper language name, English label, FLORES code — and it is what the source-language picker renders, so adding a language is one row.

Opus-MT keeps `zh`, `ja` and `ko`: 113 MB and three sentences in 0.2 s beats 900 MB and a much slower decode, and the quality on those three is not the problem.

**Cantonese moves to NLLB.** `yue_Hant` was actually trained on written Cantonese; routing `yue` through `opus-mt-zh-en` only ever worked because Whisper flattens Cantonese into written Chinese, and it lost every Cantonese-specific particle in the process. The extra 800 MB buys a translation that is right instead of merely plausible, and it is only downloaded by the users who ask for it.

NLLB shares `currentMt`, now keyed by **model id** rather than by pair, and it batches **4** texts per `generate` (against Marian's 8) because it is eight times the parameters and the pipeline pads to the longest member. `graphOptimizationLevel: 'basic'` stays set for both — it costs nothing measurable and it is what makes the Marian q8 export load at all.

Because every non-English language now has a direction, the transcript toolbar offers **"Translate to English" on every non-English transcript**, and **"Translate again"** on one already translated (the same action; it overwrites the Edit Layer through `commitEdit`, so Undo restores). When the record's own language is `auto` — the user picked Other / Mixed — there is no source to translate *from*, so a compact source-language `Select` appears beside the button and the button waits for a pick. The Transcribe screen's Translate switch is hidden for `auto` for the same reason, with a note pointing at the transcript.

## Consequences

- The Translate switch gates on the **language**, not the Transcription Model. Any model that can transcribe a non-English language can now be translated, including the ones that could never do Whisper translate.
- The MT pipeline lives in **its own worker slot** (`currentMt`), separate from the ASR Engine, so switching Transcription Model does not evict a Marian that is about to translate that run's output. `dispose` clears both.
- **Timings are interpolated per Segment**: English word order does not line up with the source, so each translated Segment's words are spread across that Segment's own span, `origin: null`, `timing: 'interpolated'`. Seeking lands on the right Segment, not the right word. `interpolateWords` ([ADR-0016](./0016-timestamp-free-models.md)) does the spreading, unchanged.
- An **empty translation keeps the source words** for that Segment. A gap in the MT output must never silently delete a line of the transcript.
- Translation can be applied to an **existing** transcript from the editor (`translateRecord`), which goes through the normal undo stack — Undo puts the source-language Edit Layer *and* the missing `translation` note back.
- The MT models are **not prefetched** by `download.ts`. Only the subset of users who turn Translate on want them, and Transformers.js fetches them fine on its own — which matters much more for NLLB's 900 MB than it did for Marian's 113.
- Old records with `asr.task === 'translate'` still load; the header note now keys on `record.translation`, so they read as ordinary transcripts.

