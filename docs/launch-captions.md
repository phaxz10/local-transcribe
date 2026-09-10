# Launch captions (story version)

Links: https://scribe.bearlog.app · https://github.com/phaxz10/local-transcribe · https://www.bearlog.app · https://buymeacoffee.com/phaxz10

Voice: yours. Plain, a little self-deprecating, specific. No hype words, no em dashes.

---

## LinkedIn

I've been unemployed for a few months now. That means two things: a lot of time to build my own apps, and a lot of time watching Chinese short dramas and K-dramas.

Problem: I'm broke, so I watch the free downloadable ones, and half of them have no subtitles.

So I built Scribe. It runs speech-to-text and translation entirely in the browser, on your own machine. I drop in the episode, it transcribes the Mandarin, translates it to English, and gives me an SRT file. No account, no upload, nothing leaves my laptop.

Then I got greedy. Most of my day is writing prompts to write code, and my hands were tired. So I added a live mode with a small floating window that stays on top of whatever app I'm in. I talk, it types, I hit copy, paste it into the editor. Faster than typing, and easier on my fingers.

It turned out well for a free tool. It runs in a web worker on WebGPU (with a CPU fallback), so the page stays responsive even on a long file. Models download once and it works offline after that. English uses NVIDIA's Parakeet, other languages use Whisper, and there's a Mandarin fine-tune I exported myself because stock Whisper was rough on the dramas.

Honest limits: it wants a fairly recent laptop or phone, and the floating window is Chrome and Edge only for now.

It's free and open source. If it saves you something, there's a coffee link on the page. If you speak a language I don't and want to test it, I'd love the help.

Try it: scribe.bearlog.app
Code: github.com/phaxz10/local-transcribe

Scribe is my fifth app from BearLog, my one-person software studio in La Union, Philippines. The rest are at bearlog.app.

---

## X / Threads

Unemployed for months, broke, watching free Chinese dramas with no subtitles.

So I built Scribe: transcription + translation that runs 100% in your browser. Drop in an episode, get English SRT. Then I added a floating window so I can dictate code prompts instead of typing them.

Free, no account, open source. scribe.bearlog.app

(video)

---

## Reddit

Subreddits, in order: r/SideProject, r/opensource, r/LocalLLaMA, r/privacy. Read each sub's self-promo rule first. Video as the media, this as the body.

**Title (r/SideProject, r/opensource):**
Being unemployed and broke got me to build a free subtitle generator that runs entirely in the browser

**Title (r/LocalLLaMA):**
I built a browser-only transcription + translation app (Parakeet, Whisper, opus-mt on WebGPU) because my free Chinese dramas had no subs

**Title (r/privacy):**
Speech-to-text and translation that never leaves your device, built out of boredom and an empty wallet

**Body:**

Quick backstory. I've been out of work for a few months. That gave me time to build things, and time to watch a lot of Chinese short dramas and K-dramas. Since I'm broke I watch the free downloadable ones, and a lot of them have no subtitles.

So I built Scribe. You open it in the browser, download a model once, and from then on everything runs on your own machine. Drop in the episode, it transcribes the Mandarin, translates each line to English, and exports SRT with the original timings. No account, no upload.

Then I added the feature I actually use most. I spend my day prompting to write code, and typing all of it was wearing my hands out. Scribe has a live mode with a floating picture-in-picture window that stays on top of any app: I talk, it types, I copy, I paste.

What's under the hood:

- Runs in a web worker, WebGPU first with a WASM fallback, so the UI never freezes.
- English: NVIDIA Parakeet CTC (non-autoregressive, so it can't loop). Other languages: Whisper large-v3-turbo, plus a Mandarin fine-tune I exported to ONNX myself because stock turbo was bad on dramas.
- Translation is two-stage: transcribe in the source language, then a small opus-mt model per segment (Mandarin, Japanese, Korean), NLLB as the fallback for everything else.
- Silero VAD for chunking, recordings persist in IndexedDB every 5 seconds so a crash doesn't lose them, resumable model downloads, works offline after the first run.
- Speaker labels for two-person dialog, click a word to seek, exports to TXT, SRT, VTT, JSON, Markdown.

Limits: the floating window is Chrome and Edge only. Speaker identification is a pause heuristic plus manual labels for now.

Free, MIT, no paid tier. There's a coffee link on the page. Issues and PRs welcome, especially from people with non-English audio.

scribe.bearlog.app
github.com/phaxz10/local-transcribe

---

## Hacker News (Show HN)

**Title:** Show HN: Scribe – browser-only transcription and translation (WebGPU), built to subtitle dramas

**First comment (post right after submitting):**

Author here. I built this while unemployed, originally to put English subtitles on free Chinese dramas that shipped without them, then kept going because dictating code prompts through it was easier on my hands than typing.

Everything runs on-device in a Web Worker via Transformers.js and ONNX Runtime Web, WebGPU first with a WASM fallback. English is Parakeet CTC 0.6B; other languages are Whisper large-v3-turbo, plus a BELLE Mandarin fine-tune I exported with cross-attentions so word timestamps still work. Translation is two-stage (Whisper's own translate task was unusable on this path: the fine-tune loops, turbo just transcribes), so each segment goes through opus-mt or NLLB into the editable layer and the raw layer keeps the source.

Things that bit me: the q4f16 Parakeet export returns all-NaN logits on WebGPU (q4 is fine); Whisper large-v3-turbo scores about 43% CER on Cantonese, so a 200 MB fine-tune beats it there; quiet drama rips at -24 dBFS read as silence until I peak-normalized before VAD; and Whisper's tokenizer spends up to three tokens per Chinese character, so a flat token budget silently truncated Mandarin.

Limits: Document Picture-in-Picture (the floating window) is Chrome and Edge only. Speaker turns are pause-based with manual labels; clustering is next.

Code: https://github.com/phaxz10/local-transcribe. Free, MIT. Happy to answer questions.

---

## Facebook

Been unemployed a few months, so I've been building apps and watching a lot of Chinese and Korean dramas. The free ones often have no subtitles, so I built a tool that makes them.

It's called Scribe. It runs in your browser, on your own laptop, and never uploads your video. Drop in an episode, get English subtitles. It also has a live mode: I talk, it types, and I paste the text anywhere.

Free, no account. If you watch dramas or take a lot of notes, try it and tell me what breaks.

scribe.bearlog.app

---

## Reply templates

- "How is it free?" → It runs on your hardware, so I have no server bill. Coffee link on the page if you want to support it, and the code is open.
- "Safari / Firefox?" → Transcription yes. The floating window is Chrome and Edge only (Document Picture-in-Picture).
- "How accurate?" → English on Parakeet is on par with paid tools on clear audio. Mandarin dramas are good with the fine-tune, rough with stock Whisper. Noisy rooms and heavy accents are where it drops.
- "Why the big download?" → That's the model, once. Works offline afterwards.
- "Will you add X language?" → If Whisper or NLLB knows it, it mostly already works under Other / Mixed. Send me a clip and I'll check.
