/**
 * Unit tests for the realtime dictation stream (design note 04 §3, §10).
 *
 * The socket edge is faked (`createSocket` injection); the commit path runs
 * the REAL `insertTranscript` with stub liveness/write edges so the
 * sanitise-once / liveness / single-write guarantees are pinned through the
 * stream path too. The two batch chains are fakes — they are the existing
 * adapter surface, already covered by adapter.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  TARGET_STREAMING_DELAY_MS,
  beginVoiceStream,
  cancelActiveVoiceStream as cancelOwned,
  getActiveVoiceStream,
  takeActiveVoiceStream as takeOwned,
} from './stream';
import type { RealtimeSocket, VoiceStreamSessionDeps } from './stream';
import { insertTranscript } from './insert';

type MessageHandler = (data: Buffer, isBinary: boolean) => void;

class FakeSocket implements RealtimeSocket {
  sent: { data: string | Buffer; binary?: boolean }[] = [];
  closed = false;
  private listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  private messageListeners: MessageHandler[] = [];

  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): void;
  // The impl signature must accept every overload's listener shape.
  on(event: string, listener: (...args: any[]) => void): void {
    if (event === 'message') this.messageListeners.push(listener as MessageHandler);
    (this.listeners[event] ??= []).push(listener);
  }

  send(data: string | Buffer, options?: { binary?: boolean }): void {
    this.sent.push({ data, binary: options?.binary });
  }

  close(): void {
    this.closed = true;
  }

  terminate(): void {
    this.closed = true;
  }

  emitOpen(): void {
    for (const l of this.listeners.open ?? []) l();
  }

  emitText(obj: unknown): void {
    const payload = Buffer.from(JSON.stringify(obj));
    for (const l of this.messageListeners) l(payload, false);
  }

  emitError(err: Error): void {
    for (const l of this.listeners.error ?? []) l(err);
  }

  emitClose(code = 1005): void {
    for (const l of this.listeners.close ?? []) l(code, Buffer.alloc(0));
  }

  textMessages(): unknown[] {
    return this.sent
      .filter((s) => typeof s.data === 'string')
      .map((s) => JSON.parse(String(s.data)));
  }

  binaryBytes(): number {
    return this.sent
      .filter((s) => Buffer.isBuffer(s.data) && s.binary)
      .reduce((n, s) => n + (s.data as Buffer).length, 0);
  }
}

interface Harness {
  sockets: FakeSocket[];
  partials: string[];
  writes: { sid: string; text: string }[];
  batchNormal: ReturnType<typeof vi.fn>;
  batchBiasFirst: ReturnType<typeof vi.fn>;
  deps: VoiceStreamSessionDeps;
  start(): ReturnType<typeof beginVoiceStream>;
}

function makeDeps(overrides: Record<string, unknown> = {}): VoiceStreamSessionDeps {
  return {
    sid: 's1',
    ownerId: randomUUID(),
    apiKey: 'mistral-secret-key-AAAA',
    contextBias: [] as string[],
    keys: { openrouter: undefined, mistral: 'mistral-secret-key-AAAA' },
    prefs: undefined,
    createSocket: undefined,
    onPartial: undefined,
    insert: (sid: string, text: string) =>
      insertTranscript(sid, text, {
        isLive: (target) => target === 's1',
        write: (target, data) => harness.writes.push({ sid: target, text: data }),
      }),
    batchTranscribers: undefined,
    connectTimeoutMs: 200,
    finaliseTimeoutMs: 200,
    ...overrides,
  } as unknown as VoiceStreamSessionDeps;
}

let harness!: Harness;

const cancelActiveVoiceStream = () => {
  const session = getActiveVoiceStream();
  if (session) cancelOwned(session.ownerId);
};
const takeActiveVoiceStream = () => takeOwned(harness.deps.ownerId);

async function makeHarness(overrides: Record<string, unknown> = {}): Promise<void> {
  // The single-active-slot is module state — clear it so every test starts
  // from "no stream".
  cancelActiveVoiceStream();
  const sockets: FakeSocket[] = [];
  const partials: string[] = [];
  const writes: { sid: string; text: string }[] = [];
  const batchNormal = vi.fn(async () => ({
    text: 'batch normal text',
    provider: 'openrouter' as const,
  }));
  const batchBiasFirst = vi.fn(async () => ({
    text: 'bias first text',
    provider: 'mistral' as const,
  }));
  const deps = makeDeps({
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onPartial: (text: string) => partials.push(text),
    batchTranscribers: { normal: batchNormal, biasFirst: batchBiasFirst },
    ...overrides,
  });
  const start = () => beginVoiceStream(deps);
  harness = { sockets, partials, writes, batchNormal, batchBiasFirst, deps, start };
}

describe('voice stream session', () => {
  it('opens with the model query and the Authorization header, and configures the delay knob', async () => {
    await makeHarness();
    const starting = harness.start();
    const socket = harness.sockets[0];
    socket.emitOpen();
    socket.emitText({ type: 'session.created', session: {} });
    const result = await starting;
    expect(result.ok).toBe(true);
    // One socket was created; the key travelled only in its headers.
    expect(harness.sockets).toHaveLength(1);
    await vi.waitFor(() => {
      expect(socket.textMessages()).toEqual([
        {
          type: 'session.update',
          session: { target_streaming_delay_ms: TARGET_STREAMING_DELAY_MS },
        },
      ]);
    });
    expect(JSON.stringify(socket.textMessages())).not.toContain('mistral-secret-key-AAAA');
  });

  it('refuses a second start with already-active while one stream is live', async () => {
    await makeHarness();
    const first = harness.start();
    harness.sockets[0].emitOpen();
    await first;
    const second = await harness.start();
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('already-active');
    cancelActiveVoiceStream();
  });

  it('answers a typed error refusal when the socket fails to open', async () => {
    await makeHarness();
    const starting = harness.start();
    harness.sockets[0].emitError(new Error('ECONNREFUSED'));
    const result = await starting;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('error');
    expect(getActiveVoiceStream()).toBeNull();
  });

  it('forwards PCM frames as binary and buffers the pre-open tail', async () => {
    await makeHarness();
    const starting = harness.start();
    // The session exists synchronously — audio may arrive before the
    // upgrade lands and must not be lost from the stream.
    const session = getActiveVoiceStream()!;
    const socket = harness.sockets[0];
    session.handleAudio(Buffer.from([1, 2, 3, 4]).toString('base64'));
    socket.emitOpen();
    await starting;
    session.handleAudio(Buffer.from([5, 6, 7, 8]).toString('base64'));
    expect(socket.binaryBytes()).toBe(8); // buffered + live chunk both went out
    cancelActiveVoiceStream();
  });

  it('accumulates deltas into accumulated partial pushes', async () => {
    await makeHarness();
    const starting = harness.start();
    const socket = harness.sockets[0];
    socket.emitOpen();
    await starting;
    socket.emitText({ type: 'transcription.text.delta', text: 'hello ' });
    socket.emitText({ type: 'transcription.text.delta', text: 'world' });
    expect(harness.partials).toEqual(['hello ', 'hello world']);
    cancelActiveVoiceStream();
  });

  it('finalises on done and commits the sanitised text exactly once through insertTranscript', async () => {
    await makeHarness();
    const starting = harness.start();
    const socket = harness.sockets[0];
    socket.emitOpen();
    await starting;
    socket.emitText({ type: 'transcription.text.delta', text: 'run condash\x00 status' });
    socket.emitText({ type: 'transcription.done', text: 'run condash\x00 status' });
    const session = takeActiveVoiceStream()!;
    const result = await session.stop();
    // \x00 is stripped by the sanitiser; the write carries the clean text.
    expect(harness.writes).toEqual([{ sid: 's1', text: 'run condash status' }]);
    expect(result).toEqual({
      inserted: true,
      provider: 'mistral',
      chars: 'run condash status'.length,
    });
  });

  it('waits bounded on stop when no done arrives, committing the accumulated text', async () => {
    await makeHarness();
    const starting = harness.start();
    const socket = harness.sockets[0];
    socket.emitOpen();
    await starting;
    socket.emitText({ type: 'transcription.text.delta', text: 'partial only' });
    const session = takeActiveVoiceStream()!;
    const result = await session.stop();
    expect(result).toEqual({ inserted: true, provider: 'mistral', chars: 'partial only'.length });
    expect(harness.writes).toHaveLength(1);
  });

  it('sends input_audio.end on stop', async () => {
    await makeHarness();
    const starting = harness.start();
    const socket = harness.sockets[0];
    socket.emitOpen();
    await starting;
    const session = takeActiveVoiceStream()!;
    const stopping = session.stop();
    socket.emitText({ type: 'transcription.done', text: '' });
    await stopping;
    const events = socket.textMessages().map((m) => (m as { type: string }).type);
    expect(events).toContain('input_audio.end');
  });

  it('commit is once-only: a second stop does not re-insert', async () => {
    await makeHarness();
    const starting = harness.start();
    const socket = harness.sockets[0];
    socket.emitOpen();
    await starting;
    const session = takeActiveVoiceStream()!;
    const stopping = session.stop();
    socket.emitText({ type: 'transcription.done', text: 'only once' });
    await stopping;
    await session.stop();
    expect(harness.writes).toHaveLength(1);
  });

  it('cancels without inserting anything', async () => {
    await makeHarness();
    const starting = harness.start();
    const socket = harness.sockets[0];
    socket.emitOpen();
    await starting;
    socket.emitText({ type: 'transcription.text.delta', text: 'never committed' });
    cancelActiveVoiceStream();
    expect(getActiveVoiceStream()).toBeNull();
    expect(harness.writes).toEqual([]);
  });

  it('routes the commit through the bias-first repass when the bias list is non-empty', async () => {
    await makeHarness({ contextBias: ['condash', 'knoten'] });
    const starting = harness.start();
    const socket = harness.sockets[0];
    socket.emitOpen();
    await starting;
    const session = getActiveVoiceStream()!;
    session.handleAudio(Buffer.alloc(1600 * 2).toString('base64')); // 100 ms of PCM
    socket.emitText({ type: 'transcription.done', text: 'stream text' });
    await takeActiveVoiceStream()!.stop();
    expect(harness.batchBiasFirst).toHaveBeenCalledTimes(1);
    const clip = harness.batchBiasFirst.mock.calls[0][0];
    expect(clip.format).toBe('wav');
    expect(clip.sampleRate).toBe(16000);
    // The reassembled WAV carries exactly the PCM the session received.
    expect(Buffer.from(clip.data, 'base64').length).toBe(44 + 1600 * 2);
    expect(harness.writes).toEqual([{ sid: 's1', text: 'bias first text' }]);
    expect(harness.batchNormal).not.toHaveBeenCalled();
  });

  it('labels the reassembled repass clip with the captured sample rate, not a hardcoded 16 kHz', async () => {
    // NIT-2 (note 06): the session start carries the rate the renderer's mic
    // actually captured at; the repass WAV header must mirror it the way the
    // recorder's own clip does, instead of assuming the requested 16 kHz.
    await makeHarness({ sampleRate: 48000, contextBias: ['condash'] });
    const starting = harness.start();
    const socket = harness.sockets[0];
    socket.emitOpen();
    await starting;
    const session = getActiveVoiceStream()!;
    session.handleAudio(Buffer.alloc(1600 * 2).toString('base64')); // 100 ms of PCM
    socket.emitText({ type: 'transcription.done', text: 'stream text' });
    await takeActiveVoiceStream()!.stop();
    const clip = harness.batchBiasFirst.mock.calls[0][0];
    expect(clip.sampleRate).toBe(48000);
    const wav = Buffer.from(clip.data, 'base64');
    // RIFF header: sample rate at offset 24, byte rate (rate × mono × 2 B) at 28.
    expect(wav.readUInt32LE(24)).toBe(48000);
    expect(wav.readUInt32LE(28)).toBe(96000);
    // The PCM byte count is rate-independent — same size pin as above.
    expect(wav.length).toBe(44 + 1600 * 2);
    expect(harness.writes).toEqual([{ sid: 's1', text: 'bias first text' }]);
  });

  it('falls back to the realtime text when the bias repass fails (last resort)', async () => {
    await makeHarness({
      contextBias: ['condash'],
      batchTranscribers: {
        normal: vi.fn(),
        biasFirst: vi.fn(async () => {
          throw new Error('both batch providers down');
        }),
      },
    });
    const starting = harness.start();
    const socket = harness.sockets[0];
    socket.emitOpen();
    await starting;
    const session = getActiveVoiceStream()!;
    session.handleAudio(Buffer.alloc(3200).toString('base64'));
    socket.emitText({ type: 'transcription.done', text: 'stream text' });
    await takeActiveVoiceStream()!.stop();
    expect(harness.writes).toEqual([{ sid: 's1', text: 'stream text' }]);
  });

  it('runs the normal batch chain on the reassembled clip when the stream failed mid-way', async () => {
    await makeHarness();
    const starting = harness.start();
    const socket = harness.sockets[0];
    socket.emitOpen();
    await starting;
    const session = getActiveVoiceStream()!;
    session.handleAudio(Buffer.alloc(3200).toString('base64'));
    socket.emitError(new Error('upstream 500'));
    await takeActiveVoiceStream()!.stop();
    expect(harness.batchNormal).toHaveBeenCalledTimes(1);
    expect(harness.writes).toEqual([{ sid: 's1', text: 'batch normal text' }]);
  });

  it('answers the typed empty-transcript no-op when the stream committed nothing usable', async () => {
    await makeHarness();
    const starting = harness.start();
    const socket = harness.sockets[0];
    socket.emitOpen();
    await starting;
    const session = getActiveVoiceStream()!;
    socket.emitText({ type: 'transcription.done', text: '' });
    const result = await takeActiveVoiceStream()!.stop();
    // Empty transcript → the same typed no-op the batch path answers.
    expect(result).toEqual({ inserted: false, reason: 'empty-transcript' });
    expect(session.sid).toBe('s1');
  });
});
