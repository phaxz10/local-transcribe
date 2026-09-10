# Transcript is two layers: an immutable ASR layer + a derived edit layer

**Status:** accepted

A Transcript keeps the original transcription (Segments → Words with start/end + confidence) as an **immutable ASR Layer**, and represents user corrections as a derived **Edit Layer** that maps each edited Word back to its origin. In-place fixes are 1:1; structural edits (insert / split / merge) interpolate timing from neighbours; a full-segment retype falls back to that Segment's timing. Chosen so we never lose original timings or confidence.

## Considered Options

- **Single mutable model** — overwrite text+timing, discard original. Simpler, but loses confidence and makes raw-vs-corrected export impossible.
- **Text-free, timing anchored at Segments** — sidesteps reconciliation but edited Segments lose word-level precision.

## Consequences

- Editor mutations never touch the ASR Layer; they write to the Edit Layer with a pointer to origin Word(s).
- **Confidence survives editing** → we can highlight low-confidence Words to direct the user's attention. Near-free, high-value.
- Exports take a parameter: **raw (ASR) or corrected (Edit)**, defaulting to corrected.
- Inserted Words carry interpolated timing explicitly flagged **approximate** — we never fake precision we don't have.
- The ASR Layer also carries an optional **`timing`** (`'word'` | `'chunk'` | `'interpolated'`) recording how its word times were obtained, so a model that emits no timestamps at all can still populate the layer honestly ([ADR-0016](./0016-timestamp-free-models.md)).
- Costs a second layer + a mapping to maintain; trivial next to audio/model size, so accepted.
- Future speaker labels and re-alignment have a stable, immutable base to attach to.
