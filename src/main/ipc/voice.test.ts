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
