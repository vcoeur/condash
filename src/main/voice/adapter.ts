// Dictation uses OpenRouter native audio/transcriptions only (JSON WAV → text).
// The selected native STT model is never substituted. Read-aloud retains its
// OpenRouter-first/Mistral-fallback contract. Native STT and provider.options
// verified against OpenRouter's multimodal/stt documentation, 2026-10-16.
//   TTS  OpenRouter  POST {OPENROUTER_BASE}/audio/speech — OpenAI-compatible
//                    speech endpoint; `response_format` defaults to pcm so
//                    `mp3` is requested explicitly; the reply is RAW audio
//                    bytes. Model `mistralai/voxtral-mini-tts-2603`, persona
//                    voice ids (`en_paul_neutral`, `fr_marie_neutral`, …).
//   TTS  Mistral     POST {MISTRAL_BASE}/audio/speech — JSON body
//                    {model, input, voice_id, response_format}; reply JSON
//                    `{audio_data: <base64>}`. `voice_id` needs a preset or
//                    saved custom voice, so the fallback runs only when
//                    `voice.mistralVoiceId` is configured.
//
// Network never happens in the renderer: clips travel over the typed IPC
// bridge and the main process calls out. All error text passes through
// `redactKeys` so no key material can leak into a message the renderer shows.

import type {
  VoiceAudioClip,
  VoicePrefs,
  VoiceProvider,
  VoiceTranscriptProducer,
} from '../../shared/types';
import type { ResolvedVoiceKeys } from './keys';
import { MAX_CONTEXT_BIAS } from './resolve-context-bias';

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
export const MISTRAL_BASE = 'https://api.mistral.ai/v1';

/** OpenRouter native transcription model. */
export const DEFAULT_STT_MODEL = 'mistralai/voxtral-mini-transcribe';
/** OpenRouter speech model. */
export const DEFAULT_TTS_MODEL = 'mistralai/voxtral-mini-tts-2603';
/** OpenRouter TTS persona voice (Voxtral `en_paul_*` family, neutral). */
export const DEFAULT_TTS_VOICE = 'en_paul_neutral';

/** Seconds before an outbound provider call gives up; the pane button must
 *  never spin forever on a hung request. */
const REQUEST_TIMEOUT_MS = 60_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AdapterDeps {
  fetch?: FetchLike;
  signal?: AbortSignal;
}

export interface TranscribeSuccess {
  text: string;
  provider: VoiceProvider;
  producer: VoiceTranscriptProducer;
}

/**
 * Transcribe one WAV with the selected OpenRouter native model. Vocabulary
 * uses documented provider.options.mistral.context_bias, not an ignored prompt.
 * Missing credentials or provider errors never select another provider/model.
 */
export async function transcribeClip(
  clip: VoiceAudioClip,
  keys: ResolvedVoiceKeys,
  prefs?: VoicePrefs,
  deps?: AdapterDeps,
  contextBias: readonly string[] = [],
): Promise<TranscribeSuccess> {
  if (!keys.openrouter) {
    throw new Error(
      'OpenRouter API key required for dictation — set OPENROUTER_API_KEY or Settings → Voice. Mistral keys are read-aloud only.',
    );
  }
  try {
    return await openrouterTranscribe(
      clip,
      keys.openrouter,
      prefs,
      deps?.fetch ?? globalThis.fetch.bind(globalThis),
      contextBias,
      deps?.signal,
    );
  } catch (error) {
    throw new Error(
      `OpenRouter transcription failed (${prefs?.sttModel?.trim() || DEFAULT_STT_MODEL}) — ${redactKeys((error as Error).message, keys)}`,
    );
  }
}

export interface SpeakSuccess {
  audio: Uint8Array;
  provider: VoiceProvider;
}

/**
 * Synthesize text to MP3: OpenRouter first, Mistral fallback (only when a
 * Mistral voice id is configured — its API has no anonymous preset voice).
 * Throws a redacted, user-displayable error when nothing answers.
 */
export async function speakText(
  text: string,
  keys: ResolvedVoiceKeys,
  prefs?: VoicePrefs,
  deps?: AdapterDeps,
): Promise<SpeakSuccess> {
  const doFetch = deps?.fetch ?? globalThis.fetch.bind(globalThis);
  const attempts: { provider: VoiceProvider; run: () => Promise<SpeakSuccess> }[] = [];
  if (keys.openrouter) {
    attempts.push({
      provider: 'openrouter',
      run: () => openrouterSpeak(text, keys.openrouter!, prefs, doFetch),
    });
  }
  if (keys.mistral) {
    attempts.push({
      provider: 'mistral',
      run: () => {
        if (!prefs?.mistralVoiceId) {
          throw new Error(
            'Mistral TTS fallback needs a voice id — set one under Settings → Voice ' +
              '(Mistral voice id), or fix the OpenRouter key.',
          );
        }
        return mistralSpeak(text, keys.mistral!, prefs.mistralVoiceId, prefs, doFetch);
      },
    });
  }
  if (attempts.length === 0) {
    throw new Error(
      'No text-to-speech API key available — set OPENROUTER_API_KEY in ~/.config/agents/.env ' +
        'or add one under Settings → Voice.',
    );
  }
  const failures: string[] = [];
  for (const attempt of attempts) {
    try {
      return await attempt.run();
    } catch (err) {
      failures.push(`${attempt.provider}: ${redactKeys((err as Error).message, keys)}`);
    }
  }
  throw new Error(`Text-to-speech failed — ${failures.join('; ')}`);
}

// ---------------------------------------------------------------------------
// OpenRouter
// ---------------------------------------------------------------------------

async function openrouterTranscribe(
  clip: VoiceAudioClip,
  apiKey: string,
  prefs: VoicePrefs | undefined,
  doFetch: FetchLike,
  contextBias: readonly string[] = [],
  signal?: AbortSignal,
): Promise<TranscribeSuccess> {
  const model = prefs?.sttModel?.trim() || DEFAULT_STT_MODEL;
  const res = await doFetch(`${OPENROUTER_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      input_audio: { data: clip.data, format: clip.format },
      ...(contextBias.length
        ? {
            provider: {
              options: { mistral: { context_bias: contextBias.slice(0, MAX_CONTEXT_BIAS) } },
            },
          }
        : {}),
    }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as {
    text?: string;
    error?: { message?: string };
  };
  if (body.error) throw new Error(body.error.message || 'provider error');
  if (typeof body.text !== 'string')
    throw new Error('invalid native transcription response (expected text)');
  return { text: body.text, provider: 'openrouter', producer: 'openrouter-native' };
}

async function openrouterSpeak(
  text: string,
  apiKey: string,
  prefs: VoicePrefs | undefined,
  doFetch: FetchLike,
): Promise<SpeakSuccess> {
  // `response_format` defaults to pcm on this endpoint — request mp3
  // explicitly or the bytes come back headerless raw samples.
  const res = await doFetch(`${OPENROUTER_BASE}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: prefs?.ttsModel?.trim() || DEFAULT_TTS_MODEL,
      input: text,
      voice: prefs?.ttsVoice?.trim() || DEFAULT_TTS_VOICE,
      response_format: 'mp3',
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const audio = new Uint8Array(await res.arrayBuffer());
  if (audio.length === 0) throw new Error('empty audio from provider');
  return { audio, provider: 'openrouter' };
}

// ---------------------------------------------------------------------------
// Mistral
// ---------------------------------------------------------------------------

async function mistralSpeak(
  text: string,
  apiKey: string,
  voiceId: string,
  prefs: VoicePrefs | undefined,
  doFetch: FetchLike,
): Promise<SpeakSuccess> {
  const res = await doFetch(`${MISTRAL_BASE}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: prefs?.ttsModel?.trim() || DEFAULT_TTS_MODEL,
      input: text,
      voice_id: voiceId,
      response_format: 'mp3',
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { audio_data?: string; message?: string };
  if (!body.audio_data) throw new Error(body.message || 'no audio in reply');
  return { audio: base64ToBytes(body.audio_data), provider: 'mistral' };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Remove every configured key (and any bearer-token-looking neighbour) from
 *  an error string. Every adapter failure passes through this before it can
 *  reach a renderer notice or a log line. */
export function redactKeys(text: string, keys: ResolvedVoiceKeys): string {
  let out = text;
  for (const key of [keys.openrouter, keys.mistral]) {
    if (key && out.includes(key)) out = out.split(key).join('***');
  }
  return out;
}

function base64ToBytes(data: string): Uint8Array {
  return Uint8Array.from(Buffer.from(data, 'base64'));
}
