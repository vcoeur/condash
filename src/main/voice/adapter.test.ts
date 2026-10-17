import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_STT_MODEL,
  DEFAULT_TTS_MODEL,
  DEFAULT_TTS_VOICE,
  transcribeClip,
  speakText,
  redactKeys,
} from './adapter';

const keys = { openrouter: 'DUMMY-OR', mistral: 'DUMMY-MISTRAL' };
const clip = { data: 'UklGRg==', sampleRate: 16000, format: 'wav' } as const;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

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
  it('requires OpenRouter even when a Mistral key is available', async () => {
    const fetch = vi.fn();
    await expect(
      transcribeClip(clip, { mistral: keys.mistral }, undefined, { fetch }),
    ).rejects.toThrow('OpenRouter API key required');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([401, 500])('reports HTTP %s without provider/model fallback', async (status) => {
    const fetch = vi.fn(async () => json({}, status));
    await expect(transcribeClip(clip, keys, undefined, { fetch })).rejects.toThrow(
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
    expect(redactKeys(`${keys.openrouter} ${keys.mistral}`, keys)).toBe('*** ***');
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

describe('read aloud retains its independent fallback', () => {
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
  it('falls back to Mistral speech with a voice id', async () => {
    const result = await speakText(
      'hello',
      keys,
      { mistralVoiceId: 'voice' },
      {
        fetch: async (url, init) => {
          if (url.includes('openrouter')) return json({}, 500);
          expect(url).toBe('https://api.mistral.ai/v1/audio/speech');
          expect(JSON.parse(String(init?.body)).voice_id).toBe('voice');
          return json({ audio_data: 'AQI=' });
        },
      },
    );
    expect(result.provider).toBe('mistral');
  });
  it('requires a Mistral voice id and redacts both failures', async () => {
    await expect(
      speakText('x', keys, undefined, { fetch: async () => json({}, 500) }),
    ).rejects.toThrow('Mistral TTS fallback needs a voice id');
    await expect(speakText('x', {}, undefined)).rejects.toThrow('No text-to-speech API key');
  });
});
