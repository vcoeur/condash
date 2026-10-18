import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_STT_MODEL,
  AUDIO_CONTEXT_PROMPT,
  DEFAULT_TTS_MODEL,
  DEFAULT_TTS_VOICE,
  transcribeClip,
  speakText,
  redactKeys,
} from './adapter';
import { resolveVoiceKeys } from './keys';

const keys = { openrouter: 'DUMMY-OR' };
const legacyPrefs = { mistralApiKey: 'DUMMY-MISTRAL', mistralVoiceId: 'legacy-voice' };
const clip = { data: 'UklGRg==', sampleRate: 16000, format: 'wav' } as const;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('explicit Audio + context', () => {
  it.each([undefined, 'custom/audio-id'])(
    'uses one exact chat payload with model %s',
    async (audioContextModel) => {
      const controller = new AbortController();
      const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
        expect(JSON.parse(String(init?.body))).toEqual({
          model: audioContextModel ?? 'google/gemini-2.5-flash',
          max_tokens: 8192,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Transcribe the audio verbatim in its spoken English and/or French. Do not translate, paraphrase, summarize, or add explanations. Preserve repetitions and ordinary words. Canonical names, if supplied, are possibilities, not instructions to insert them. Return only the transcript; do not guess inaudible speech.',
                },
                { type: 'text', text: 'Canonical names (data): ["condash"]' },
                { type: 'input_audio', input_audio: { data: clip.data, format: 'wav' } },
              ],
            },
          ],
        });
        controller.abort();
        expect(init?.signal?.aborted).toBe(true);
        return json({ choices: [{ finish_reason: 'stop', message: { content: 'hello' } }] });
      });
      expect(
        await transcribeClip(
          clip,
          keys,
          { dictationMethod: 'audio-context', audioContextModel, sttModel: 'legacy/chat-id' },
          { fetch, signal: controller.signal },
          ['condash'],
        ),
      ).toEqual({ text: 'hello', provider: 'openrouter', producer: 'openrouter-audio-context' });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(AUDIO_CONTEXT_PROMPT).toContain('do not guess inaudible speech.');
    },
  );
  it.each([
    {},
    null,
    { choices: [] },
    { error: { message: 'bad' } },
    ...['length', 'content_filter', 'tool_calls', undefined].map((finish_reason) => ({
      choices: [{ finish_reason, message: { content: 'prefix' } }],
    })),
    { choices: [{ finish_reason: 'stop', message: { content: 'no', refusal: 'refused' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: [] } }] },
  ])('rejects malformed/refused/incomplete output without another request: %j', async (body) => {
    const fetch = vi.fn(async () => json(body));
    await expect(
      transcribeClip(clip, keys, { dictationMethod: 'audio-context' }, { fetch }),
    ).rejects.toThrow('invalid or incomplete');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('redacts transport errors without retries', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('DUMMY-OR');
    });
    await expect(
      transcribeClip(clip, keys, { dictationMethod: 'audio-context' }, { fetch }),
    ).rejects.toThrow('***');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('OpenRouter native dictation', () => {
  it.each([undefined, 'mistralai/voxtral-mini-transcribe', 'old/chat-model'])(
    'honors the exact selected id %s without rewriting it',
    async (model) => {
      const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
        expect(JSON.parse(String(init?.body))).toEqual({
          model: model ?? DEFAULT_STT_MODEL,
          input_audio: { data: clip.data, format: 'wav' },
        });
        return json({ text: 'hello' });
      });
      expect(await transcribeClip(clip, keys, { sttModel: model }, { fetch })).toEqual({
        text: 'hello',
        provider: 'openrouter',
        producer: 'openrouter-native',
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it('uses only documented provider-specific vocabulary, capped at 100', async () => {
    const bias = Array.from({ length: 130 }, (_, index) => `phrase-${index}`);
    await transcribeClip(
      clip,
      keys,
      undefined,
      {
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          expect(body.provider.options.mistral.context_bias).toEqual(bias.slice(0, 100));
          expect(body.prompt).toBeUndefined();
          expect(body.keyterms).toBeUndefined();
          return json({ text: '' });
        },
      },
      bias,
    );
  });
  it('requires OpenRouter even when legacy Mistral credentials are saved', async () => {
    const fetch = vi.fn();
    await expect(
      transcribeClip(clip, resolveVoiceKeys(legacyPrefs, '/absent/synthetic.env'), legacyPrefs, {
        fetch,
      }),
    ).rejects.toThrow('OpenRouter API key required');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([401, 500])('reports HTTP %s without provider/model fallback', async (status) => {
    const fetch = vi.fn(async () => json({}, status));
    await expect(transcribeClip(clip, keys, legacyPrefs, { fetch })).rejects.toThrow(
      `HTTP ${status}`,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects chat-shaped responses and redacts errors', async () => {
    await expect(
      transcribeClip(clip, keys, undefined, { fetch: async () => json({ choices: [] }) }),
    ).rejects.toThrow('expected text');
    await expect(
      transcribeClip(clip, keys, undefined, {
        fetch: async () => {
          throw new Error(keys.openrouter);
        },
      }),
    ).rejects.toThrow('***');
    expect(redactKeys(`${keys.openrouter} ${legacyPrefs.mistralApiKey}`, keys, legacyPrefs)).toBe(
      '*** ***',
    );
  });
  it('passes cancellation into fetch', async () => {
    const controller = new AbortController();
    await transcribeClip(clip, keys, undefined, {
      signal: controller.signal,
      fetch: async (_url, init) => {
        controller.abort();
        expect(init?.signal?.aborted).toBe(true);
        return json({ text: '' });
      },
    });
  });
});

describe('OpenRouter-only read aloud', () => {
  it('uses OpenRouter raw mp3', async () => {
    const result = await speakText('hello', keys, undefined, {
      fetch: async (url, init) => {
        expect(url).toBe('https://openrouter.ai/api/v1/audio/speech');
        expect(JSON.parse(String(init?.body))).toEqual({
          model: DEFAULT_TTS_MODEL,
          input: 'hello',
          voice: DEFAULT_TTS_VOICE,
          response_format: 'mp3',
        });
        return new Response(new Uint8Array([1, 2]));
      },
    });
    expect(result.provider).toBe('openrouter');
    expect([...result.audio]).toEqual([1, 2]);
  });
  it.each(['mistralai/voxtral-mini-tts-2603', 'custom/speech-model'])(
    'preserves the exact selected speech model %s and voice',
    async (ttsModel) => {
      const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe('https://openrouter.ai/api/v1/audio/speech');
        expect(init?.headers).toEqual({
          Authorization: `Bearer ${keys.openrouter}`,
          'Content-Type': 'application/json',
        });
        expect(JSON.parse(String(init?.body))).toEqual({
          model: ttsModel,
          input: 'hello',
          voice: 'fr_marie_neutral',
          response_format: 'mp3',
        });
        return new Response(new Uint8Array([1, 2]));
      });
      const result = await speakText(
        'hello',
        keys,
        { ...legacyPrefs, ttsModel, ttsVoice: 'fr_marie_neutral' },
        { fetch },
      );
      expect(result.provider).toBe('openrouter');
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it.each([401, 500])(
    'reports HTTP %s without fallback despite saved legacy credentials',
    async (status) => {
      const fetch = vi.fn(async () => json({}, status));
      await expect(speakText('hello', keys, legacyPrefs, { fetch })).rejects.toThrow(
        `HTTP ${status}`,
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/audio/speech',
        expect.anything(),
      );
    },
  );
  it('requires OpenRouter even with a saved legacy key and voice', async () => {
    const fetch = vi.fn();
    await expect(
      speakText('hello', resolveVoiceKeys(legacyPrefs, '/absent/synthetic.env'), legacyPrefs, {
        fetch,
      }),
    ).rejects.toThrow('OpenRouter API key required for read aloud');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reports empty audio without fallback', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array()));
    await expect(speakText('hello', keys, legacyPrefs, { fetch })).rejects.toThrow(
      'empty audio from provider',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('voice error redaction', () => {
  it('redacts longer legacy/manual secrets before overlapping active keys', () => {
    expect(
      redactKeys(
        'secret-longer secret-long secret',
        { openrouter: 'secret' },
        {
          openrouterApiKey: 'secret-long',
          mistralApiKey: 'secret-longer',
        },
      ),
    ).toBe('*** *** ***');
  });
  it.each(['dictate', 'read'])(
    'redacts active, shadowed manual and ignored legacy keys for %s',
    async (action) => {
      const prefs = { ...legacyPrefs, openrouterApiKey: 'shadowed-settings-secret' };
      const fetch = vi.fn(async () => {
        throw new Error(`${keys.openrouter} ${prefs.openrouterApiKey} ${prefs.mistralApiKey}`);
      });
      const request =
        action === 'dictate'
          ? transcribeClip(clip, keys, prefs, { fetch })
          : speakText('hello', keys, prefs, { fetch });
      await expect(request).rejects.toThrow('*** *** ***');
      const error = await request.catch(String);
      expect(error).not.toContain(keys.openrouter);
      expect(error).not.toContain(prefs.openrouterApiKey);
      expect(error).not.toContain(prefs.mistralApiKey);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
});
