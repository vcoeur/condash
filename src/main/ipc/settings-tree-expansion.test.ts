/**
 * Settings-IPC tests focused on the legacy per-harness migration path that
 * lives inside `getTreeExpansion`. Pre-reframe condash kept four sets
 * (`skillsGeneric`, `skillsClaude`, `skillsKimi`, `skillsOpencode`); the
 * reframe collapsed them into a single conception-scope `skills` set. The
 * handler under test fires an opportunistic write to drop the legacy keys;
 * we verify that the write survives a concurrent `setTreeExpansion`.
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

let tmp: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let handlers: Record<string, (...args: any[]) => Promise<unknown>>;
let settingsPathValue: string;

/** Minimal event shape accepted by `requireMainWindowSender`. */
const trustedEvent = {
  sender: { getType: () => 'window' },
  senderFrame: { url: 'file:///app/dist/index.html', parent: null },
};

async function writeSettings(content: object): Promise<void> {
  await fs.writeFile(settingsPathValue, JSON.stringify(content));
}

async function readSettingsFile(): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(settingsPathValue, 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

/** The opportunistic legacy-key rewrite is fire-and-forget — it's queued
 *  through `withSettingsQueue` and runs after the handler returns. Poll
 *  the on-disk file until the predicate is satisfied (or time out). */
async function waitForFile(
  predicate: (settings: Record<string, unknown>) => boolean,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const onDisk = await readSettingsFile();
    if (predicate(onDisk)) return onDisk;
    if (Date.now() > deadline) {
      throw new Error(`waitForFile timed out — last contents: ${JSON.stringify(onDisk, null, 2)}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeEach(async () => {
  vi.resetModules();
  tmp = mkdtempSync(join(tmpdir(), 'condash-settings-ipc-'));
  settingsPathValue = join(tmp, 'settings.json');
  const isolatedTmp = tmp;
  vi.doMock('../user-data-dir', () => ({ userDataDir: () => isolatedTmp }));

  handlers = {};
  const { ipcMain } = await import('electron');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ipcMain.handle as any).mockImplementation(
    (channel: string, fn: (...args: any[]) => Promise<unknown>) => {
      handlers[channel] = fn;
    },
  );
  const { registerSettingsIpc } = await import('./settings');
  registerSettingsIpc({ onLayoutChange: () => undefined });
});

afterEach(async () => {
  try {
    const { drainSettingsQueue } = await import('../settings');
    await drainSettingsQueue();
  } catch {
    /* Module not loaded yet (very-first test) — that's fine. */
  }
  rmSync(tmp, { recursive: true, force: true });
  vi.doUnmock('../user-data-dir');
});

describe('getTreeExpansion legacy-harness migration', () => {
  it('collapses legacy `skillsClaude` / `skillsGeneric` / `skillsKimi` / `skillsOpencode` into `skills`', async () => {
    await writeSettings({
      lastConceptionPath: null,
      recentConceptionPaths: [],
      theme: 'system',
      terminal: {},
      treeExpansion: {
        skillsClaude: ['pr', 'projects'],
        skillsGeneric: ['knowledge'],
        skillsKimi: ['tidy'],
        skillsOpencode: ['extra'],
      },
    });
    const result = (await handlers.getTreeExpansion(trustedEvent)) as Record<string, string[]>;
    expect(result.skills.sort()).toEqual(['extra', 'knowledge', 'pr', 'projects', 'tidy']);
    expect(result.skillsUser).toEqual([]);
  });

  it('explicit `skills` wins over the legacy per-harness arrays', async () => {
    await writeSettings({
      lastConceptionPath: null,
      recentConceptionPaths: [],
      theme: 'system',
      terminal: {},
      treeExpansion: {
        skillsClaude: ['legacy-only'],
        skills: ['explicit'],
      },
    });
    const result = (await handlers.getTreeExpansion(trustedEvent)) as Record<string, string[]>;
    expect(result.skills).toEqual(['explicit']);
  });

  it('opportunistically rewrites settings.json to drop the legacy per-harness keys', async () => {
    await writeSettings({
      lastConceptionPath: null,
      recentConceptionPaths: [],
      theme: 'system',
      terminal: {},
      treeExpansion: { skillsClaude: ['pr'] },
    });
    await handlers.getTreeExpansion(trustedEvent);
    const onDisk = await waitForFile((s) => {
      const te = s.treeExpansion as Record<string, unknown> | undefined;
      return te !== undefined && te.skillsClaude === undefined && Array.isArray(te.skills);
    });
    const te = onDisk.treeExpansion as Record<string, unknown>;
    expect(te.skillsClaude).toBeUndefined();
    expect(te.skillsGeneric).toBeUndefined();
    expect(te.skillsKimi).toBeUndefined();
    expect(te.skillsOpencode).toBeUndefined();
    expect(te.skills).toEqual(['pr']);
  });

  it('does not clobber a concurrent setTreeExpansion update', async () => {
    await writeSettings({
      lastConceptionPath: null,
      recentConceptionPaths: [],
      theme: 'system',
      terminal: {},
      treeExpansion: { skillsClaude: ['old-claude'] },
    });
    await Promise.all([
      handlers.getTreeExpansion(trustedEvent),
      handlers.setTreeExpansion(trustedEvent, {
        skills: ['fresh-explicit'],
        skillsUser: ['user-set'],
      }),
    ]);
    const onDisk = await waitForFile((s) => {
      const te = s.treeExpansion as Record<string, unknown> | undefined;
      return te !== undefined && te.skillsClaude === undefined && Array.isArray(te.skills);
    });
    const te = onDisk.treeExpansion as Record<string, unknown>;
    expect(te.skillsClaude).toBeUndefined();
    expect(te.skills).toEqual(['fresh-explicit']);
    expect(te.skillsUser).toEqual(['user-set']);
  });

  it('is a no-op when no legacy per-harness key exists', async () => {
    await writeSettings({
      lastConceptionPath: null,
      recentConceptionPaths: [],
      theme: 'system',
      terminal: {},
      treeExpansion: { skills: ['pr'] },
    });
    const mtimeBefore = (await fs.stat(settingsPathValue)).mtimeMs;
    await handlers.getTreeExpansion(trustedEvent);
    await new Promise((r) => setImmediate(r));
    const mtimeAfter = (await fs.stat(settingsPathValue)).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });
});
