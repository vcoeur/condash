import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const edges = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: any[]) => Promise<any>>,
  settings: vi.fn(),
  config: vi.fn(),
  sockets: [] as any[],
  writes: vi.fn(),
  pushes: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: any) => {
      edges.handlers[channel] = handler;
    },
  },
}));
vi.mock('../settings', () => ({ readSettings: (...args: any[]) => edges.settings(...args) }));
vi.mock('../effective-config', () => ({
  getEffectiveConceptionConfig: (...args: any[]) => edges.config(...args),
}));
vi.mock('../terminals', () => ({
  listTerminalSessions: () => [{ id: 's1' }],
  writeTerminal: (...args: any[]) => edges.writes(...args),
  tabRecentText: () => '',
}));
vi.mock('../voice/keys', () => ({ resolveVoiceKeys: () => ({ mistral: 'DUMMY' }) }));
vi.mock('../voice/adapter', () => ({
  transcribeClip: vi.fn(),
  transcribeClipBiasFirst: vi.fn(),
  speakText: vi.fn(),
}));
vi.mock('../safe-send', () => ({ safeSend: (...args: any[]) => edges.pushes(...args) }));
vi.mock('./utils', async (original) => ({
  ...(await original<typeof import('./utils')>()),
  withConception: (callback: (path: string) => unknown) => callback('/fixture'),
}));
vi.mock('ws', () => ({
  default: class extends EventEmitter {
    sent: any[] = [];
    closed = false;
    constructor() {
      super();
      edges.sockets.push(this);
    }
    send(data: any) {
      this.sent.push(data);
    }
    close() {
      this.closed = true;
    }
    terminate() {
      this.closed = true;
    }
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const trusted = {
  sender: { getType: () => 'window' },
  senderFrame: { url: 'file:///app/dist/index.html', parent: null },
};
const request = (ownerId: string) => ({ ownerId, sid: 's1', sampleRate: 16000 });
const enabled = { voice: { enabled: true } };
const flush = async () => {
  for (let index = 0; index < 8; index++) await Promise.resolve();
};
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  edges.sockets.length = 0;
  edges.handlers = {};
  edges.settings.mockResolvedValue(enabled);
  edges.config.mockResolvedValue({ repositories: [] });
  const { registerVoiceIpc } = await import('./voice');
  registerVoiceIpc();
});
async function open(ownerId: string) {
  const starting = edges.handlers.voiceStreamStart(trusted, request(ownerId));
  await flush();
  edges.sockets.at(-1).emit('open');
  expect(await starting).toEqual({ ok: true });
  return edges.sockets.at(-1);
}

describe('real IPC admission and asynchronous owner boundaries', () => {
  it.each(['settings', 'config'] as const)(
    '300 rejected %s starts followed by compensating cancel do not exhaust admission',
    async (edge) => {
      for (let index = 0; index < 300; index++) {
        edges[edge].mockRejectedValueOnce(new Error('fixture read rejected'));
        const ownerId = `rejected-${index}`;
        await expect(edges.handlers.voiceStreamStart(trusted, request(ownerId))).rejects.toThrow(
          'fixture read rejected',
        );
        await edges.handlers.voiceStreamCancel(trusted, ownerId);
      }
      const socket = await open('after-rejections');
      expect(socket.closed).toBe(false);
      await edges.handlers.voiceStreamCancel(trusted, 'after-rejections');
    },
  );
  it('refuses cancel-before-entry without even reading settings or constructing a socket', async () => {
    await edges.handlers.voiceStreamCancel(trusted, 'old');
    expect(await edges.handlers.voiceStreamStart(trusted, request('old'))).toMatchObject({
      ok: false,
    });
    expect(edges.settings).not.toHaveBeenCalled();
    expect(edges.sockets).toHaveLength(0);
    const socket = await open('new');
    expect(socket.closed).toBe(false);
    await edges.handlers.voiceStreamCancel(trusted, 'new');
  });
  it.each(['settings', 'config'] as const)(
    'reserves synchronously and cancels during delayed %s without resurrecting the socket',
    async (edge) => {
      const waiting = deferred<any>();
      edges[edge].mockReturnValueOnce(waiting.promise);
      const starting = edges.handlers.voiceStreamStart(trusted, request('old'));
      await flush();
      expect(await edges.handlers.voiceStreamStart(trusted, request('overlap'))).toMatchObject({
        reason: 'already-active',
      });
      await edges.handlers.voiceStreamCancel(trusted, 'old');
      const next = await open('new');
      waiting.resolve(edge === 'settings' ? enabled : { repositories: [] });
      expect(await starting).toMatchObject({ ok: false });
      expect(edges.sockets).toHaveLength(1);
      expect(next.closed).toBe(false);
      await edges.handlers.voiceStreamCancel(trusted, 'new');
    },
  );
  it.each(['voiceStreamAudio', 'voiceStreamStop'] as const)(
    'old %s resumed through a disabled settings gate cannot cancel a newer owner',
    async (channel) => {
      const old = await open('old');
      const waiting = deferred<any>();
      edges.settings.mockReturnValueOnce(waiting.promise);
      const pending =
        channel === 'voiceStreamAudio'
          ? edges.handlers[channel](trusted, { ownerId: 'old', pcmBase64: 'AAAA' })
          : edges.handlers[channel](trusted, 'old');
      await edges.handlers.voiceStreamCancel(trusted, 'old');
      const next = await open('new');
      waiting.resolve({ voice: { enabled: false } });
      await pending;
      expect(old.closed).toBe(true);
      expect(next.closed).toBe(false);
      expect(edges.writes).not.toHaveBeenCalled();
      await edges.handlers.voiceStreamAudio(trusted, { ownerId: 'new', pcmBase64: 'AAAA' });
      expect(next.sent.filter(Buffer.isBuffer)).toHaveLength(1);
      await edges.handlers.voiceStreamCancel(trusted, 'new');
    },
  );
  it('owner-scopes partial push, stale audio/stop/cancel and failed old cleanup across same-sid restart', async () => {
    const starting = edges.handlers.voiceStreamStart(trusted, request('old'));
    await flush();
    const old = edges.sockets[0];
    await edges.handlers.voiceStreamCancel(trusted, 'old');
    const next = await open('new');
    old.emit('open');
    old.emit('error', new Error('late'));
    old.emit('message', Buffer.from('{"type":"transcription.text.delta","text":"stale"}'), false);
    old.emit('close', 1005, Buffer.alloc(0));
    await starting;
    await edges.handlers.voiceStreamCancel(trusted, 'old');
    await edges.handlers.voiceStreamAudio(trusted, { ownerId: 'old', pcmBase64: 'AAAA' });
    expect(await edges.handlers.voiceStreamStop(trusted, 'old')).toMatchObject({
      reason: 'no-session',
    });
    expect(next.closed).toBe(false);
    expect(next.sent.filter(Buffer.isBuffer)).toHaveLength(0);
    next.emit(
      'message',
      Buffer.from('{"type":"transcription.text.delta","text":"new caption"}'),
      false,
    );
    expect(edges.pushes).toHaveBeenCalledWith(trusted.sender, 'voice-partial', {
      ownerId: 'new',
      sid: 's1',
      text: 'new caption',
    });
    expect(edges.pushes).toHaveBeenCalledTimes(1);
    await edges.handlers.voiceStreamCancel(trusted, 'new');
  });
  it.each(['voiceStreamStart', 'voiceStreamAudio', 'voiceStreamStop', 'voiceStreamCancel'])(
    'validates bounded opaque ownerId at %s entry',
    async (channel) => {
      for (const ownerId of ['', 'x'.repeat(129), 'invalid owner', undefined]) {
        const payload =
          channel === 'voiceStreamStart'
            ? request(ownerId as string)
            : channel === 'voiceStreamAudio'
              ? { ownerId, pcmBase64: 'AAAA' }
              : ownerId;
        await expect(edges.handlers[channel](trusted, payload)).rejects.toThrow(
          'expected an opaque ownerId',
        );
      }
      expect(edges.settings).not.toHaveBeenCalled();
      expect(edges.sockets).toHaveLength(0);
    },
  );
});
