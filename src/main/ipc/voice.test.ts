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
  speakText: (...args: unknown[]) => speakText(...(args as [])),
}));

// The realtime socket is the other network edge — same treatment.
const beginVoiceStream = vi.fn();
vi.mock('../voice/stream', () => ({
  beginVoiceStream: (...args: unknown[]) => beginVoiceStream(...(args as [])),
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
    transcribeClip.mockResolvedValue({
      text: 'hello',
      provider: 'openrouter',
      producer: 'openrouter-native',
    });
    await expect(handlers.voiceTranscribe(trustedEvent, 's1', CLIP)).resolves.toEqual({
      inserted: true,
      provider: 'openrouter',
      producer: 'openrouter-native',
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

describe('saved voice credential metadata', () => {
  it('sanitises path-bearing settings read failures at the handler boundary without fabricating missing keys', async () => {
    const sensitivePath = '/synthetic/sensitive-status-sentinel/settings.json';
    const readError = Object.assign(
      new Error(`EACCES: permission denied, stat '${sensitivePath}' key-sensitive-sentinel`),
      { code: 'EACCES', path: sensitivePath },
    );
    const stat = vi.spyOn(fs, 'stat').mockRejectedValue(readError);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
    try {
      const result = handlers.voiceCredentialStatus(trustedEvent);
      await expect(result).rejects.toEqual(
        new Error('Could not read saved voice credential status.'),
      );
      await expect(result).rejects.not.toHaveProperty('cause');
      await expect(result).rejects.not.toHaveProperty('path');
      expect(await result.catch(String)).not.toMatch(
        /sensitive-status-sentinel|key-sensitive-sentinel|EACCES/,
      );
      expect(stat).toHaveBeenCalledWith(settingsPathValue);
      await expect(handlers.voiceCredentialStatus({ sender: null })).rejects.toThrow(
        'not an app window',
      );
      expect(stat).toHaveBeenCalledTimes(1);
      expect(transcribeClip).not.toHaveBeenCalled();
      expect(speakText).not.toHaveBeenCalled();
      expect(beginVoiceStream).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      stat.mockRestore();
      fetch.mockRestore();
    }
  });

  it('reads last-saved settings, never draft arguments, and returns only presence/source without network', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Network forbidden'));
    try {
      await writeSettings({ voice: { openrouterApiKey: 'saved-secret' } });
      await fs.writeFile(
        process.env.CONDASH_AGENTS_ENV!,
        'OPENROUTER_API_KEY=env-secret\nMISTRAL_API_KEY=env-mistral\n',
      );
      const snapshot = await handlers.voiceCredentialStatus(trustedEvent, {
        mistralApiKey: 'unsaved-secret',
      });
      expect(snapshot).toEqual({
        openrouter: { present: true, source: 'agents-env' },
        mistral: { present: true, source: 'agents-env' },
      });
      await fs.writeFile(process.env.CONDASH_AGENTS_ENV!, '');
      expect(
        await handlers.voiceCredentialStatus(trustedEvent, { mistralApiKey: 'unsaved-secret' }),
      ).toEqual({
        openrouter: { present: true, source: 'settings' },
        mistral: { present: false, source: 'none' },
      });
      await writeSettings({ voice: { mistralApiKey: 'new-saved-secret' } });
      const { invalidateSettingsMemo } = await import('../settings');
      invalidateSettingsMemo();
      expect(await handlers.voiceCredentialStatus(trustedEvent)).toEqual({
        openrouter: { present: false, source: 'none' },
        mistral: { present: true, source: 'settings' },
      });
      expect(JSON.stringify(snapshot)).not.toMatch(/secret|env-mistral|\.env|prefix|hash|value/);
      expect(transcribeClip).not.toHaveBeenCalled();
      expect(speakText).not.toHaveBeenCalled();
      expect(beginVoiceStream).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('rejects an untrusted sender before reading status', async () => {
    await expect(handlers.voiceCredentialStatus({ sender: null })).rejects.toThrow(
      'not an app window',
    );
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

  it('voiceStreamStart accepts a final-only session when captions are off', async () => {
    await writeSettings({ voice: { enabled: true, streaming: false, openrouterApiKey: 'DUMMY' } });
    beginVoiceStream.mockResolvedValue({ ok: true });
    await expect(handlers.voiceStreamStart(trustedEvent, START_REQUEST)).resolves.toEqual({
      ok: true,
      captions: false,
    });
    expect(beginVoiceStream).toHaveBeenCalledTimes(1);
  });

  it('voiceStreamStart requires an OpenRouter key, not a Mistral key', async () => {
    await writeSettings({ voice: { enabled: true, streaming: true } });
    await expect(handlers.voiceStreamStart(trustedEvent, START_REQUEST)).resolves.toEqual({
      ok: false,
      reason: 'no-openrouter-key',
      error: 'OpenRouter API key required for dictation; Mistral keys are read-aloud only.',
    });
    expect(beginVoiceStream).not.toHaveBeenCalled();
  });

  it('voiceStreamStart opens the stream when enabled, streaming, and keyed', async () => {
    await writeSettings({ voice: { enabled: true, streaming: true } });
    await fs.writeFile(join(tmpdir(), 'noop'), '');
    beginVoiceStream.mockResolvedValue({ ok: true });
    // A Mistral key must resolve — seed the agents env file the handlers read.
    await fs.writeFile(process.env.CONDASH_AGENTS_ENV!, 'OPENROUTER_API_KEY=stream-test-key\n');
    await expect(handlers.voiceStreamStart(trustedEvent, START_REQUEST)).resolves.toEqual({
      ok: true,
      captions: true,
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
