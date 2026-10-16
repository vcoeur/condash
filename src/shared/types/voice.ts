// Voice dictation + readback: push-to-talk STT for terminal panes and the
// on-demand TTS readback of recent pane output. The audio crosses the IPC
// boundary base64-encoded; the provider calls run only in the main process.

/** Provider identity alone does not distinguish realtime from batch text. */
export type VoiceProvider = 'openrouter' | 'mistral';

/** Presence is not validation. This metadata never contains key material. */
export interface VoiceKeyStatus {
  present: boolean;
  source: 'agents-env' | 'settings' | 'none';
}

export interface VoiceCredentialStatus {
  openrouter: VoiceKeyStatus;
  mistral: VoiceKeyStatus;
}

export type VoiceTranscriptProducer = 'openrouter-batch' | 'mistral-batch' | 'mistral-realtime';

/** Per-machine voice preferences — the global `voice` settings key. Provider
 *  API keys are secrets and live only in the per-machine `settings.json`;
 *  by default they are read from `~/.config/agents/.env` instead and these
 *  fields stay unset. See `docs/reference/config.md`. */
export interface VoicePrefs {
  /** Master switch for dictation + readback. Unset or false (the default)
   *  disables voice entirely: the pane controls do not render and the IPC
   *  handlers answer with a typed disabled result without contacting any
   *  provider or opening the microphone. Off by default — clips leave the
   *  machine only after an explicit opt-in in Settings → Voice. */
  enabled?: boolean;
  /** Manual OpenRouter key fallback. The agents-env entry wins when present. */
  openrouterApiKey?: string;
  /** Manual Mistral key fallback. The agents-env entry wins when present. */
  mistralApiKey?: string;
  /** OpenRouter model used for transcription (audio-in, text-out chat
   *  completion). Default `mistralai/voxtral-small-24b-2507`. */
  sttModel?: string;
  /** OpenRouter model used for text-to-speech. Default
   *  `mistralai/voxtral-mini-tts-2603`. */
  ttsModel?: string;
  /** Voice id for OpenRouter TTS (Voxtral encodes language + persona +
   *  emotion in the id, e.g. `en_paul_neutral`, `fr_marie_neutral`).
   *  Default `en_paul_neutral`. */
  ttsVoice?: string;
  /** Mistral voice id used only by the Mistral TTS fallback (`preset or
   *  custom voice` on `POST /v1/audio/speech`). Unset → the fallback is
   *  skipped with a clear error. */
  mistralVoiceId?: string;
  /** Realtime streaming dictation (Mistral realtime WebSocket). Unset or
   *  true (the default) streams audio while recording so partial text shows
   *  live; false restores batch-only behaviour. The batch chain stays the
   *  fallback either way — this key only decides whether the socket opens. */
  streaming?: boolean;
  /** Vocabulary phrases for dictation (max 100 — the provider cap),
   *  one concern each: app handles, project slugs, domain terms. Merged
   *  with the conception's `repositories[]` handles/names/aliases at use
   *  time; the effective list applies on the batch surfaces (OpenRouter
   *  prompt glossary, Mistral `context_bias` form fields) and a non-empty
   *  list routes a streaming stop through a bias-corrected batch repass. */
  contextBias?: string[];
  /** Hold-to-dictate chord in the `parseShortcut` grammar (default
   *  `Ctrl+Shift+Space`). An empty string disables push-to-talk. */
  pptShortcut?: string;
}

/** One recorded clip the renderer hands to main for transcription. Always
 *  16-bit PCM mono WAV, base64-encoded — the one format both provider paths
 *  accept without a codec dependency in the renderer. */
export interface VoiceAudioClip {
  /** Base64 of the complete WAV file (RIFF header + PCM data). */
  data: string;
  /** Sample rate the renderer recorded at (Hz) — metadata for the adapter. */
  sampleRate: number;
  /** Audio container; only `wav` is produced today. */
  format: 'wav';
}

/** Result of inserting a dictated transcript into a terminal session's PTY.
 *  `inserted` is false when nothing was written; `reason` says why so the
 *  pane can show a specific notice. */
export interface VoiceTranscribeResult {
  inserted: boolean;
  /** Which provider produced the transcript (absent when nothing was
   *  transcribed). */
  provider?: VoiceProvider;
  /** Origin of the final text, independent of whether live captions appeared. */
  producer?: VoiceTranscriptProducer;
  /** Characters actually written to the PTY (absent when nothing was
   *  written). */
  chars?: number;
  /** `empty-transcript` — the clip transcribed to nothing usable;
   *  `no-session` — the target tab is unknown or already exited;
   *  `disabled` — voice is switched off (the default), so nothing was
   *  recorded, contacted, or written. */
  reason?: 'empty-transcript' | 'no-session' | 'disabled';
}

/** Result of the on-demand readback: recent pane output synthesized to MP3.
 *  The bytes travel base64; the renderer plays them as a `data:` URL. */
export interface VoiceSpeakResult {
  ok: boolean;
  /** Base64 MP3 payload. Absent when `ok` is false. */
  audioBase64?: string;
  /** MIME type of the decoded audio (`audio/mpeg`). */
  mime?: string;
  /** Which provider synthesized the audio. */
  provider?: VoiceProvider;
  /** `disabled` — voice is switched off (the default); no provider was
   *  contacted. Present only on the disabled no-op. */
  reason?: 'disabled';
  /** Human-readable failure reason. Never carries key material. */
  error?: string;
}

/** Renderer → main request to open a realtime transcription stream for one
 *  tab. `sampleRate` is the rate the mic actually captured at (the
 *  AudioContext's real rate, which some backends vary from the requested
 *  16 kHz) so main's reassembled repass WAV can carry an honest header. */
export interface VoiceStreamStartRequest {
  ownerId: string;
  sid: string;
  sampleRate: number;
}

/** Result of opening a realtime transcription stream. A refusal is always a
 *  typed `ok: false` — the renderer treats every reason as "stay on the
 *  batch path" (streaming is an upgrade, not a requirement), with an explicit
 *  unavailable-caption notice unless streaming itself is disabled. */
export interface VoiceStreamStartResult {
  ok: boolean;
  /** `disabled` — voice (or `voice.streaming`) is off; `no-mistral-key` —
   *  the realtime endpoint is Mistral-only and no key resolved;
   *  `already-active` — one stream is already running; `error` — the socket
   *  failed to open. */
  reason?: 'disabled' | 'no-mistral-key' | 'already-active' | 'error';
  /** Redacted human-readable detail for `error`. Never carries key material. */
  error?: string;
}

/** One chunk of raw s16le mono 16 kHz PCM from the renderer's per-chunk tap
 *  — no WAV header; the realtime endpoint takes bare samples as binary
 *  frames. */
export interface VoiceStreamChunk {
  ownerId: string;
  pcmBase64: string;
}

/** Accumulated partial transcript pushed main → renderer while a stream is
 *  live (the whole text so far, not a delta — small payloads, no lost-update
 *  ordering, and the caption strip can remount losslessly). */
export interface VoicePartialMessage {
  ownerId: string;
  sid: string;
  text: string;
  /** The stream failed during capture. Text may already have been displayed. */
  unavailable?: boolean;
}
