# Scribe by BearLog: brand brief

Scribe is the BearLog app that turns speech into notes, entirely on the device. It joins Pages,
Memories, Queue and Heimdal. This file is the source of truth for the name, the mark, the colours
and the type. Product rules of the family (from `bearlog-site` and `bearlog-pages/CONTEXT.md`):
title-case product names, sentence-case copy, no em dashes, no emojis in customer-facing copy,
named links never "Learn more", no usage numbers.

## Name

**Scribe.** Written "Scribe" on its own inside the app and "Scribe by BearLog" wherever the family
is the context (title tag, manifest, footer, share text). Host: `scribe.bearlog.app`.
One word, plain noun, like Pages, Memories and Queue. The name lives in one constant
(`src/lib/brand.ts`) so a rename is one edit.

Rejected: "Minutes" (reads as a meeting tool), "Notes" (unownable), "Dictate" (names the act,
not the result), "Transcribe" (the current working name; a verb, and every competitor's name).

## Mark

Family rule: one bear, one app-specific glyph, one app colour. Pages is the bear peeking over a
page; Memories is the bear as a play button; Heimdal is the watchman's face in a ring; Queue is
the bear on ticket amber.

**Scribe is the bear with a waveform where its mouth would be.** Same 64-unit grid, same ear and
head geometry as the Memories silhouette (`bearlog-pages/lib/brand.ts`, `MEMORIES_FAVICON`). The
eyes stay (the bars sit low enough that they do not fight at 16 px, checked at 32 px). The exact
drawing, which is the favicon verbatim:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#c05b4a"/><circle cx="17" cy="18" r="9" fill="#f1ede5"/><circle cx="47" cy="18" r="9" fill="#f1ede5"/><circle cx="32" cy="34" r="19" fill="#f1ede5"/><circle cx="25" cy="28" r="2.2" fill="#c05b4a"/><circle cx="39" cy="28" r="2.2" fill="#c05b4a"/><g fill="#c05b4a"><rect x="23" y="39" width="3" height="5" rx="1.5"/><rect x="27.5" y="36.5" width="3" height="10" rx="1.5"/><rect x="32" y="34" width="3" height="15" rx="1.5"/><rect x="36.5" y="36.5" width="3" height="10" rx="1.5"/><rect x="41" y="39" width="3" height="5" rx="1.5"/></g></svg>
```

Square margin red `#c05b4a`, bear paper `#f1ede5`, eyes and bars knocked out in the square colour.
On a dark lockup the square goes away and the bear is drawn in cream with red bars; on paper the
bear is paper-ink with red bars.

Deliverables: `public/favicon.svg` (the mark), `public/brand/scribe-avatar.svg` (1024, social),
`public/brand/lockup-horizontal.svg` (mark + "Scribe" in Archivo 800 wide, on espresso and on
paper), `public/icons/icon-192.png` and `icon-512.png` (maskable, for the manifest).

## Colour

Taken from the 2026 house tokens (`bearlog-site/src/styles/global.css`): the dark is the room,
the paper is the document.

| role | light | dark |
|---|---|---|
| background | paper `#f1ede5` | espresso `#14100c` |
| surface | `#f8f5ef` | espresso-lift `#1c1712` |
| foreground | paper-ink `#2a2118` | cream `#f1ede5` |
| muted foreground | `#6b5a41` (paper-soft `#7d6a4e` is too light for body-size text) | cream-muted `#b3a995` |
| border | paper-rule `#ddd3c2` | hairline `#372c1f` |
| primary / accent | margin red `#c05b4a` | lifted margin red `#e0786a` |
| focus ring | honey `#e3b04b` | honey `#e3b04b` |
| destructive | `#a83a2b` | `#e0786a` |

The accent is used for exactly four things: the record button, the primary action, the active
word, and the ruled margin line on the live "paper". Everything else is ink on paper.

## Type

- Display and UI: **Archivo Variable** via `@fontsource-variable/archivo` (self-hosted, offline
  safe; the family's font). Headings and the wordmark at `font-stretch: 125%`, weight 800.
- Body and transcript: Archivo at normal width, 400/500, 17 px / 1.85 on reading surfaces.
- Mono (timers, timestamps, eyebrows): `ui-monospace, "SF Mono", "Cascadia Mono", monospace`,
  eyebrows 0.75 rem, 700, 0.14 em tracking, uppercase, like the site's `.kicker`.

## Surfaces

- The live "paper": ruled lines every 1.85 em in `--border`, a single vertical margin rule in the
  accent at 2.5 rem from the left, text starting right of it. This is the Notebook look the family
  calls "the bearlog house look".
- Cards are rare. Rules and margins carry structure, not boxes.
- Radius 0.625 rem base, scaled like Pages.

## Footer

"Scribe by BearLog · support@bearlog.app · BearLog Software Development Services" with the coffee
link as a named text link ("Buy me a coffee"). No usage numbers, no badges.
