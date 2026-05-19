/**
 * Settings-IPC tests focused on the legacy `treeExpansion.skills` migration
 * path that lives inside `getTreeExpansion`. The handler under test fires
 * an opportunistic write to drop the legacy key; we verify that the write
 * survives a concurrent `setTreeExpansion` (the race surfaced in PR #173
 * re-review).
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
  // Capture this test's tmp path as a *local const* inside the factory
  // closure. Without this, the factory references the module-scope
  // `let tmp` by name — and a fire-and-forget `withSettingsQueue` write
  // queued during the previous test resolves `settingsPath()` (which
  // calls `userDataDir() => tmp`) *after* `tmp` has been reassigned in
  // this test's beforeEach, leaking the previous test's write into this
  // test's settings.json. Surfaced 2026-05-19 in the v3.18.0 release CI
  // (test 3 saw `['explicit']` from test 2's `skillsClaude` write).
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
  // Drain the settings queue before removing the tmp dir so any pending
  // opportunistic writes can complete (or fail safely) before their
  // target disappears. The module-scope `settingsQueue` lives in the
  // *previous* import of `../settings`; reading it back via the still-
  // cached import keeps that exact instance.
  try {
    const { drainSettingsQueue } = await import('../settings');
    await drainSettingsQueue();
  } catch {
    // The module may not be loaded yet (very-first test) — that's fine.
  }
  rmSync(tmp, { recursive: true, force: true });
  vi.doUnmock('../user-data-dir');
});

describe('getTreeExpansion legacy-skills migration', () => {
  it('migrates `skills` → `skillsClaude` in the returned shape', async () => {
    await writeSettings({
      lastConceptionPath: null,
      recentConceptionPaths: [],
      theme: 'system',
      terminal: {},
      treeExpansion: { skills: ['pr', 'projects'] },
    });
    const result = (await handlers.getTreeExpansion()) as Record<string, string[]>;
    expect(result.skillsClaude.sort()).toEqual(['pr', 'projects']);
    expect(result.skillsGeneric).toEqual([]);
    expect(result.skillsKimi).toEqual([]);
  });

  it('explicit `skillsClaude` wins over the legacy `skills` array', async () => {
    await writeSettings({
      lastConceptionPath: null,
      recentConceptionPaths: [],
      theme: 'system',
      terminal: {},
      treeExpansion: {
        skills: ['legacy-only'],
        skillsClaude: ['explicit'],
      },
    });
    const result = (await handlers.getTreeExpansion()) as Record<string, string[]>;
    expect(result.skillsClaude).toEqual(['explicit']);
  });

  it('opportunistically rewrites settings.json to drop the legacy `skills` key', async () => {
    await writeSettings({
      lastConceptionPath: null,
      recentConceptionPaths: [],
      theme: 'system',
      terminal: {},
      treeExpansion: { skills: ['pr'] },
    });
    await handlers.getTreeExpansion();
    const onDisk = await waitForFile((s) => {
      const te = s.treeExpansion as Record<string, unknown> | undefined;
      return te !== undefined && te.skills === undefined && Array.isArray(te.skillsClaude);
    });
    const te = onDisk.treeExpansion as Record<string, unknown>;
    expect(te.skills).toBeUndefined();
    expect(te.skillsClaude).toEqual(['pr']);
  });

  it('does not clobber a concurrent setTreeExpansion update', async () => {
    // Start: legacy-only on disk.
    await writeSettings({
      lastConceptionPath: null,
      recentConceptionPaths: [],
      theme: 'system',
      terminal: {},
      treeExpansion: { skills: ['old-claude'] },
    });
    // Fire getTreeExpansion (queues an opportunistic rewrite) AND
    // setTreeExpansion in the same microtask. `updateSettings` runs both
    // under `withSettingsQueue`; we assert the resulting on-disk state
    // reflects the explicit setTreeExpansion call, not the stale-snapshot
    // migration.
    await Promise.all([
      handlers.getTreeExpansion(),
      // IPC handlers' first arg is the (unused) event; payload is second.
      handlers.setTreeExpansion(null, {
        skillsClaude: ['fresh-explicit'],
        skillsGeneric: ['gen'],
      }),
    ]);
    // The settings queue serializes both writes; wait for the post-state.
    const onDisk = await waitForFile((s) => {
      const te = s.treeExpansion as Record<string, unknown> | undefined;
      return te !== undefined && te.skills === undefined && Array.isArray(te.skillsClaude);
    });
    const te = onDisk.treeExpansion as Record<string, unknown>;
    expect(te.skills).toBeUndefined();
    expect(te.skillsClaude).toEqual(['fresh-explicit']);
    expect(te.skillsGeneric).toEqual(['gen']);
  });

  it('is a no-op when no legacy `skills` key exists', async () => {
    await writeSettings({
      lastConceptionPath: null,
      recentConceptionPaths: [],
      theme: 'system',
      terminal: {},
      treeExpansion: { skillsClaude: ['pr'] },
    });
    const mtimeBefore = (await fs.stat(settingsPathValue)).mtimeMs;
    await handlers.getTreeExpansion();
    await new Promise((r) => setImmediate(r));
    const mtimeAfter = (await fs.stat(settingsPathValue)).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });
});
