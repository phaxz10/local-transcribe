# Model Catalog: quantized ladder capped at large-v3-turbo, language-badged, conservatively fit-checked

**2026-09 update:** the ladder is no longer Whisper-only — `small.en` was removed for producing no usable transcript and the English slot is now `onnx-community/parakeet-ctc-0.6b-ONNX`, a non-autoregressive CTC model that cannot repetition-loop (see [`research-asr-2026-09`](../research-asr-2026-09.md), row 10).

**Status:** partially superseded by [ADR-0007](./0007-switch-to-transformers-js.md). The Catalog is now **ONNX models loaded by HF id** (WebGPU/WASM), not ggml. The "WASM 4 GB ceiling" reasoning below applied **only** to whisper.cpp-WASM and was over-broad — `medium` and `large-v3-turbo` (quantized) run fine; only *full* large-v3 was ever the real limit. The device-adaptive **Recommended Model** and **Fit-check** principles still hold (Fit-check now gates on WebGPU + storage).

The Catalog offers one **quantized (`q5_1`) ladder** — tiny / base / small / medium (+ `.en` variants) and **large-v3-turbo** — and **deliberately excludes full `large-v3`**, whose ~4 GB runtime exceeds the **WASM32 ~4 GB address-space ceiling** per tab (it literally can't run in-browser). The **Recommended Model** is computed per device from three inputs: the **Fit-check** (conservative static RAM ceilings — ~2 GB mobile / ~3 GB desktop, refined by `deviceMemory` when present — plus a `storage.estimate()` quota check), a **minimum benchmark ×RT** (won't recommend something that runs below realtime), and the user's declared **Primary Language** (prefer `.en` for English; multilingual turbo otherwise). Each entry carries a **Language Profile** rendered as badges + per-language quality dots, curated from Whisper's published per-language WER.

## Consequences

- Answers "why isn't the best/full model here?" — `large-v3` full can't fit WASM32.
- Recommendations vary by device + language and may **under-offer on strong hardware** — accepted as the price of never crashing mid-job.
- **Cantonese / Tagalog are badged "limited"** honestly. Specialist fine-tunes would markedly improve them but require ggml conversion + self-hosting (a partial walk-back of ADR-0004/hotlink), so they are **reserved in the schema, excluded from v1**.
- Catalog entries need hand-curated language metadata — there is no way to infer a model's per-language quality from its file.
