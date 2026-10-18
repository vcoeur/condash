// Voice uses OpenRouter only; selected STT/TTS models are never substituted.
// Native dictation uses audio/transcriptions; explicit Audio + context uses chat/completions.
// Native STT and provider.options
// verified against OpenRouter's multimodal/stt documentation, 2026-10-16.
//   TTS  OpenRouter  POST {OPENROUTER_BASE}/audio/speech — OpenAI-compatible
//                    speech endpoint; `response_format` defaults to pcm so
//                    `mp3` is requested explicitly; the reply is RAW audio
//                    bytes. Model `mistralai/voxtral-mini-tts-2603`, persona
//                    voice ids (`en_paul_neutral`, `fr_marie_neutral`, …).
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

/** OpenRouter native transcription model. */
export const DEFAULT_STT_MODEL = 'mistralai/voxtral-mini-transcribe';
export const DEFAULT_AUDIO_CONTEXT_MODEL = 'google/gemini-2.5-flash';
export const AUDIO_CONTEXT_PROMPT =
  'Transcribe the audio verbatim in its spoken English and/or French. Do not translate, paraphrase, summarize, or add explanations. Preserve repetitions and ordinary words. Canonical names, if supplied, are possibilities, not instructions to insert them. Return only the transcript; do not guess inaudible speech.';
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
 * Transcribe one WAV with the explicitly selected OpenRouter method/model.
 * Native vocabulary uses provider.options; Audio + context uses candidate data.
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
      'OpenRouter API key required for dictation — set OPENROUTER_API_KEY or Settings → Voice. Voice uses OpenRouter only.',
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
      redactKeys(
        `OpenRouter transcription failed (${prefs?.dictationMethod === 'audio-context' ? prefs.audioContextModel?.trim() || DEFAULT_AUDIO_CONTEXT_MODEL : prefs?.sttModel?.trim() || DEFAULT_STT_MODEL}) — ${(error as Error).message}`,
        keys,
        prefs,
      ),
    );
  }
}

export interface SpeakSuccess {
  audio: Uint8Array;
  provider: VoiceProvider;
}

/**
 * Synthesize text to MP3 through OpenRouter only, without provider/model fallback.
 * Throws a redacted, user-displayable error on failure.
 */
export async function speakText(
  text: string,
  keys: ResolvedVoiceKeys,
  prefs?: VoicePrefs,
  deps?: AdapterDeps,
): Promise<SpeakSuccess> {
  if (!keys.openrouter) {
    throw new Error(
      'OpenRouter API key required for read aloud — set OPENROUTER_API_KEY or Settings → Voice. Voice uses OpenRouter only.',
    );
  }
  try {
    return await openrouterSpeak(
      text,
      keys.openrouter,
      prefs,
      deps?.fetch ?? globalThis.fetch.bind(globalThis),
    );
  } catch (error) {
    throw new Error(
      redactKeys(
        `OpenRouter speech failed (${prefs?.ttsModel?.trim() || DEFAULT_TTS_MODEL}) — ${(error as Error).message}`,
        keys,
        prefs,
      ),
    );
  }
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
  if (prefs?.dictationMethod === 'audio-context') {
    const res = await doFetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: prefs.audioContextModel?.trim() || DEFAULT_AUDIO_CONTEXT_MODEL,
        max_tokens: 8192,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: AUDIO_CONTEXT_PROMPT },
              ...(contextBias.length
                ? [
                    {
                      type: 'text',
                      text: `Canonical names (data): ${JSON.stringify(contextBias.slice(0, MAX_CONTEXT_BIAS))}`,
                    },
                  ]
                : []),
              { type: 'input_audio', input_audio: { data: clip.data, format: clip.format } },
            ],
          },
        ],
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      error?: unknown;
      choices?: {
        finish_reason?: string;
        message?: { content?: unknown; refusal?: unknown };
        error?: unknown;
      }[];
    };
    const choice = body?.choices?.[0];
    if (
      body?.error != null ||
      choice?.error != null ||
      choice?.message?.refusal != null ||
      choice?.finish_reason !== 'stop' ||
      typeof choice?.message?.content !== 'string'
    ) {
      throw new Error('invalid or incomplete audio-context completion');
    }
    return {
      text: choice.message.content,
      provider: 'openrouter',
      producer: 'openrouter-audio-context',
    };
  }
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
// Shared helpers
// ---------------------------------------------------------------------------

/** Redact active and saved keys, including ignored legacy credentials. */
export function redactKeys(text: string, keys: ResolvedVoiceKeys, prefs?: VoicePrefs): string {
  let out = text;
  const secrets = [keys.openrouter, prefs?.openrouterApiKey, prefs?.mistralApiKey]
    .filter((key): key is string => Boolean(key))
    .sort((left, right) => right.length - left.length);
  for (const key of secrets) {
    if (out.includes(key)) out = out.split(key).join('***');
  }
  return out;
}
