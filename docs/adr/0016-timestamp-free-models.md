# Timestamp-free models get interpolated word times

**Status:** accepted

Cohere Transcribe (`cohere_asr`) is #1 on the Open ASR Leaderboard and the same download size as our `large-v3-turbo`, but it returns **text only** — no word timestamps, no chunk timestamps, nothing. The two-layer transcript ([ADR-0005](./0005-transcript-two-layer-model.md)) is built on word times: the editor seeks to a word, exports are cued from them, and future diarization aligns to them.

**Decision:** a catalog entry may declare `timestamps: 'none'`. For those models the worker distributes the chunk's decoded text across that chunk's **speech spans**, proportionally to character count, and marks the result `timing: 'interpolated'` (`src/lib/interpolate-times.ts`). Words in no-space scripts (CJK, kana) are cut into runs of at most 4 characters first, so segments still form. `buildAsrLayer` records `timing` on the ASR layer, `deriveEditLayer` stamps every `EditWord.timing` as `'interpolated'`, and `TranscriptView` says so in one muted line. The same `timing` field carries `'chunk'` when a Whisper export without cross-attentions makes us fall back to chunk timestamps.

## Considered Options

- **Refuse timestamp-free models.** Cheapest, but it costs the best-accuracy tier we can actually run in a browser.
- **One word, one whole chunk.** Honest, but it destroys the segment structure the editor and exports need.
- **Forced alignment against a second model.** Correct, and a whole extra ONNX model plus an alignment implementation. Not now.

## Consequences

- Seek-to-word is **approximate** for these models. Times drift within a span whenever speech rate varies; they never drift *outside* it, because words are laid out inside speech regions only, never across the silence between them.
- Word timings are only as good as the spans. Today the "speech span" is the whole chunk (there is no VAD in the worker yet), so a chunk that is half silence spreads its words over that silence. Wiring Silero VAD (proposal item 1 of `docs/research-asr-2026-09.md`) makes these times materially better with no change to this code — it just supplies real regions.
- SRT/VTT cues from an interpolated transcript are usable for reading along, not for frame-accurate subtitling.
- Diarization alignment against an interpolated layer would be meaningless; a diarizer must skip or refuse `timing: 'interpolated'` records.
- `AsrLayer.timing` is optional in the zod schema so transcripts recorded before this ADR still load.
