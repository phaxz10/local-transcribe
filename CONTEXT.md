# Scribe by BearLog

A local-first voice toolkit split by delivery target. **Web Transcribe** is this browser app: audio, video, or microphone input becomes a timestamped, editable Transcript. **Native Translate** is the separate mobile app for spoken travel conversation, with typed text as a fallback.

**Brand**: The app ships as **Scribe by BearLog**, and `docs/brand.md` is the source of truth for the name, the mark, the colours and the type, with `src/lib/brand.ts` holding the one constant every user-visible string reads from.

## Language

**Section**:
One top-level product tool. In this repo the only shipped Section is **Web Transcribe**; **Native Translate** is a separate mobile app and should not be folded back into the web app.
_Avoid_: tab, page, mode (those name UI mechanics, not the tool).

**Model**:
An on-device checkpoint powering exactly one **Task**. In Web Transcribe, Models are only **Transcription Models**; Native Translate may also use **Translation Models** and future **Voice Models**.
_Avoid_: weights, AI, the network.

**Task**:
What a Model is responsible for: **Transcription** (speech → text), **Translation** (text → text), or voice synthesis. Web Transcribe's only Catalog Task is Transcription.
_Avoid_: type, mode, pipeline (that names the engine internal, not the role).

**Provision** (a Model):
To make a Model available in the browser's cache so it can be used offline. Happens by Download (from the Catalog) or Sideload (any HF id).
_Avoid_: load, install (those name the mechanics, not the act).

**Download** (a Model):
Provisioning by picking a Model from the Catalog; the app fetches its checkpoint files and caches them on first use.
_Avoid_: using "sideload" for this; reserve that for a user-supplied HF id.

**Sideload** (a Model):
Provisioning by supplying a user-chosen model id or local model package that matches a supported runtime.
_Avoid_: upload (nothing goes to a server); "BYO file" (it's an id, not a file).

**Evict** (a Model):
Removing a provisioned Model's weights from the device to free storage, the inverse of Provision. The Model stays in the Catalog and can be Downloaded again; Transcripts and settings are untouched.
_Avoid_: delete (reserve for Transcripts/data), uninstall, "clear cache" (that names the mechanism, not the act).

**Model Catalog**:
The curated set of Models the app offers for Download, each tagged with its size and rough device requirements.
_Avoid_: model list, model store.

**Recommended Model**:
The Model the app suggests as the best default *for the current device and Primary Language*, computed from Fit-check + benchmark ×RT + Language Profile, not a fixed pick. The user still chooses.
_Avoid_: default model.

**Active Model**:
The provisioned Model currently selected for a Task. Web Transcribe has one active Transcription Model; Native Translate may have separate active Transcription, Translation, and Voice Models.
_Avoid_: current model, selected model (those name UI state, not the role); default model (that's the Recommended Model).

**Language Profile**:
Per-Model metadata describing which languages it handles and how well (multilingual vs English-only, plus curated quality ratings), used to render badges and steer the Recommended Model.
_Avoid_: language list, locale support.

**Primary Language**:
The language the user declares at onboarding, used to steer the Recommended Model (e.g. English → an `.en` Model).
_Avoid_: locale, default language.

**Session Language**:
The per-session language override on the Transcribe screen. It replaces the Primary Language for the runs started from that screen without changing the global setting, and it is the *source* language even when Translate to English is on.
_Avoid_: temporary language, target language (it names the speech, not the output); overriding the Primary Language (it never writes to it).

**Travel Language Pair**:
A bidirectional language pair Native Translate is expected to handle well for short travel conversations. English ↔ Cantonese is the first priority, followed by Mandarin, Japanese, Korean, Thai, Malay, and Tagalog.
_Avoid_: benchmark language, supported locale.

**Active Travel Language**:
The selected non-English language for a Native Translate conversation. It determines both directions: **Me** translates English into this language, while **Them** translates this language back into English.
_Avoid_: target language (only true for Me), source language (only true for Them), locale.

**Capability Tier**:
A coarse classification of the current device's transcription ability (e.g. Low / Medium / High), derived from cheap signals plus the benchmark, used to pick the Recommended Model and shape warnings.
_Avoid_: device class, performance level.

**Realtime Factor** (×RT):
How many seconds of audio a device transcribes per second of wall-clock with a given Model (e.g. 3×RT ⇒ a 10-minute file in ~3.3 minutes). Measured by the benchmark; the basis for every ETA.
_Avoid_: speed, throughput.

**Fit-check**:
The hard pre-Download test that a Model's memory + storage footprint fits the device. The only hard block in the app, since failing it would mean a real crash.
_Avoid_: capability check (that's the soft, ETA-based assessment).

**Engine**:
The warm on-device inference session for an Active Model. Web Transcribe keeps an ASR Engine; Native Translate may keep separate resident Engines for Transcription, Translation, and voice synthesis.
_Avoid_: worker, runner, backend (there is no server backend).

**Transcript**:
The timestamped, editable text result of transcribing audio. First-class and mutable: users correct it and re-export; edits persist locally.
_Avoid_: output, captions (SRT/VTT are *export formats* of a Transcript, not the Transcript itself).

**Transcription Job**:
A single file → Transcript run, the upload/batch mode.
_Avoid_: task, upload.

**Live Session**:
A microphone → Transcript run that streams interim results in near real-time, the live mode.
_Avoid_: recording, stream.

**Native Translate**:
The separate mobile-only spoken conversation app where a person speaks or types a phrase in one language and gets it back as on-screen text **and** synthesized speech in another. Conversational and meaning-first (not literal); distinct from Web Transcribe and from a Transcript.
_Avoid_: Translate Section inside the web app.

**Translation**:
The text result of turning a source phrase into a target-language phrase. In **Native Translate** it is one Spoken Turn's output. In **Web Transcribe**, "Translate to English" is segment-level machine translation of a finished Transcript into the **Edit Layer**: the ASR Layer keeps the source language (raw export is Mandarin), the Edit Layer holds the English (corrected export is English subtitles). Word times inside a translated Segment are interpolated, never exact ([ADR-0018](./docs/adr/0018-two-stage-translation.md)).
_Not_: Whisper's `translate` task. The app never runs it — `AsrLayer.task` is always `transcribe`.
_Avoid_: interpret, localize.

**Translation Pair**:
A source→English direction Web Transcribe can machine-translate, named for the Marian model behind it: `zh-en` (also used for Cantonese, as a stated best effort) and `ja-en`. It is chosen by the Transcript's **language**, not by the Transcription Model. Tagalog has no Pair, and the Transcribe screen says so rather than offering a switch that would do nothing.
_Avoid_: language pair (that's Native Translate's bidirectional **Travel Language Pair**), direction, translation model (the Pair names the direction; the Model is what implements it).

**Translation Provider**:
The selected engine for the Translation task in Native Translate. It can be a local Translation Model or a frontier cloud model, while ASR and voice output stay local.
_Avoid_: model provider (too broad), backend.

**Active Translation Provider**:
The conversation-level Translation Provider currently selected for Native Translate. Every Me/Them Spoken Turn and typed fallback uses it until the user changes it.
_Avoid_: per-turn provider, active model (too local-model-specific).

**Frontier Cloud Integration**:
An optional Native Translate capability that can call user-configured frontier cloud models as the Translation Provider. It receives text plus direction context and returns translated text; it does not handle transcription or voice output.
_Avoid_: backend, online mode, cloud-first.

**Spoken Turn**:
A single Native Translate exchange where a spoken phrase is heard, translated, shown as text, and spoken aloud in the other language. A typed exchange skips the hearing step but produces the same Translation.
_Avoid_: voice mode, recording, query.

**Current Turn**:
The most recent Native Translate exchange shown as the primary screen content. It keeps the app focused on the active conversation moment rather than a transcript-like feed.
_Avoid_: latest result, active message.

**Conversation Log**:
The hidden-by-default list of prior Spoken Turns that can be reopened when the user needs to revisit the conversation. It persists locally on the device and is not the primary Native Translate screen.
_Avoid_: History (reserved for Web Transcribe's transcript list), transcript, chat log.

**Speaker Side**:
The side of a Native Translate conversation that determines translation direction. **Me** means English speech or text translated into the Active Travel Language; **Them** means the Active Travel Language translated back into English.
_Avoid_: source/target toggle, language swap.

**Hold-to-Talk**:
The Native Translate input gesture where speech is captured only while the user is holding the talk button. This is distinct from a start/stop recorder and from automatic voice activity detection.
_Avoid_: push-to-talk (ambiguous), recording mode, VAD.

**Built-in Voice**:
A text-to-speech voice supplied by the user's own device/OS, used to speak a Translation aloud. The app prefers offline voices so nothing leaves the device. Availability is per-device, and notably Cantonese needs a `zh-HK` pack the user installs in OS settings.
_Avoid_: TTS Model, synth (a Built-in Voice is explicitly *not* a Provisioned Model).

**Voice Model**:
A Provisioned Model that synthesizes spoken output locally when Built-in Voices are not natural enough. It is a Native Translate upgrade path, not part of Web Transcribe.
_Avoid_: ElevenLabs (that names a cloud product, not this local capability), Built-in Voice.

**Voice Check**:
The runtime probe of which Built-in Voices the device exposes for the wanted languages, used to confirm spoken output will work and to prompt installing a missing language pack. The speech-side analogue of the Fit-check.
_Avoid_: voice list.

**Segment**:
A phrase-level unit of a Transcript (~a sentence) with start/end times, containing Words. What Whisper emits natively and what exports like SRT are built from.
_Avoid_: line, caption, phrase.

**Word**:
The atomic timestamped unit nested in a Segment: `{ text, start, end, confidence }`. Drives highlight, click-to-seek, and precise editing.
_Avoid_: token (a token is a model-internal sub-word fragment; one Word may merge several tokens).

**ASR Layer**:
The original, immutable transcription captured straight from the Engine (Segments → Words with timings + confidence). Never edited; the base every correction maps back to.
_Avoid_: raw transcript (it is a *layer* of a Transcript), source text.

**Edit Layer**:
The user-facing, mutable correction layer derived from the ASR Layer, mapping each edited Word back to its origin Word(s) for timing.
_Avoid_: overrides, diff, patch.

**Speaker**:
A named participant a user attaches to Segments of a Transcript, stored per Transcript and referenced by Segment. Names are the user's to set; the app never claims to have recognised a voice.
_Avoid_: voice, person, diarization label (that names a model output we don't have yet).

**Turn**:
A run of consecutive Segments separated from the previous run by a pause of at least a second, computed from the VAD speech regions. The unit a Speaker is guessed and assigned over.
_Avoid_: paragraph, block (those name layout); Spoken Turn (that's the Native Translate exchange).

**Dialog mode**:
The opt-in two-Speaker guess: alternate Speakers at every Turn as a starting point the user corrects, for the common case of a two-person recording. Explicitly a guess about conversation shape, not about who is speaking.
_Avoid_: diarization, speaker detection, auto-label (all imply an identity claim).
