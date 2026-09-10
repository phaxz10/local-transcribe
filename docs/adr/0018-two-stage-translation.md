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

Cantonese (`yue`) maps to `zh-en` as an explicit best effort: there is no `yue-en` Marian model, and Whisper writes Cantonese speech out as written Chinese anyway, which is what `opus-mt-zh-en` reads.

**Tagalog has no pair at all** — no `Xenova/opus-mt-tl-en` exists — so the Transcribe screen says so plainly instead of offering a switch that would do nothing.

## Consequences

- The Translate switch gates on the **language**, not the Transcription Model. Any model that can transcribe zh/ja/yue can now be translated, including the ones that could never do Whisper translate.
- The MT pipeline lives in **its own worker slot** (`currentMt`), separate from the ASR Engine, so switching Transcription Model does not evict a Marian that is about to translate that run's output. `dispose` clears both.
- **Timings are interpolated per Segment**: English word order does not line up with the source, so each translated Segment's words are spread across that Segment's own span, `origin: null`, `timing: 'interpolated'`. Seeking lands on the right Segment, not the right word. `interpolateWords` ([ADR-0016](./0016-timestamp-free-models.md)) does the spreading, unchanged.
- An **empty translation keeps the source words** for that Segment. A gap in the MT output must never silently delete a line of the transcript.
- Translation can be applied to an **existing** transcript from the editor (`translateRecord`), which goes through the normal undo stack — Undo puts the source-language Edit Layer *and* the missing `translation` note back.
- The MT models are **not prefetched** by `download.ts`. At ~113 MB they are a fifth of the smallest ASR model, only the subset of users who turn Translate on want them, and Transformers.js fetches them fine on its own.
- Old records with `asr.task === 'translate'` still load; the header note now keys on `record.translation`, so they read as ordinary transcripts.

## The future option

**NLLB-200-distilled-600M** (`Xenova/nllb-200-distilled-600M`, ~600 MB q8) covers 200 languages including `yue_Hant` and `tgl_Latn`, and would close the Cantonese and Tagalog gaps with one model instead of one per pair. It costs 5× the download and is slower per Segment, so it is the upgrade to reach for when a second language pair is actually asked for, not the first thing to ship.
