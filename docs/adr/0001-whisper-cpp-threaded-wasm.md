# Inference runs in-browser via whisper.cpp compiled to threaded WASM

**Status:** superseded by [ADR-0007](./0007-switch-to-transformers-js.md) — the engine is now Transformers.js (ONNX + WebGPU). Retained for history.

We transcribe entirely on the client. The inference engine is **whisper.cpp compiled to WebAssembly with pthreads (SIMD + multi-threaded)**, using the same ggml `.bin` model files (and q5/q8 quantizations) as the desktop pipeline. Threading requires `SharedArrayBuffer`, which requires cross-origin isolation: we serve `COOP: same-origin` + `COEP: require-corp` headers where we control them, and ship a service worker (`public/sw.js`) that injects them as a fallback so the app still gets isolation (and thus multi-core speed) on header-less static hosts like GitHub Pages.

## Considered Options

- **Transformers.js (ONNX, WASM+WebGPU)** — least glue code and unlocks WebGPU, but pulls us into ONNX models and a higher-level abstraction. Rejected in favour of full control and parity with the ggml models/pipeline we already understand.
- **Custom WebGPU engine (whisper-turbo / ratchet)** — fastest on modern GPUs but narrowest browser support and the most code to maintain. Deferred; may return as an optional second engine.

## Consequences

- We are committing to **CPU execution**. whisper.cpp has no production-ready in-browser WebGPU backend, so we forgo the large WebGPU speedup. A future "WebGPU engine" is an explicit, additive escape hatch — not a v1 concern.
- **COEP constraint:** every cross-origin resource (fonts, analytics, images, embeds) must send CORP/CORS or it will fail to load. The app must stay self-hosted and dependency-light. This reinforces the "no third-party data" positioning as a happy side effect.
- A Service Worker now has a *legitimate, non-compute* role: injecting isolation headers and PWA offline caching (both in `public/sw.js`) — distinct from the Web Worker that runs inference.
