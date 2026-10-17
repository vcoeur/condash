import { beforeEach, expect, it, vi } from 'vitest';
import { VoiceStreamSessionImpl, MAX_RECORDING_BYTES } from './stream-session';
import { transcribeClip } from './adapter';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  for (let index = 0; index < 10; index++) await Promise.resolve();
};
function fixture(rate = 16000, previews = true) {
  const requests: {
    wav: Buffer;
    model: string;
    signal: AbortSignal;
    gate: ReturnType<typeof deferred<Response>>;
  }[] = [];
  const onPartial = vi.fn();
  const onUnavailable = vi.fn();
  const insert = vi.fn(() => ({ inserted: true as const, chars: 5 }));
  const session = new VoiceStreamSessionImpl({
    ownerId: 'owner',
    sid: 'captured-tab',
    sampleRate: rate,
    previews,
    onPartial,
    onUnavailable,
    insert,
    transcribe: (clip, signal) =>
      transcribeClip(
        clip,
        { openrouter: 'DUMMY', mistral: 'NEVER' },
        { sttModel: 'selected/native-id' },
        {
          signal,
          fetch: async (url, init) => {
            expect(url).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
            const body = JSON.parse(String(init?.body));
            const gate = deferred<Response>();
            requests.push({
              wav: Buffer.from(body.input_audio.data, 'base64'),
              model: body.model,
              signal: init!.signal!,
              gate,
            });
            return gate.promise;
          },
        },
        ['ProjectWord'],
      ),
  });
  const audio = (seconds: number, value = 1) => {
    const data = Buffer.alloc(seconds * rate * 2);
    for (let index = 0; index < data.length; index += 2) data.writeInt16LE(value, index);
    session.handleAudio(data.toString('base64'));
  };
  const reply = async (index: number, text: string) => {
    requests[index].gate.resolve(new Response(JSON.stringify({ text })));
    await flush();
  };
  return { session, requests, audio, reply, onPartial, onUnavailable, insert };
}
beforeEach(() => vi.clearAllMocks());

it('previews before Stop, uses contiguous non-overlapping WAVs, then one full same-model final', async () => {
  const f = fixture(48000);
  f.audio(2, 11);
  expect(f.requests).toHaveLength(1);
  f.audio(2, 22);
  f.audio(2, 33);
  expect(f.requests).toHaveLength(1);
  await f.reply(0, 'first words');
  await vi.waitFor(() => expect(f.requests).toHaveLength(2));
  expect(f.onPartial).toHaveBeenLastCalledWith('first words');
  expect(f.insert).not.toHaveBeenCalled();
  expect(f.requests).toHaveLength(2);
  await f.reply(1, 'next words');
  await vi.waitFor(() => expect(f.onPartial).toHaveBeenLastCalledWith('first words next words'));
  const stopping = f.session.stop();
  expect(f.requests).toHaveLength(3);
  await f.reply(2, 'Corrected full final');
  expect(await stopping).toMatchObject({ inserted: true, producer: 'openrouter-native' });
  expect(f.insert).toHaveBeenCalledTimes(1);
  expect(f.insert).toHaveBeenCalledWith('captured-tab', 'Corrected full final');
  const [first, next, final] = f.requests.map((request) => request.wav);
  for (const request of f.requests) {
    expect(request.model).toBe('selected/native-id');
    expect(request.wav.readUInt32LE(24)).toBe(48000);
  }
  expect(Buffer.concat([first.subarray(44), next.subarray(44)])).toEqual(final.subarray(44));
  expect(f.requests.reduce((sum, request) => sum + request.wav.length - 44, 0)).toBe(
    2 * (final.length - 44),
  );
  expect(await f.session.stop()).toMatchObject({ inserted: false });
});
it('aborts an outstanding preview at Stop and ignores its late result', async () => {
  const f = fixture();
  f.audio(2);
  const stopping = f.session.stop();
  expect(f.requests[0].signal.aborted).toBe(true);
  await f.reply(0, 'late preview');
  expect(f.onPartial).not.toHaveBeenCalled();
  await f.reply(1, 'final');
  await stopping;
  expect(f.insert).toHaveBeenCalledTimes(1);
});
it('bounds the pending window, visibly stops admissions, retains the full final recording', async () => {
  const f = fixture();
  f.audio(2);
  f.audio(8);
  expect(f.onUnavailable).not.toHaveBeenCalled();
  f.audio(1);
  expect(f.onUnavailable).toHaveBeenCalledWith(expect.stringContaining('eight-second limit'));
  f.audio(2);
  await f.reply(0, 'late');
  expect(f.requests).toHaveLength(1);
  const stopping = f.session.stop();
  expect(f.requests[1].wav.length - 44).toBe(13 * 16000 * 2);
  await f.reply(1, 'all audio final');
  await stopping;
});
it('preview failure is visible and final failure never inserts preview text or retries', async () => {
  const f = fixture();
  f.audio(2);
  f.requests[0].gate.reject(new Error('Synthetic 401'));
  await flush();
  await vi.waitFor(() =>
    expect(f.onUnavailable).toHaveBeenCalledWith(expect.stringContaining('Synthetic 401')),
  );
  const stopping = f.session.stop();
  f.requests[1].gate.reject(new Error('Synthetic final failure'));
  expect(await stopping).toMatchObject({
    reason: 'error',
    error: expect.stringContaining('Synthetic final failure'),
  });
  expect(f.requests).toHaveLength(2);
  expect(f.insert).not.toHaveBeenCalled();
});
it.each(['preview', 'final'])('cancel aborts %s and fences late fetch responses', async (phase) => {
  const f = fixture();
  f.audio(2);
  const stopping = phase === 'final' ? f.session.stop() : null;
  f.session.cancel();
  for (const request of f.requests) expect(request.signal.aborted).toBe(true);
  for (let index = 0; index < f.requests.length; index++) await f.reply(index, 'stale');
  if (stopping) expect(await stopping).toMatchObject({ inserted: false });
  expect(f.onPartial).not.toHaveBeenCalled();
  expect(f.insert).not.toHaveBeenCalled();
});
it('captions off still uses the native final session with no preview call', async () => {
  const f = fixture(16000, false);
  f.audio(3);
  expect(f.requests).toHaveLength(0);
  const stopping = f.session.stop();
  await f.reply(0, 'final');
  await stopping;
  expect(f.insert).toHaveBeenCalledTimes(1);
});
it.each(['not base64', 'AAAA', 'AQ=='])(
  'rejects malformed PCM %s without transcribing a prefix',
  async (data) => {
    const f = fixture();
    f.audio(1);
    f.session.handleAudio(data);
    expect(await f.session.stop()).toMatchObject({ reason: 'error' });
    expect(f.requests).toHaveLength(0);
  },
);
it('recording cap fails explicitly, never transcribing only the retained prefix', async () => {
  const f = fixture(16000, false);
  f.session.handleAudio(Buffer.alloc(MAX_RECORDING_BYTES).toString('base64'));
  expect(await f.session.stop()).toMatchObject({
    reason: 'error',
    error: expect.stringContaining('20 MB'),
  });
  expect(f.requests).toHaveLength(0);
});
it.each([0, 1, 16000.5, NaN, 192001])('rejects unsafe rate %s', (rate) => {
  expect(() => fixture(rate)).toThrow('sample rate');
});
