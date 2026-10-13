# Voice dictation and readback

Push-to-talk dictation and on-demand read-aloud for terminal tabs.

**Enable it first** — voice is off by default. Open **Settings → Voice** (under *Personal · this machine*), tick **Enable voice dictation**, and save; the Dictate/Read controls appear in terminal tab strips immediately, no restart needed. Until then no tab shows voice controls and nothing records, transmits, or speaks.

With voice enabled, two controls live in each tab strip's header, beside Find and Save, and appear once the tab has a live session:

- **Dictate** — click to start recording; a pulsing dot marks the recording state. With streaming on (the default), the words appear as a temporary caption under the tab strip while you speak; click again to stop and the final text is inserted into the tab it was recorded in, exactly as typed keystrokes would be. The OS microphone prompt fires once, on first use. If the tab's controls disappear mid-recording — you switch column, open the Dashboard band, or close the tab — the recording is cancelled and the microphone released immediately.
- **Read** — click to have the tab's recent output read aloud; click again (or start a new read) to stop. It never speaks unprompted.

You never need the mouse: hold the **push-to-talk chord** (`Ctrl+Shift+Space` by default) to record, release to insert — see [Push-to-talk](#push-to-talk) below.

Both stay idle until clicked or chord-held. Nothing records unless Dictate is toggled on — and nothing is reachable at all while voice is disabled in Settings.

## How it works

```mermaid
flowchart LR
    A["Mic capture<br/>(renderer, 16 kHz mono PCM)"] -->|"typed IPC<br/>base64 clip (batch)<br/>/ PCM chunks (stream)"| B["Main process:<br/>STT adapter"]
    B -->|"transcript<br/>(sanitised, capped)"| C["PTY write path<br/>(same as typed input)"]
    B -->|"accumulated partial<br/>(push channel)"| D["Live caption strip<br/>(local display only)"]
    E["Recent pane output<br/>(main-side slice)"] --> F["Main process:<br/>TTS adapter"]
    F -->|"base64 MP3"| G["Pane plays it<br/>(data: URL)"]
    B -.->|"streaming WebSocket<br/>Mistral realtime"| H["Mistral realtime"]
    B -.->|"HTTPS batch"| I["OpenRouter / Mistral"]
    F -.->|"HTTPS"| I
```

- **Recording** happens in the renderer (echo cancellation + noise suppression on); **provider calls happen only in the main process** — the renderer never talks to the network, and key values are used only in the main process (a key entered in Settings is displayed back by the Settings prefill, the same shape as the dashboard's `apiKey`).
- **Streaming** (on by default): while recording, main opens one WebSocket to Mistral's realtime transcription endpoint and forwards the mic's PCM chunks as binary frames. The forming text comes back as accumulated partials and renders in a dashed live-caption strip under the tab strip — **local display only, never typed into the terminal**. On stop, the microphone is released first, then main finalises the stream and commits the final text once through the sanitised insert path.
- **Batch fallback**: every stream refusal or failure — no Mistral key, `voice.streaming` off, a handshake error, a mid-stream drop — silently keeps the pre-existing behaviour: the clip is buffered whole and transcribed on stop (OpenRouter chat first, Mistral multipart fallback). A failed stream also falls back to the batch chain on the audio main already received.
- The transcript is sanitised before insertion: control characters (a stray Ctrl-C, EOF), carriage returns, and ANSI escape sequences are stripped, and the text is capped at 4000 characters. An empty transcript is a visible no-op notice, never a silent write of nothing.
- The write goes through the same terminal-service path as typed input (`termWrite`), so multi-line transcripts submit per line, exactly as if typed.
- Read-aloud reads the tab's **recent output** — the same recent-scrollback slice the Dashboard summarizer uses. It is not a parsed "final answer": on a full-screen TUI tab it reads whatever the cleaned buffer holds.

## Push-to-talk

Hold **`Ctrl+Shift+Space`** (default) to record; release to insert — one recording state machine, two triggers, and the chord never hijacks anything outside the app (it is an in-app capture listener, not a system-wide shortcut: condash unfocused means the chord is free).

- The chord **starts on the keydown** (with a live tab in the active column) and **commits on the keyup of the base key alone** — releasing Ctrl and Shift before Space still commits.
- Holding fires auto-repeat keydowns; the recording guard absorbs them.
- Set the field to **empty** in Settings → Voice to disable push-to-talk entirely; any `parseShortcut`-grammar chord works (`Ctrl+Shift+D`, `F2`, …).
- It fires inside the xterm like screenshot-paste, so the chord never types into the shell; and clicking Dictate keeps keyboard focus in the terminal.

## Context bias

The words an ecosystem uses — app handles, project slugs, domain terms — are exactly what speech models misspell. **Settings → Voice → Context bias** takes one phrase per line (up to 100, the provider cap) and applies it on every documented surface:

| Path | Mechanism |
|---|---|
| OpenRouter chat (batch primary) | a glossary sentence in the transcription prompt |
| Mistral multipart (batch fallback) | native repeatable `context_bias` form fields |
| Mistral realtime (streaming) | none — bias is undocumented on the realtime endpoint |

The realtime gap is handled at commit time (the **final-text rule**): with a non-empty bias list, a streamed dictation's final text is re-checked through the Mistral batch path **with `context_bias`** (falling back to OpenRouter's glossary, then to the raw realtime text), using the audio the stream already carried. That costs ~1–2 extra seconds on stop and bills the audio a second time — only when vocabulary is configured. Leave the list empty for the fast single-pass commit.

The effective list also includes the open conception's `repositories[]` app identity — handles, names, and aliases are seeded automatically and silently, so `#knoten` and `alicepeintures` come out spelled correctly without configuring anything.

## Providers and keys

OpenRouter is the first provider; Mistral is the fallback when OpenRouter has no key or fails. Endpoints and models (verified 2026-10-11):

| | Transcription | Speech |
|---|---|---|
| OpenRouter | `POST /api/v1/chat/completions` with an `input_audio` part, model `mistralai/voxtral-small-24b-2507` | `POST /api/v1/audio/speech`, model `mistralai/voxtral-mini-tts-2603`, voice `en_paul_neutral`, `response_format: mp3` |
| Mistral | `POST /v1/audio/transcriptions` (multipart), model `voxtral-mini-latest` | `POST /v1/audio/speech`, model `voxtral-mini-tts-2603`, `voice_id` required |

Keys resolve in this order:

1. `~/.config/agents/.env` (read-only) — `OPENROUTER_API_KEY` and `MISTRAL_API_KEY`. This is the default source; nothing to configure.
2. **Settings → Voice** (under *Personal · this machine*) — the manual fallback for machines without the env file. Keys are stored in the per-machine `settings.json` only, never in a tree's settings file, and are never logged; they are used only in the main process for provider calls (a settings-entered key is displayed back by this Settings prefill).

The Mistral TTS fallback additionally needs a **Mistral voice id** (`voice.mistralVoiceId`): Mistral's speech API has no anonymous preset voice. Without one the fallback is skipped with a clear message and read-aloud relies on OpenRouter alone. Transcription and OpenRouter speech work with just the env file.

The OpenRouter TTS voice id carries the language in its prefix — `en_paul_*`, `gb_jane_*`, `fr_marie_*` — pick another under Settings → Voice if you dictate in French (`fr_marie_neutral`).

## Privacy

> **Privacy:** audio is sent to the speech provider only while a dictation is active — streamed in small chunks to Mistral's realtime endpoint as you speak, when streaming is enabled — and the microphone is released the moment you stop. Nothing is sent outside an active dictation; no always-on capture exists; condash keeps no copy of clips or audio; partial text is shown locally and never typed into the terminal until you stop.

- Nothing records or sends unless voice is enabled in Settings *and* a control is active — clicking Dictate, or holding the push-to-talk chord.
- The microphone is released on stop, on cancel, and the moment the tab's controls disappear (column switch, Dashboard band, tab close) — the session guarantees pinned by the lifecycle regression tests.
- Key values are used only in the main process; they are never logged and never sent to the renderer.
- Read-aloud sends the tab's recent output **text** to the TTS provider when you click Read. As with the Dashboard: leave it off for tabs that display credentials you don't want transmitted.
- The mic permission handler is scoped to the app's own window contents — no embedded `<webview>` or other contents can open the microphone through condash. Every other permission class passes through untouched, keeping Electron's no-handler default (auto-approve) — denying them broke the Resources pane's clipboard read.

## Settings reference

Voice is **off by default**; the master switch is the first field in the section. Every field is optional; the full per-key reference lives in [Config files → Voice](../reference/config.md#voice).

| Setting | Default | Meaning |
|---|---|---|
| Enable voice dictation | off | Master switch. With it off, tab strips show no voice controls and the handlers refuse work with a typed disabled notice. |
| Stream dictation live | on | Realtime partials in the caption strip while speaking. Off restores batch-only dictation (transcribed on stop); a stream failure always falls back to batch regardless. Hidden while voice is disabled. |
| OpenRouter API key | — (env file) | Manual key when the env file is missing the entry. Hidden while voice is disabled. |
| Mistral API key | — (env file) | Fallback provider key (and the realtime streaming provider). Hidden while voice is disabled. |
| Transcription model | `mistralai/voxtral-small-24b-2507` | OpenRouter audio-input model. Hidden while voice is disabled. |
| Speech model | `mistralai/voxtral-mini-tts-2603` | TTS model on both providers. Hidden while voice is disabled. |
| Speech voice | `en_paul_neutral` | Voxtral voice id (language prefix: `en_paul_*` / `gb_jane_*` / `fr_marie_*`). Hidden while voice is disabled. |
| Mistral voice id | — | Enables the Mistral TTS fallback; unset skips it. Hidden while voice is disabled. |
| Context bias | — (empty) | One phrase per line, up to 100. Vocabulary spelled exactly on the batch surfaces; non-empty routes a streamed stop through a bias-corrected batch repass. The conception's app handles are added automatically. Hidden while voice is disabled. |
| Push-to-talk shortcut | `Ctrl+Shift+Space` | Hold-to-dictate chord. Empty disables push-to-talk. Hidden while voice is disabled. |
