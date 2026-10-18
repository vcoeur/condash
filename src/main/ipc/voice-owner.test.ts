import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const edges = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: any[]) => Promise<any>>,
  settings: vi.fn(),
  config: vi.fn(),
  writes: vi.fn(),
  pushes: vi.fn(),
  fetch: vi.fn(),
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
vi.mock('../voice/keys', () => ({
  resolveVoiceKeys: () => ({ openrouter: 'DUMMY' }),
}));
vi.mock('../safe-send', () => ({ safeSend: (...args: any[]) => edges.pushes(...args) }));
vi.mock('./utils', async (original) => ({
  ...(await original<typeof import('./utils')>()),
  withConception: (callback: (path: string) => unknown) => callback('/fixture'),
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
const enabled = {
  voice: { enabled: true, sttModel: 'selected/native-id', contextBias: ['StartWord'] },
};
const flush = async () => {
  for (let index = 0; index < 12; index++) await Promise.resolve();
};
const pcm = Buffer.alloc(64000).toString('base64');
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  edges.handlers = {};
  edges.settings.mockResolvedValue(enabled);
  edges.config.mockResolvedValue({ repositories: [] });
  edges.fetch.mockResolvedValue(new Response(JSON.stringify({ text: 'new caption' })));
  vi.stubGlobal('fetch', edges.fetch);
  (await import('./voice')).registerVoiceIpc();
});
afterEach(() => vi.unstubAllGlobals());
async function open(ownerId: string) {
  expect(await edges.handlers.voiceStreamStart(trusted, request(ownerId))).toEqual({
    ok: true,
    captions: true,
  });
  return (await import('../voice/stream')).getActiveVoiceStream(ownerId)!;
}
describe('real IPC admission and asynchronous owner boundaries', () => {
  it.each(['length', 'refusal', 'error', 'malformed'])(
    'audio-context final %s inserts nothing and never falls back',
    async (failure) => {
      edges.settings.mockResolvedValue({
        voice: { enabled: true, dictationMethod: 'audio-context' },
      });
      edges.fetch.mockImplementation(
        async () =>
          new Response(
            JSON.stringify(
              failure === 'error'
                ? { error: 'failed' }
                : {
                    choices: [
                      {
                        finish_reason: failure === 'length' ? 'length' : 'stop',
                        message: {
                          content: failure === 'malformed' ? [] : 'prefix',
                          ...(failure === 'refusal' ? { refusal: 'no' } : {}),
                        },
                      },
                    ],
                  },
            ),
          ),
      );
      await open('failed-context');
      await edges.handlers.voiceStreamAudio(trusted, {
        ownerId: 'failed-context',
        pcmBase64: 'AAA=',
      });
      expect(await edges.handlers.voiceStreamStop(trusted, 'failed-context')).toMatchObject({
        inserted: false,
        reason: 'error',
      });
      expect(edges.writes).not.toHaveBeenCalled();
      expect(edges.fetch).toHaveBeenCalledTimes(1);
      expect(edges.fetch.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/chat/completions');
    },
  );
  it.each([false, true])(
    'audio-context snapshot survives changed method/model, pending start=%s',
    async (pending) => {
      edges.settings.mockResolvedValue({
        voice: {
          enabled: true,
          dictationMethod: 'audio-context',
          audioContextModel: 'selected/context',
          sttModel: 'legacy/native',
          contextBias: [' StartWord ', 'startword'],
        },
      });
      const registry = {
        repositories: [{ handle: 'canonical', name: 'Display Name', aliases: ['Alias'] }],
      };
      edges.config.mockResolvedValue(registry);
      edges.fetch.mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ finish_reason: 'stop', message: { content: 'context transcript' } }],
            }),
          ),
      );
      const waiting = deferred<any>();
      if (pending) edges.config.mockReturnValueOnce(waiting.promise);
      const starting = edges.handlers.voiceStreamStart(trusted, request('context-owner'));
      await flush();
      if (pending) await edges.handlers.voiceStreamCancel(trusted, 'context-owner');
      else {
        await starting;
        await edges.handlers.voiceStreamAudio(trusted, {
          ownerId: 'context-owner',
          pcmBase64: pcm,
        });
        await vi.waitFor(() => expect(edges.pushes).toHaveBeenCalled());
      }
      edges.settings.mockResolvedValue({
        voice: {
          enabled: true,
          dictationMethod: 'native-stt',
          sttModel: 'new/native',
          audioContextModel: 'new/context',
          contextBias: ['Changed'],
        },
      });
      let result;
      if (pending) {
        const stopping = edges.handlers.voiceTranscribe(
          trusted,
          's1',
          { data: 'UklGRg==', sampleRate: 16000, format: 'wav' },
          'context-owner',
        );
        waiting.resolve(registry);
        await starting;
        result = await stopping;
      } else result = await edges.handlers.voiceStreamStop(trusted, 'context-owner');
      expect(result).toMatchObject({ inserted: true, producer: 'openrouter-audio-context' });
      expect(edges.fetch).toHaveBeenCalledTimes(pending ? 1 : 2);
      for (const [url, init] of edges.fetch.mock.calls) {
        expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
        const body = JSON.parse(init.body);
        expect(body.model).toBe('selected/context');
        expect(body.messages[0].content[1].text).toBe(
          'Canonical names (data): ["StartWord","canonical"]',
        );
      }
      expect(edges.writes).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['settings', 'config'] as const)(
    '300 rejected %s starts plus compensating cancels never exhaust admission',
    async (edge) => {
      for (let index = 0; index < 300; index++) {
        edges[edge].mockRejectedValueOnce(new Error('fixture read rejected'));
        const ownerId = `rejected-${index}`;
        await expect(edges.handlers.voiceStreamStart(trusted, request(ownerId))).rejects.toThrow(
          'fixture read rejected',
        );
        await edges.handlers.voiceStreamCancel(trusted, ownerId);
      }
      expect((await open('after-rejections')).ownerId).toBe('after-rejections');
      await edges.handlers.voiceStreamCancel(trusted, 'after-rejections');
    },
  );
  it('refuses cancel-before-entry before settings or provider work', async () => {
    await edges.handlers.voiceStreamCancel(trusted, 'old');
    expect(await edges.handlers.voiceStreamStart(trusted, request('old'))).toMatchObject({
      ok: false,
    });
    expect(edges.settings).not.toHaveBeenCalled();
    expect(edges.fetch).not.toHaveBeenCalled();
    await open('new');
    await edges.handlers.voiceStreamCancel(trusted, 'new');
  });
  it.each(['settings', 'config'] as const)(
    'reserves synchronously and fences cancelled delayed %s',
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
      expect((await import('../voice/stream')).getActiveVoiceStream('new')).toBe(next);
      expect(edges.fetch).not.toHaveBeenCalled();
      await edges.handlers.voiceStreamCancel(trusted, 'new');
    },
  );
  it.each(['voiceStreamAudio', 'voiceStreamStop'] as const)(
    'old %s resumed at disabled settings gate cannot cancel a newer owner',
    async (channel) => {
      await open('old');
      const waiting = deferred<any>();
      edges.settings.mockReturnValueOnce(waiting.promise);
      const pending =
        channel === 'voiceStreamAudio'
          ? edges.handlers[channel](trusted, { ownerId: 'old', pcmBase64: pcm })
          : edges.handlers[channel](trusted, 'old');
      await edges.handlers.voiceStreamCancel(trusted, 'old');
      const next = await open('new');
      waiting.resolve({ voice: { enabled: false } });
      await pending;
      expect((await import('../voice/stream')).getActiveVoiceStream('new')).toBe(next);
      expect(edges.writes).not.toHaveBeenCalled();
      await edges.handlers.voiceStreamAudio(trusted, { ownerId: 'new', pcmBase64: pcm });
      await flush();
      expect(edges.fetch).toHaveBeenCalledTimes(1);
      await edges.handlers.voiceStreamCancel(trusted, 'new');
    },
  );
  it('owner-scopes stale fetches, audio, Stop and cancellation across a same-sid restart', async () => {
    await open('old');
    const waiting = deferred<Response>();
    edges.fetch.mockReturnValueOnce(waiting.promise);
    await edges.handlers.voiceStreamAudio(trusted, { ownerId: 'old', pcmBase64: pcm });
    const signal = edges.fetch.mock.calls[0][1].signal;
    await edges.handlers.voiceStreamCancel(trusted, 'old');
    await open('new');
    expect(signal.aborted).toBe(true);
    waiting.resolve(new Response(JSON.stringify({ text: 'stale' })));
    await flush();
    await edges.handlers.voiceStreamAudio(trusted, { ownerId: 'old', pcmBase64: pcm });
    expect(await edges.handlers.voiceStreamStop(trusted, 'old')).toMatchObject({
      reason: 'no-session',
    });
    await edges.handlers.voiceStreamCancel(trusted, 'old');
    expect(edges.pushes).not.toHaveBeenCalled();
    await edges.handlers.voiceStreamAudio(trusted, { ownerId: 'new', pcmBase64: pcm });
    await flush();
    expect(edges.pushes).toHaveBeenCalledTimes(1);
    expect(edges.pushes).toHaveBeenCalledWith(trusted.sender, 'voice-partial', {
      ownerId: 'new',
      sid: 's1',
      text: 'new caption',
    });
    await edges.handlers.voiceStreamCancel(trusted, 'new');
  });
  it('snapshots model and vocabulary at start for preview and final despite saved settings changes', async () => {
    await open('snapshot');
    await edges.handlers.voiceStreamAudio(trusted, { ownerId: 'snapshot', pcmBase64: pcm });
    await flush();
    edges.settings.mockResolvedValue({
      voice: { enabled: true, sttModel: 'different/model', contextBias: ['NewWord'] },
    });
    edges.fetch.mockResolvedValue(new Response(JSON.stringify({ text: 'final' })));
    expect(await edges.handlers.voiceStreamStop(trusted, 'snapshot')).toMatchObject({
      inserted: true,
      producer: 'openrouter-native',
    });
    for (const [url, init] of edges.fetch.mock.calls) {
      expect(url).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
      const body = JSON.parse(init.body);
      expect(body.model).toBe('selected/native-id');
      expect(body.provider.options.mistral.context_bias).toEqual(['StartWord']);
    }
    expect(edges.writes).toHaveBeenCalledTimes(1);
  });

  it('pending-start Stop uses a one-use original snapshot for the buffered clip, not newer settings', async () => {
    const waiting = deferred<any>();
    edges.config.mockReturnValueOnce(waiting.promise);
    const starting = edges.handlers.voiceStreamStart(trusted, request('pending-snapshot'));
    await flush();
    await edges.handlers.voiceStreamCancel(trusted, 'pending-snapshot');
    edges.settings.mockResolvedValue({
      voice: { enabled: true, sttModel: 'changed/model', contextBias: ['Changed'] },
    });
    const clip = { data: 'UklGRg==', sampleRate: 16000, format: 'wav' };
    const stopping = edges.handlers.voiceTranscribe(trusted, 's1', clip, 'pending-snapshot');
    waiting.resolve({ repositories: [] });
    expect(await starting).toMatchObject({ ok: false });
    expect(await stopping).toMatchObject({ inserted: true });
    expect(edges.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(edges.fetch.mock.calls[0][1].body);
    expect(body.model).toBe('selected/native-id');
    expect(body.provider.options.mistral.context_bias).toEqual(['StartWord']);
    expect(
      await edges.handlers.voiceTranscribe(trusted, 's1', clip, 'pending-snapshot'),
    ).toMatchObject({ reason: 'error' });
    expect(edges.fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['voiceStreamStart', 'voiceStreamAudio', 'voiceStreamStop', 'voiceStreamCancel'])(
    'validates bounded opaque ownerId at %s entry',
    async (channel) => {
      for (const ownerId of ['', 'x'.repeat(129), 'invalid owner', undefined]) {
        const payload =
          channel === 'voiceStreamStart'
            ? request(ownerId as string)
            : channel === 'voiceStreamAudio'
              ? { ownerId, pcmBase64: pcm }
              : ownerId;
        await expect(edges.handlers[channel](trusted, payload)).rejects.toThrow(
          'expected an opaque ownerId',
        );
      }
      expect(edges.settings).not.toHaveBeenCalled();
      expect(edges.fetch).not.toHaveBeenCalled();
    },
  );
});
