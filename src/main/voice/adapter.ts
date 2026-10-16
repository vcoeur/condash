// STT/TTS provider adapter for voice dictation + readback.
//
// One interface, two providers, OpenRouter first with Mistral as fallback.
// Every endpoint/model below was verified against the live provider docs and
// catalogues on 2026-10-11:
//
//   STT  OpenRouter  POST {OPENROUTER_BASE}/chat/completions — audio rides an
//                    `input_audio` content part ({data: base64, format}), the
//                    transcript comes back in choices[0].message.content.
//                    Model `mistralai/voxtral-small-24b-2507` (audio-in,
//                    text-out; the mini transcribe variant is not on
//                    OpenRouter's chat API).
//   STT  Mistral     POST {MISTRAL_BASE}/audio/transcriptions — multipart
//                    `model` + `file`, whisper-compatible; reply `{text}`.
//                    Model `voxtral-mini-latest` (Voxtral Mini Transcribe 2).
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

/** OpenRouter audio-in chat model (transcription). */
export const DEFAULT_STT_MODEL = 'mistralai/voxtral-small-24b-2507';
/** OpenRouter speech model. */
export const DEFAULT_TTS_MODEL = 'mistralai/voxtral-mini-tts-2603';
/** OpenRouter TTS persona voice (Voxtral `en_paul_*` family, neutral). */
export const DEFAULT_TTS_VOICE = 'en_paul_neutral';

/** Mistral's transcription-only model id (Voxtral Mini Transcribe 2). */
export const MISTRAL_STT_MODEL = 'voxtral-mini-latest';

/** Instruction sent alongside the audio on the OpenRouter chat path. */
const STT_PROMPT =
  'Transcribe this audio exactly as spoken. Output only the transcript text, nothing else.';

/** The OpenRouter chat path has no bias parameter — the prompt glossary is
 *  the portable mechanism (design note 04 §8). Appended only when the
 *  effective list is non-empty. */
function sttPrompt(contextBias: readonly string[]): string {
  if (contextBias.length === 0) return STT_PROMPT;
  return `${STT_PROMPT} Glossary of proper nouns to spell exactly: ${contextBias.join(', ')}.`;
}

/** Seconds before an outbound provider call gives up; the pane button must
 *  never spin forever on a hung request. */
const REQUEST_TIMEOUT_MS = 60_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AdapterDeps {
  fetch?: FetchLike;
}

export interface TranscribeSuccess {
  text: string;
  provider: VoiceProvider;
  producer: VoiceTranscriptProducer;
}

/**
 * Transcribe one clip: OpenRouter first, Mistral when OpenRouter is unkeyed
 * or fails. `contextBias` rides both paths where the providers accept it —
 * the prompt glossary on OpenRouter, repeatable `context_bias` form fields
 * on Mistral's multipart endpoint. Throws a redacted, user-displayable error
 * when nothing answers.
 */
export async function transcribeClip(
  clip: VoiceAudioClip,
  keys: ResolvedVoiceKeys,
  prefs?: VoicePrefs,
  deps?: AdapterDeps,
  contextBias: readonly string[] = [],
): Promise<TranscribeSuccess> {
  return runTranscribeChain(clip, keys, prefs, deps, contextBias, [
    'openrouter',
    'mistral',
  ] as const);
}

/**
 * The streaming stop repass (design note 04 §8): Mistral's documented native
 * `context_bias` first, OpenRouter's prompt glossary second. Same redaction
 * and aggregation contract as `transcribeClip`.
 */
export async function transcribeClipBiasFirst(
  clip: VoiceAudioClip,
  keys: ResolvedVoiceKeys,
  prefs?: VoicePrefs,
  deps?: AdapterDeps,
  contextBias: readonly string[] = [],
): Promise<TranscribeSuccess> {
  return runTranscribeChain(clip, keys, prefs, deps, contextBias, [
    'mistral',
    'openrouter',
  ] as const);
}

async function runTranscribeChain(
  clip: VoiceAudioClip,
  keys: ResolvedVoiceKeys,
  prefs: VoicePrefs | undefined,
  deps: AdapterDeps | undefined,
  contextBias: readonly string[],
  order: readonly ('openrouter' | 'mistral')[],
): Promise<TranscribeSuccess> {
  const doFetch = deps?.fetch ?? globalThis.fetch.bind(globalThis);
  const runners: Record<'openrouter' | 'mistral', (() => Promise<TranscribeSuccess>) | undefined> =
    {
      openrouter: keys.openrouter
        ? () => openrouterTranscribe(clip, keys.openrouter!, prefs, doFetch, contextBias)
        : undefined,
      mistral: keys.mistral
        ? () => mistralTranscribe(clip, keys.mistral!, doFetch, contextBias)
        : undefined,
    };
  const attempts = order
    .map((provider) => ({ provider, run: runners[provider] }))
    .filter((a): a is { provider: VoiceProvider; run: () => Promise<TranscribeSuccess> } =>
      Boolean(a.run),
    );
  if (attempts.length === 0) {
    throw new Error(
      'No speech-to-text API key available — set OPENROUTER_API_KEY in ~/.config/agents/.env ' +
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
  throw new Error(`Speech-to-text failed — ${failures.join('; ')}`);
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
): Promise<TranscribeSuccess> {
  const model = prefs?.sttModel?.trim() || DEFAULT_STT_MODEL;
  const res = await doFetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: sttPrompt(contextBias) },
            { type: 'input_audio', input_audio: { data: clip.data, format: clip.format } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };
  if (body.error) throw new Error(body.error.message || 'provider error');
  const text = body.choices?.[0]?.message?.content ?? '';
  if (!text.trim()) throw new Error('empty transcript from provider');
  return { text, provider: 'openrouter', producer: 'openrouter-batch' };
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

async function mistralTranscribe(
  clip: VoiceAudioClip,
  apiKey: string,
  doFetch: FetchLike,
  contextBias: readonly string[] = [],
): Promise<TranscribeSuccess> {
  const form = new FormData();
  form.set('model', MISTRAL_STT_MODEL);
  // `context_bias` is a repeatable form field (up to 100 phrases) on this
  // endpoint — one field per phrase, not a joined list (design note 04 §2.3).
  // Capped here too: the resolver, schema and Settings UI already enforce
  // MAX_CONTEXT_BIAS, so this is defence-in-depth at the emission itself.
  for (const phrase of contextBias.slice(0, MAX_CONTEXT_BIAS)) form.append('context_bias', phrase);
  const bytes = base64ToBytes(clip.data);
  form.set('file', new Blob([bytes], { type: 'audio/wav' }), 'clip.wav');
  const res = await doFetch(`${MISTRAL_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { text?: string; message?: string };
  if (body.message && !body.text) throw new Error(body.message);
  const text = body.text ?? '';
  if (!text.trim()) throw new Error('empty transcript from provider');
  return { text, provider: 'mistral', producer: 'mistral-batch' };
}

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
