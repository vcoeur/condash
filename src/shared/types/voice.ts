// Voice dictation + readback: push-to-talk STT for terminal panes and the
// on-demand TTS readback of recent pane output. The audio crosses the IPC
// boundary base64-encoded; the provider calls run only in the main process.

/** Which STT/TTS provider answered a request. Order of preference is
 *  OpenRouter first, Mistral as fallback (both keyed independently). */
export type VoiceProvider = 'openrouter' | 'mistral';

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
  /** OpenRouter API key. Blank/unset → read `OPENROUTER_API_KEY` from
   *  `~/.config/agents/.env`. Never logged. */
  openrouterApiKey?: string;
  /** Mistral API key. Blank/unset → read `MISTRAL_API_KEY` from
   *  `~/.config/agents/.env`. Never logged. */
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
