/**
 * Default-off gating for the voice IPC handlers.
 *
 * `voice.enabled` is the feature's master switch and defaults to off: with it
 * unset or false the handlers must answer with a typed disabled result — no
 * provider call, no key resolution — while an explicit `enabled: true` runs
 * the normal path. The renderer hides the pane controls too, but the gate
 * here is the part that actually touches the network, so it is pinned
 * independently.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => '/tmp/electron-app' },
}));

// The adapter is the network edge — mock it wholesale so a regression that
// calls through when disabled fails on the spy, never on a real request.
const transcribeClip = vi.fn();
const speakText = vi.fn();
vi.mock('../voice/adapter', () => ({
  transcribeClip: (...args: unknown[]) => transcribeClip(...(args as [])),
  transcribeClipBiasFirst: (...args: unknown[]) => transcribeClip(...(args as [])),
  speakText: (...args: unknown[]) => speakText(...(args as [])),
}));

// The realtime socket is the other network edge — same treatment.
const beginVoiceStream = vi.fn();
vi.mock('../voice/stream', () => ({
  beginVoiceStream: (...args: unknown[]) => beginVoiceStream(...(args as [])),
  createRealtimeSocket: vi.fn(),
  getActiveVoiceStream: () => null,
  takeActiveVoiceStream: () => null,
  cancelActiveVoiceStream: vi.fn(),
  reserveVoiceStream: (ownerId: string) => ({ ok: true, reservation: { ownerId } }),
  ownsVoiceStream: () => true,
  releaseVoiceStream: vi.fn(),
}));

// `../terminals` drags in node-pty; the handlers only need these three edges.
vi.mock('../terminals', () => ({
  listTerminalSessions: () => [{ id: 's1', exited: undefined }],
  tabRecentText: () => 'hello world',
  writeTerminal: vi.fn(),
}));

let tmp: string;
let settingsPathValue: string;
let handlers: Record<string, (...args: any[]) => Promise<unknown>>;
let previousAgentsEnv: string | undefined;

const trustedEvent = {
  sender: { getType: () => 'window' },
  senderFrame: { url: 'file:///app/dist/index.html', parent: null },
};

const CLIP = { data: 'a2xpcA==', sampleRate: 16000, format: 'wav' as const };

/** The voiceStreamStart payload: target tab + the captured sample rate. */
const START_REQUEST = { sid: 's1', sampleRate: 16000, ownerId: 'test-owner' };

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  tmp = mkdtempSync(join(tmpdir(), 'condash-voice-ipc-'));
  settingsPathValue = join(tmp, 'settings.json');
  // Point key resolution at the fixture dir — never the developer's real
  // `~/.config/agents/.env` (the reader is read-only, but a unit test must
  // not depend on or observe machine state).
  previousAgentsEnv = process.env.CONDASH_AGENTS_ENV;
  process.env.CONDASH_AGENTS_ENV = join(tmp, 'agents.env');
  const isolatedTmp = tmp;
  vi.doMock('../user-data-dir', () => ({ userDataDir: () => isolatedTmp }));

  handlers = {};
  const { ipcMain } = await import('electron');
  (ipcMain.handle as any).mockImplementation(
    (channel: string, fn: (...args: any[]) => Promise<unknown>) => {
      handlers[channel] = fn;
    },
  );
  const { registerVoiceIpc } = await import('./voice');
  registerVoiceIpc();
});

afterEach(async () => {
  try {
    const { drainSettingsQueue } = await import('../settings');
    await drainSettingsQueue();
  } catch {
    /* Module not loaded yet — fine. */
  }
  if (previousAgentsEnv === undefined) delete process.env.CONDASH_AGENTS_ENV;
  else process.env.CONDASH_AGENTS_ENV = previousAgentsEnv;
  rmSync(tmp, { recursive: true, force: true });
  vi.doUnmock('../user-data-dir');
});

async function writeSettings(content: object): Promise<void> {
  await fs.writeFile(settingsPathValue, JSON.stringify(content));
}

describe('voice IPC default-off gating', () => {
  it('voiceTranscribe answers disabled when the voice key is absent (the default)', async () => {
    await writeSettings({ lastConceptionPath: null, recentConceptionPaths: [] });
    await expect(handlers.voiceTranscribe(trustedEvent, 's1', CLIP)).resolves.toEqual({
      inserted: false,
      reason: 'disabled',
    });
    expect(transcribeClip).not.toHaveBeenCalled();
  });

  it('voiceTranscribe answers disabled when enabled is explicitly false', async () => {
    await writeSettings({ voice: { enabled: false } });
    await expect(handlers.voiceTranscribe(trustedEvent, 's1', CLIP)).resolves.toEqual({
      inserted: false,
      reason: 'disabled',
    });
    expect(transcribeClip).not.toHaveBeenCalled();
  });

  it('voiceTranscribe still validates its payload before the gate', async () => {
    // The uniform decoder error, not the disabled result — the trust boundary
    // keeps its shape whether or not the feature is on.
    await writeSettings({});
    await expect(handlers.voiceTranscribe(trustedEvent, 's1', { data: '' })).rejects.toThrow(
      'voiceTranscribe: expected a non-empty base64 clip',
    );
  });

  it('voiceTranscribe runs the normal path when enabled is true', async () => {
    await writeSettings({ voice: { enabled: true } });
    transcribeClip.mockResolvedValue({ text: 'hello', provider: 'openrouter' });
    await expect(handlers.voiceTranscribe(trustedEvent, 's1', CLIP)).resolves.toEqual({
      inserted: true,
      provider: 'openrouter',
      chars: 5,
    });
    expect(transcribeClip).toHaveBeenCalledTimes(1);
  });

  it('voiceSpeak answers disabled when the voice key is absent (the default)', async () => {
    await writeSettings({});
    await expect(handlers.voiceSpeak(trustedEvent, 's1')).resolves.toEqual({
      ok: false,
      reason: 'disabled',
      error: 'Voice is disabled — enable it in Settings → Voice.',
    });
    expect(speakText).not.toHaveBeenCalled();
  });

  it('voiceSpeak answers disabled when enabled is explicitly false', async () => {
    await writeSettings({ voice: { enabled: false } });
    await expect(handlers.voiceSpeak(trustedEvent, 's1')).resolves.toMatchObject({
      ok: false,
      reason: 'disabled',
    });
    expect(speakText).not.toHaveBeenCalled();
  });

  it('voiceSpeak runs the normal path when enabled is true', async () => {
    await writeSettings({ voice: { enabled: true } });
    speakText.mockResolvedValue({ audio: Buffer.from('mp3'), provider: 'openrouter' });
    const result = (await handlers.voiceSpeak(trustedEvent, 's1')) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(speakText).toHaveBeenCalledTimes(1);
  });
});

describe('voice realtime stream gating', () => {
  it('voiceStreamStart answers disabled when the voice key is absent (the default)', async () => {
    await writeSettings({});
    await expect(handlers.voiceStreamStart(trustedEvent, START_REQUEST)).resolves.toEqual({
      ok: false,
      reason: 'disabled',
    });
    expect(beginVoiceStream).not.toHaveBeenCalled();
  });

  it('voiceStreamStart answers disabled when enabled but streaming is off', async () => {
    await writeSettings({ voice: { enabled: true, streaming: false } });
    await expect(handlers.voiceStreamStart(trustedEvent, START_REQUEST)).resolves.toEqual({
      ok: false,
      reason: 'disabled',
    });
    expect(beginVoiceStream).not.toHaveBeenCalled();
  });

  it('voiceStreamStart answers no-mistral-key when the realtime provider is unkeyed', async () => {
    await writeSettings({ voice: { enabled: true, streaming: true } });
    await expect(handlers.voiceStreamStart(trustedEvent, START_REQUEST)).resolves.toEqual({
      ok: false,
      reason: 'no-mistral-key',
    });
    expect(beginVoiceStream).not.toHaveBeenCalled();
  });

  it('voiceStreamStart opens the stream when enabled, streaming, and keyed', async () => {
    await writeSettings({ voice: { enabled: true, streaming: true } });
    await fs.writeFile(join(tmpdir(), 'noop'), '');
    beginVoiceStream.mockResolvedValue({ ok: true });
    // A Mistral key must resolve — seed the agents env file the handlers read.
    await fs.writeFile(process.env.CONDASH_AGENTS_ENV!, 'MISTRAL_API_KEY=stream-test-key\n');
    await expect(handlers.voiceStreamStart(trustedEvent, START_REQUEST)).resolves.toEqual({
      ok: true,
    });
    expect(beginVoiceStream).toHaveBeenCalledTimes(1);
    // The captured sample rate rides the session deps for the repass header.
    expect(beginVoiceStream.mock.calls[0][0]).toMatchObject({
      sid: 's1',
      sampleRate: 16000,
    });
  });

  it('voiceStreamStart validates its payload before the gate', async () => {
    await writeSettings({});
    await expect(handlers.voiceStreamStart(trustedEvent, { sampleRate: 16000 })).rejects.toThrow(
      'voiceStreamStart: expected a non-empty string',
    );
    await expect(handlers.voiceStreamStart(trustedEvent, { sid: 's1' })).rejects.toThrow(
      'voiceStreamStart: expected a positive sampleRate',
    );
    await expect(
      handlers.voiceStreamStart(trustedEvent, { sid: 's1', sampleRate: 0 }),
    ).rejects.toThrow('voiceStreamStart: expected a positive sampleRate');
  });

  it('voiceStreamAudio validates its payload before the gate', async () => {
    await writeSettings({});
    await expect(handlers.voiceStreamAudio(trustedEvent, { pcmBase64: '' })).rejects.toThrow(
      'voiceStreamAudio: expected a non-empty pcmBase64 string',
    );
  });

  it('voiceStreamAudio is a no-op when no stream is live', async () => {
    await writeSettings({ voice: { enabled: true } });
    await expect(
      handlers.voiceStreamAudio(trustedEvent, { ownerId: 'test-owner', pcmBase64: 'AAAA' }),
    ).resolves.toBeUndefined();
  });

  it('voiceStreamStop answers no-session when no stream is live', async () => {
    await writeSettings({ voice: { enabled: true } });
    await expect(handlers.voiceStreamStop(trustedEvent, 'test-owner')).resolves.toEqual({
      inserted: false,
      reason: 'no-session',
    });
  });

  it('voiceStreamStop answers disabled (and kills the stream) when the gate is off', async () => {
    await writeSettings({});
    await expect(handlers.voiceStreamStop(trustedEvent, 'test-owner')).resolves.toEqual({
      inserted: false,
      reason: 'disabled',
    });
  });

  it('voiceStreamCancel resolves without a session', async () => {
    await writeSettings({});
    await expect(handlers.voiceStreamCancel(trustedEvent, 'test-owner')).resolves.toBeUndefined();
  });
});
