# Speaker turns from pauses, with manual assignment; clustering later

**Status:** accepted — phase A of proposal item 3 in [`docs/research-asr-2026-09.md`](../research-asr-2026-09.md), builds on [ADR-0005](./0005-transcript-two-layer-model.md)

A **Turn** is a run of Segments separated from the previous run by a pause of at least **1.0 s**, measured on the VAD speech regions when the pass ran (`AsrLayer.speech`) and on word times otherwise. Turns are computed on demand by a pure function (`src/lib/turns.ts`), never stored. A **Speaker** is a user-owned `{ name }` in `TranscriptRecord.speakers`, referenced by the already-reserved `EditSegment.speakerId`. **Dialog mode** is an opt-in toggle that mints `spk_1` / `spk_2` and alternates them turn by turn as an explicit starting guess; the user fixes wrong ones by clicking a Segment's Speaker label, which applies forward until the next Segment that already carries a different Speaker.

## What this does *not* claim

- **No speaker identification.** Nothing here listens to a voice. Two turns by the same person get different Speakers unless the user says otherwise, and alternating labels are a guess about *conversation shape*, not about *who*. The UI says so ("Alternates speakers at each pause; fix any wrong ones by clicking the label").
- **No overlapping speech, no more than two guessed Speakers, no mid-Segment speaker change.** The user can create as many Speakers as they like by hand, but the automatic pass only ever alternates two, and assignment is per Segment.
- **Not a diarization quality bar.** There is no DER to report because there is no model. Phase B — `pyannote-segmentation-3.0` + `wespeaker-voxceleb-resnet34-LM` + agglomerative clustering, ~35 MB, gated on the `high` capability tier — is where an accuracy claim becomes possible.

## Why this first

The research doc's own recommendation: the WASM-safe fallback is "80% of the usability for 2.2 MB and about half a day of work", and it is also the honest UX when clustering confidence is low, so it is what phase B degrades *to* rather than throwaway scaffolding. Shipping it now also proves out every piece phase B needs — the `speakers` map, the label UI, the export shapes, undo over speaker changes — against real transcripts, leaving clustering as the only unknown when it lands.

1.0 s rather than the doc's ~700 ms because `buildAsrLayer` already cuts Segments at gaps over 0.8 s: at 700 ms nearly every Segment boundary would also be a turn boundary, which is noise, not structure.

## Consequences

- `TranscriptRecord.speakers` is **optional**, so every transcript written before this loads and exports unchanged. An empty map is normalized back to absent.
- The time machine now steps `{ edit, speakers }` together (`EditSnapshot`), so a rename or a dialog-mode toggle undoes like any other edit. `commitEdit(edit, speakers?)` leaves the map alone when the second argument is omitted, and clears it when given an empty one.
- `AsrLayer.speech` carries the VAD regions onto the record so turn detection can measure a real pause instead of word-time jitter. Word times always sit *inside* a padded region, so regions can only tighten a gap, never widen it — the fallback is strictly the more generous of the two.
- Segment memoization ([ADR-0009](./0009-transcript-render-isolation.md)) survives: the label depends only on `seg.speakerId`, a `showSpeaker` boolean the parent computes from the row above, and the `speakers` map — all passed as props, all in the row comparator. Nothing subscribes to the playhead.
- Turning dialog mode **off** clears hand-made assignments too. That is one undo away, and the alternative (tracking which assignments were guessed) is state we would then have to reconcile with every edit.
- Exports gain a Speaker prefix **only where the Speaker changes**: `Name: ` for TXT and SRT, `**Name:** ` for Markdown, a `<v Name>` voice span for VTT. JSON needed no change — it serializes the whole record, so `speakerId` and `speakers` come along.
