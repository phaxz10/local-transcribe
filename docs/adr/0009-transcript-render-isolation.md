# Transcript rendering: isolate the playback highlight, memoize Segments, defer virtualization

**Status:** accepted — refines [ADR-0005](./0005-transcript-two-layer-model.md)

The Transcript editor kept playback time in React state and re-rendered the **entire** word list on every `timeupdate` (~4×/s), reconciling thousands of word spans per tick and dropping the UI to ~15fps on a 23-minute Transcript. We fix it by **isolating the moving highlight from the list**: the `<audio>` element stays the time source, a single rAF-throttled `activeWordId` is published through a narrow channel, the Player is split into its own subtree so its time display never touches the Transcript body, and **memoized Segment rows** mean only the 1–2 words that actually change re-render per tick. The whole Transcript stays in the DOM — **no windowing**.

## Why not virtualize

Virtualization (windowing) would cut DOM nodes, but it **breaks native Cmd-F find and select-all/copy across the whole Transcript** (only on-screen rows exist), needs variable-height measurement, and complicates scroll-to-active-word. For an *editor* where people search and select text, that UX cost isn't worth it. Crucially, the lag was re-render **frequency**, not DOM node count — so isolating the highlight alone recovers full framerate without giving up a complete, searchable, selectable document.

## Consequences

- Playback time leaves React state *for the list's purposes*; a small dedicated subscription carries only `activeWordId`. Segment rows must stay referentially stable for `React.memo` to pay off — the edit-ops already return new arrays only for the Segments that changed, which the memo relies on.
- Very long Transcripts (multi-hour) still render every node. If that ever bites, windowing returns **behind a length threshold** (the deferred option), accepting the find/select trade-off only in that extreme.
- **react-scan** is wired **dev-only** (an `import.meta.env.DEV`-guarded dynamic import, excluded from the production bundle) as the profiler we use to verify the before/after — full-tree flashes on every tick before, ~2 spans/tick after.

**Update (2026-09):** the deferred windowing is no longer needed — each Segment row carries
`content-visibility: auto; contain-intrinsic-size: auto 96px` (`.lt-segment`), so the browser skips
layout and paint for off-screen rows while every node stays in the DOM, keeping Cmd-F and
select-all across the whole Transcript.
