import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_STT_MODEL,
  DEFAULT_TTS_MODEL,
  DEFAULT_TTS_VOICE,
  MISTRAL_STT_MODEL,
  redactKeys,
  speakText,
  transcribeClip,
} from './adapter';
import type { FetchLike } from './adapter';

const OPENROUTER_KEY = 'sk-or-v1-test-key-AAAA';
const MISTRAL_KEY = 'mistral-test-key-BBBB';
const KEYS = { openrouter: OPENROUTER_KEY, mistral: MISTRAL_KEY };
const CLIP = { data: 'UklGRg==', sampleRate: 16000, format: 'wav' } as const;

/** A fetch stub returning the first non-matching response (or throwing). */
function fetchSequence(
  responses: { match?: (url: string, init?: RequestInit) => boolean; reply: () => Response }[],
): FetchLike {
  return (url, init) => {
    const hit = responses.find((r) => !r.match || r.match(url, init));
    if (!hit) return Promise.reject(new Error('unexpected fetch ' + url));
    return Promise.resolve(hit.reply());
  };
}

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const audioRes = (bytes: number[]): Response =>
  new Response(new Uint8Array(bytes), { status: 200 });

afterEach(() => {
  delete process.env.CONDASH_AGENTS_ENV;
});

describe('transcribeClip', () => {
  it('prefers OpenRouter and parses the chat-completion transcript', async () => {
    const calls: string[] = [];
    const result = await transcribeClip(CLIP, KEYS, undefined, {
      fetch: (url, init) => {
        calls.push(url);
        expect(url).toContain('https://openrouter.ai/api/v1/chat/completions');
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe(DEFAULT_STT_MODEL);
        expect(body.messages[0].content[1].input_audio).toEqual({
          data: CLIP.data,
          format: 'wav',
        });
        return Promise.resolve(jsonRes({ choices: [{ message: { content: 'hello world' } }] }));
      },
    });
    expect(result).toEqual({ text: 'hello world', provider: 'openrouter' });
    expect(calls).toHaveLength(1);
  });

  it('falls back to Mistral when OpenRouter returns an HTTP error', async () => {
    const seen: string[] = [];
    const result = await transcribeClip(CLIP, KEYS, undefined, {
      fetch: (url, init) => {
        seen.push(url);
        if (url.includes('openrouter')) return Promise.resolve(jsonRes({}, 500));
        expect(url).toContain('https://api.mistral.ai/v1/audio/transcriptions');
        const form = init?.body as FormData;
        expect(form.get('model')).toBe(MISTRAL_STT_MODEL);
        return Promise.resolve(jsonRes({ text: 'from mistral' }));
      },
    });
    expect(result).toEqual({ text: 'from mistral', provider: 'mistral' });
    expect(seen).toHaveLength(2);
  });

  it('falls back to Mistral when OpenRouter has no key at all', async () => {
    const seen: string[] = [];
    const result = await transcribeClip(CLIP, { mistral: MISTRAL_KEY }, undefined, {
      fetch: (url) => {
        seen.push(String(url));
        return Promise.resolve(jsonRes({ text: 'fallback' }));
      },
    });
    expect(result.provider).toBe('mistral');
    expect(seen.every((u) => u.includes('mistral'))).toBe(true);
  });

  it('names every missing key when none is available', async () => {
    await expect(
      transcribeClip(CLIP, {}, undefined, { fetch: async () => jsonRes({}) }),
    ).rejects.toThrow(/No speech-to-text API key/);
  });

  it('reports both providers when both fail, and never echoes a key', async () => {
    await expect(
      transcribeClip(CLIP, KEYS, undefined, {
        fetch: () => Promise.resolve(jsonRes({}, 401)),
      }),
    ).rejects.toThrow(/Speech-to-text failed — openrouter: HTTP 401; mistral: HTTP 401/);
  });

  it('honours the configured OpenRouter STT model override', async () => {
    await transcribeClip(
      CLIP,
      KEYS,
      { sttModel: 'custom/audio-model' },
      {
        fetch: (_url, init) => {
          expect(JSON.parse(String(init?.body)).model).toBe('custom/audio-model');
          return Promise.resolve(jsonRes({ choices: [{ message: { content: 'x' } }] }));
        },
      },
    );
  });

  it('uses the wav container the renderer guarantees', async () => {
    let seenFormat = '';
    await transcribeClip(CLIP, { openrouter: OPENROUTER_KEY }, undefined, {
      fetch: (_url, init) => {
        seenFormat = JSON.parse(String(init?.body)).messages[0].content[1].input_audio.format;
        return Promise.resolve(jsonRes({ choices: [{ message: { content: 'x' } }] }));
      },
    });
    expect(seenFormat).toBe('wav');
  });
});

describe('speakText', () => {
  it('prefers OpenRouter /audio/speech and returns raw mp3 bytes', async () => {
    const result = await speakText('read this', KEYS, undefined, {
      fetch: (url, init) => {
        expect(url).toContain('https://openrouter.ai/api/v1/audio/speech');
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({
          model: DEFAULT_TTS_MODEL,
          input: 'read this',
          voice: DEFAULT_TTS_VOICE,
          response_format: 'mp3',
        });
        return Promise.resolve(audioRes([1, 2, 3, 4]));
      },
    });
    expect(result.provider).toBe('openrouter');
    expect(Array.from(result.audio)).toEqual([1, 2, 3, 4]);
  });

  it('falls back to Mistral on OpenRouter failure and decodes base64 audio_data', async () => {
    const result = await speakText(
      'read this',
      KEYS,
      { mistralVoiceId: 'my-voice' },
      {
        fetch: fetchSequence([
          { match: (u) => u.includes('openrouter'), reply: () => jsonRes({}, 500) },
          {
            match: (u) => u.includes('api.mistral.ai/v1/audio/speech'),
            reply: () => jsonRes({ audio_data: Buffer.from([9, 8, 7]).toString('base64') }),
          },
        ]),
      },
    );
    expect(result.provider).toBe('mistral');
    expect(Array.from(result.audio)).toEqual([9, 8, 7]);
  });

  it('skips the Mistral TTS fallback when no voice id is configured', async () => {
    const seen: string[] = [];
    await expect(
      speakText('read this', KEYS, undefined, {
        fetch: (url) => {
          seen.push(String(url));
          return Promise.resolve(jsonRes({}, 500));
        },
      }),
    ).rejects.toThrow(/Mistral TTS fallback needs a voice id/);
    expect(seen.every((u) => u.includes('openrouter'))).toBe(true);
  });

  it('names the missing key when nothing is available', async () => {
    await expect(speakText('x', {}, undefined, { fetch: async () => jsonRes({}) })).rejects.toThrow(
      /No text-to-speech API key/,
    );
  });

  it('reports both failures with redacted messages', async () => {
    await expect(
      speakText(
        'x',
        KEYS,
        { mistralVoiceId: 'v' },
        {
          fetch: () => Promise.resolve(jsonRes({}, 403)),
        },
      ),
    ).rejects.toThrow(/Text-to-speech failed — openrouter: HTTP 403; mistral: HTTP 403/);
  });
});

describe('redactKeys', () => {
  it('removes every configured key from the text', () => {
    const leaked = `bad request near ${OPENROUTER_KEY} and ${MISTRAL_KEY} end`;
    expect(redactKeys(leaked, KEYS)).toBe('bad request near *** and *** end');
  });

  it('leaves text without keys untouched', () => {
    expect(redactKeys('HTTP 401', KEYS)).toBe('HTTP 401');
  });
});
