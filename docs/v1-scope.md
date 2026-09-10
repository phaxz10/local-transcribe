# Local Transcribe — v1 Scope & Build Plan

Local-first, in-browser speech-to-text. All transcription runs on the user's device; audio/transcripts never leave the tab. See [`CONTEXT.md`](../CONTEXT.md) for the glossary and [`docs/adr/`](./adr) for the locked decisions.

## Locked architecture (ADRs)

1. **Transformers.js (ONNX + WebGPU)** — ADR-0007 (supersedes ADR-0001). WebGPU with WASM fallback; models loaded by HF id, incl. custom Sideload-by-id.
2. **ffmpeg.wasm** for audio/video → 16 kHz mono PCM (ADR-0002).
3. **Download-only** model provisioning from a curated **Catalog**, hotlinked from HuggingFace (CONTEXT.md; ADR-0006).
4. **Cache API** for model/core blobs, **IndexedDB** for metadata + history.
5. **Capability is estimated, not gated** — benchmark ETA + adaptive Recommended Model; only hard block is **Fit-check** (ADR-0003).
6. **Two-layer Transcript** — immutable ASR layer + derived Edit layer (ADR-0005).
7. **No backend, zero telemetry**, content-scoped privacy (ADR-0004).

## v1 scope

**In:** model-first onboarding · device-adaptive Catalog with language badges · model download w/ progress · **cancellable Download + per-model Evict + Active-Model switching** (from the reused Catalog — ADR-0008) · Sideload-by-id (any ONNX HF model) · file upload → ffmpeg decode → streaming transcription · two-layer transcript + editor (in-place fix, delete, insert, merge/split, find-&-replace) · word highlight + click-to-seek playback (**isolated highlight, memoized segments** — ADR-0009) · exports (TXT/SRT/VTT/JSON/MD, raw|corrected) · local history (transcript-only) · live mic mode · PWA installable + offline app shell · COI via dev headers + our own `public/sw.js` for prod · **resumable Download** (Range prefetch into the engine cache — ADR-0008).

**Out (reserved):** speaker diarization · on-device AI summary · subtitle burn-in · re-timing (drag boundaries) · pre-bundled specialist language models (Sideload-by-id already covers BYO ONNX) · transcript windowing/virtualization (shipped instead as `content-visibility: auto` per Segment, which keeps every node findable — ADR-0009) · true download resume (**shipped**: `src/lib/download.ts` prefetches each file with HTTP Range and seeds `transformers-cache` — ADR-0008).

## Screen flow

1. **Landing** — privacy-forward hero → "Get started".
2. **Capability preflight** (silent) — detect SAB/threads/cores/memory/storage → Capability Tier; warn unsupported browsers.
3. **Onboarding / Catalog** (model-first) — Primary Language toggle → device-adaptive **Recommended Model** (size + sample ETA) + alternatives w/ language badges; Fit-check guards; download w/ progress → cached.
4. **Workspace** — tabs: **Upload a file** | **Live mic**.
5. **Transcript** — streaming segments → editor (highlight, click-to-seek, edit ops, find/replace) → export.
6. **History** — local list; reopen/edit/delete; wipe-all (incl. cached models).

## Build order (tracer slices)

1. Scaffold + COI + theme + UI primitives.
2. Types/zod schemas (two-layer model, catalog, capability).
3. Capability detection + Fit-check + benchmark.
4. Catalog + onboarding + model download (Transformers.js) → **first model cached**.
5. File pipeline: ffmpeg decode → engine → streaming → ASR layer → render. **First transcript.**
6. Editor + exports.
7. History (IDB).
8. Live mic.
9. PWA + the COI/offline service worker (`public/sw.js`). Build, browser smoke-test, fix.
10. **Bug-fix pass** — cancellable Downloads + per-model Eviction + Active-Model switching (ADR-0008); Transcript render isolation + memoized Segments + react-scan dev profiler (ADR-0009).

## Catalog spec

`parakeet-en` (`onnx-community/parakeet-ctc-0.6b-ONNX`, English, CTC so it cannot loop) · multilingual `small` · `small-yue` (`onnx-community/whisper-small-cantonese-ONNX`, `yue: 3`, `forceLanguage: 'chinese'`, the Cantonese pick since turbo is rated `yue: 0`) · `cohere-transcribe` (WebGPU, no word timings, manual pick) · `large-v3-turbo` (WebGPU-gated). Tiny/base tiers were dropped after real meeting audio exposed repetition loops; `small.en` was dropped in 2026-09 for producing no usable transcript. Quantization is per-device (`fp16`/`q4` on WebGPU, `q8` on WASM; Parakeet is a single-file export at `q4f16`/`int8`), with per-hfId overrides. Each entry: `{ id, hfId, label, sizeMb, ramCeilingMb, requiresWebGPU, multilingual, forceLanguage?, timestamps?, languages: {en,zh,ja,yue,tl,…quality} }`. Recommended = best that passes Fit-check ∧ WebGPU-gate ∧ Primary Language (a language with a rating-3 model in reach raises the quality floor to 2).

## Acceptance criteria

- Loads cross-origin-isolated (`crossOriginIsolated === true`) in dev.
- Onboarding downloads a model with visible progress; survives reload (cached).
- A short clip transcribes end-to-end with streaming segments + timestamps.
- Transcript is editable; edits persist; exports produce valid TXT/SRT/VTT/JSON.
- History reopen works; wipe-all clears storage.
- No network calls carry audio/transcript content (only HF model fetch).

## Known stubs / risks

- WebGPU is the fast path (ADR-0007); WASM is the CPU fallback. Per-token confidence isn't exposed by the engine, so the low-confidence highlight is inert (ADR-0007).
- Safari: nested-worker/threads + missing `deviceMemory` → best-effort.
- PWA offline + COI can't be two service workers, so `public/sw.js` does both: it stamps COOP/COEP on every response and cache-first-serves a build-stamped app-shell precache (`/`, `/assets/*`, `/ffmpeg/*`), leaving HuggingFace weights to the engine's own cache.
- Live mic uses a rolling-window approximation; full VAD endpointing deferred to its own branch.
