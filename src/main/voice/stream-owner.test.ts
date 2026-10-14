import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import type { VoiceStreamSessionDeps } from './stream';

class Socket extends EventEmitter {
  sent: (string | Buffer)[] = [];
  closed = false;
  send(data: string | Buffer) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  terminate() {
    this.closed = true;
  }
}
const deps = (
  ownerId: string,
  socket: Socket,
  overrides: Partial<VoiceStreamSessionDeps> = {},
): VoiceStreamSessionDeps => ({
  ownerId,
  sid: 'same-tab',
  apiKey: 'DUMMY',
  keys: {},
  contextBias: [],
  createSocket: () => socket,
  onPartial: vi.fn(),
  insert: vi.fn(() => ({ inserted: true, chars: 4 })),
  batchTranscribers: { normal: vi.fn(), biasFirst: vi.fn() },
  ...overrides,
});
beforeEach(() => vi.resetModules());

it('bounded finished-owner eviction never removes genuine pre-start cancellation protection', async () => {
  const stream = await import('./stream');
  stream.cancelActiveVoiceStream('pending-protected-owner');
  for (let index = 0; index < 300; index++) {
    const admission = stream.reserveVoiceStream(`finished-${index}`);
    expect(admission.ok).toBe(true);
    if (admission.ok) stream.releaseVoiceStream(admission.reservation);
  }
  expect(stream.reserveVoiceStream('pending-protected-owner').ok).toBe(false);
  const newest = stream.reserveVoiceStream('fresh');
  expect(newest.ok).toBe(true);
  if (newest.ok) stream.releaseVoiceStream(newest.reservation);
});

it('retired cancels after refused/failed starts leave all 256 unmatched marker slots available', async () => {
  const stream = await import('./stream');
  for (let index = 0; index < 300; index++) {
    const ownerId = `finished-${index}`;
    const admission = stream.reserveVoiceStream(ownerId);
    expect(admission.ok).toBe(true);
    if (admission.ok) stream.releaseVoiceStream(admission.reservation);
    stream.cancelActiveVoiceStream(ownerId);
  }
  for (let index = 0; index < 256; index++) stream.cancelActiveVoiceStream(`unmatched-${index}`);
  const admission = stream.reserveVoiceStream('still-open');
  expect(admission.ok).toBe(true);
  if (admission.ok) stream.releaseVoiceStream(admission.reservation);
  stream.cancelActiveVoiceStream('unmatched-overflow');
  expect(stream.reserveVoiceStream('now-fail-closed').ok).toBe(false);
});

it.each(['open', 'message', 'error', 'close'])(
  'terminal cancellation suppresses a late %s independently and cannot clear a new slot',
  async (event) => {
    const stream = await import('./stream');
    const oldSocket = new Socket();
    const oldDeps = deps('old', oldSocket);
    const oldStart = stream.beginVoiceStream(oldDeps);
    stream.getActiveVoiceStream('old')!.handleAudio('AAAA');
    stream.cancelActiveVoiceStream('old');
    const socket = new Socket();
    const nextStart = stream.beginVoiceStream(deps('new', socket));
    socket.emit('open');
    expect((await nextStart).ok).toBe(true);
    if (event === 'message')
      oldSocket.emit(
        event,
        Buffer.from('{"type":"transcription.text.delta","text":"stale"}'),
        false,
      );
    else if (event === 'error') oldSocket.emit(event, new Error('stale error'));
    else if (event === 'close') oldSocket.emit(event, 1005, Buffer.alloc(0));
    else oldSocket.emit(event);
    expect((await oldStart).ok).toBe(false);
    expect(stream.getActiveVoiceStream('new')?.ownerId).toBe('new');
    expect(socket.closed).toBe(false);
    expect(oldSocket.sent).toHaveLength(0);
    expect(oldDeps.onPartial).not.toHaveBeenCalled();
    expect(oldDeps.insert).not.toHaveBeenCalled();
    stream.cancelActiveVoiceStream('new');
  },
);

it('protects exactly 256 pre-admission cancellations without expiry, then permanently refuses on overflow', async () => {
  const stream = await import('./stream');
  expect(stream.MAX_PRESTART_CANCELLATIONS).toBe(256);
  for (let index = 0; index < 256; index++) stream.cancelActiveVoiceStream(`cancel-${index}`);
  const allowed = stream.reserveVoiceStream('fresh-before-overflow');
  expect(allowed.ok).toBe(true);
  if (allowed.ok) stream.releaseVoiceStream(allowed.reservation);
  stream.cancelActiveVoiceStream('overflow');
  for (let index = 0; index < 256; index++)
    expect(stream.reserveVoiceStream(`cancel-${index}`).ok).toBe(false);
  expect(stream.reserveVoiceStream('overflow').ok).toBe(false);
  expect(stream.reserveVoiceStream('fresh-after-consumption').ok).toBe(false);
});

it('consumes a matching pre-start cancellation marker while preserving other markers', async () => {
  const stream = await import('./stream');
  stream.cancelActiveVoiceStream('cancel-a');
  stream.cancelActiveVoiceStream('cancel-b');
  expect(stream.reserveVoiceStream('cancel-a').ok).toBe(false);
  const next = stream.reserveVoiceStream('fresh');
  expect(next.ok).toBe(true);
  if (next.ok) stream.releaseVoiceStream(next.reservation);
  expect(stream.reserveVoiceStream('cancel-b').ok).toBe(false);
});

it('a stopped bias repass may finish once against its captured target while a new owner captures', async () => {
  const stream = await import('./stream');
  let finish!: (value: any) => void;
  const repass = vi.fn(
    () =>
      new Promise<any>((resolve) => {
        finish = resolve;
      }),
  );
  const socket = new Socket();
  const oldDeps = deps('old', socket, {
    contextBias: ['automatic-app'],
    batchTranscribers: { normal: vi.fn(), biasFirst: repass },
  });
  const starting = stream.beginVoiceStream(oldDeps);
  socket.emit('open');
  await starting;
  stream.getActiveVoiceStream('old')!.handleAudio('AAAA');
  socket.emit('message', Buffer.from('{"type":"transcription.done","text":"preview"}'), false);
  const stopped = stream.takeActiveVoiceStream('old')!;
  const stopping = stopped.stop();
  await Promise.resolve();
  const nextSocket = new Socket();
  const nextStart = stream.beginVoiceStream(deps('new', nextSocket));
  nextSocket.emit('open');
  await nextStart;
  stream.cancelActiveVoiceStream('old');
  expect(stream.takeActiveVoiceStream('old')).toBeNull();
  finish({ text: 'final', provider: 'mistral' });
  expect((await stopping).inserted).toBe(true);
  await stopped.stop();
  expect(oldDeps.insert).toHaveBeenCalledTimes(1);
  expect(oldDeps.insert).toHaveBeenCalledWith('same-tab', 'final');
  expect(nextSocket.closed).toBe(false);
  expect(stream.getActiveVoiceStream('new')?.ownerId).toBe('new');
  stream.cancelActiveVoiceStream('new');
});
