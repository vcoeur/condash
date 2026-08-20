/**
 * Projects-IPC tests for the card star flag (`starredProjects`).
 *
 * Three things are worth pinning at this layer. First, the scope:
 * `starredProjects` is conception-owned, so the write must land in
 * `<conception>/.condash/settings.json` and never in the per-machine global
 * `settings.json` — a key in the wrong file is rejected by that file's strict
 * schema on the next save (the same trap `setTaskConfig` fell into). Second, the
 * empty case: unstarring the last project must remove the key rather than leave
 * `"starredProjects": []` behind in an otherwise-untouched config. Third,
 * `pruneStarredProjects`, which enforces "a done item carries no star": it has
 * to *persist* the shrunk list — a caller-side filter would let the stale slugs
 * sit in the config for ever and resurrect the star on reopen — and it must
 * touch only the slugs it was handed, so a caller holding a partial project
 * list can under-prune but never over-prune.
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
let handlers: Record<string, (...args: any[]) => Promise<unknown>>;
let settingsPathValue: string;
let conceptionConfigPathValue: string;

/** Minimal event shape accepted by `requireMainWindowSender`. */
const trustedEvent = {
  sender: { getType: () => 'window' },
  senderFrame: { url: 'file:///app/dist/index.html', parent: null },
};

async function readConceptionConfig(): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(conceptionConfigPathValue, 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

async function getStarred(): Promise<string[]> {
  return (await handlers.getStarredProjects(trustedEvent)) as string[];
}

async function setStar(slug: unknown, starred: unknown): Promise<string[]> {
  return (await handlers.setProjectStar(trustedEvent, slug, starred)) as string[];
}

async function prune(doneSlugs: unknown): Promise<string[]> {
  return (await handlers.pruneStarredProjects(trustedEvent, doneSlugs)) as string[];
}

beforeEach(async () => {
  vi.resetModules();
  tmp = mkdtempSync(join(tmpdir(), 'condash-project-star-'));
  settingsPathValue = join(tmp, 'settings.json');
  conceptionConfigPathValue = join(tmp, '.condash', 'settings.json');
  const isolatedTmp = tmp;
  vi.doMock('../user-data-dir', () => ({ userDataDir: () => isolatedTmp }));

  handlers = {};
  const { ipcMain } = await import('electron');
  (ipcMain.handle as any).mockImplementation(
    (channel: string, fn: (...args: any[]) => Promise<unknown>) => {
      handlers[channel] = fn;
    },
  );
  await fs.writeFile(
    settingsPathValue,
    JSON.stringify({ lastConceptionPath: tmp, recentConceptionPaths: [] }),
  );
  const { registerProjectsIpc } = await import('./projects');
  registerProjectsIpc();
});

afterEach(async () => {
  try {
    const { drainSettingsQueue } = await import('../settings');
    await drainSettingsQueue();
  } catch {
    /* Module not loaded yet — fine. */
  }
  rmSync(tmp, { recursive: true, force: true });
  vi.doUnmock('../user-data-dir');
});

describe('setProjectStar / getStarredProjects', () => {
  it('starts empty and round-trips a star through the conception config', async () => {
    expect(await getStarred()).toEqual([]);

    expect(await setStar('2026-08-18-alpha', true)).toEqual(['2026-08-18-alpha']);

    const onDisk = await readConceptionConfig();
    expect(onDisk.starredProjects).toEqual(['2026-08-18-alpha']);
    expect(await getStarred()).toEqual(['2026-08-18-alpha']);
  });

  it('keeps the conception-scoped key out of the global settings file', async () => {
    await setStar('2026-08-18-alpha', true);
    const globalRaw = await fs.readFile(settingsPathValue, 'utf8');
    expect((JSON.parse(globalRaw) as Record<string, unknown>).starredProjects).toBeUndefined();
  });

  it('accumulates stars in sorted order and dedupes a repeat', async () => {
    await setStar('2026-08-18-beta', true);
    await setStar('2026-08-18-alpha', true);
    expect(await setStar('2026-08-18-beta', true)).toEqual(['2026-08-18-alpha', '2026-08-18-beta']);
  });

  it('drops the key entirely once the last star is removed', async () => {
    await setStar('2026-08-18-alpha', true);
    await setStar('2026-08-18-beta', true);

    expect(await setStar('2026-08-18-alpha', false)).toEqual(['2026-08-18-beta']);
    expect((await readConceptionConfig()).starredProjects).toEqual(['2026-08-18-beta']);

    expect(await setStar('2026-08-18-beta', false)).toEqual([]);
    expect('starredProjects' in (await readConceptionConfig())).toBe(false);
    expect(await getStarred()).toEqual([]);
  });

  it('preserves unrelated conception config keys across a toggle', async () => {
    await fs.mkdir(join(tmp, '.condash'), { recursive: true });
    await fs.writeFile(
      conceptionConfigPathValue,
      JSON.stringify({ workspace_path: '/home/alice/src', starredProjects: ['2026-08-18-kept'] }),
    );

    await setStar('2026-08-18-new', true);
    const onDisk = await readConceptionConfig();
    expect(onDisk.workspace_path).toBe('/home/alice/src');
    expect(onDisk.starredProjects).toEqual(['2026-08-18-kept', '2026-08-18-new']);
  });

  it('normalises a hand-corrupted list on read and on write', async () => {
    await fs.mkdir(join(tmp, '.condash'), { recursive: true });
    await fs.writeFile(
      conceptionConfigPathValue,
      JSON.stringify({ starredProjects: [' 2026-08-18-a ', '', 7, '2026-08-18-a'] }),
    );

    expect(await getStarred()).toEqual(['2026-08-18-a']);
    expect(await setStar('2026-08-18-b', true)).toEqual(['2026-08-18-a', '2026-08-18-b']);
  });

  it('drops the starred slugs it is handed and persists the shrunk list', async () => {
    await setStar('2026-08-18-alpha', true);
    await setStar('2026-08-18-beta', true);

    expect(await prune(['2026-08-18-beta'])).toEqual(['2026-08-18-alpha']);
    // Persisted, not merely filtered on the way out — a reopen must not
    // resurrect the star, and the config must not accumulate dead slugs.
    expect((await readConceptionConfig()).starredProjects).toEqual(['2026-08-18-alpha']);
    expect(await getStarred()).toEqual(['2026-08-18-alpha']);
  });

  it('removes the key when every starred item is done', async () => {
    await setStar('2026-08-18-alpha', true);

    expect(await prune(['2026-08-18-alpha', '2026-08-18-unstarred'])).toEqual([]);
    expect('starredProjects' in (await readConceptionConfig())).toBe(false);
  });

  it('leaves a slug it was not handed alone, in one write', async () => {
    // The caller passes the done slugs it knows about. A star it never
    // mentioned — an item it has not loaded, or one that resolves to nothing
    // at all — must survive: under-pruning is recoverable, over-pruning is not.
    await setStar('2026-08-18-alpha', true);
    await setStar('2026-08-18-gone', true);

    expect(await prune(['2026-08-18-alpha'])).toEqual(['2026-08-18-gone']);
  });

  it('is a no-op for an empty batch and preserves unrelated config keys', async () => {
    await fs.mkdir(join(tmp, '.condash'), { recursive: true });
    await fs.writeFile(
      conceptionConfigPathValue,
      JSON.stringify({ workspace_path: '/home/alice/src', starredProjects: ['2026-08-18-kept'] }),
    );

    expect(await prune([])).toEqual(['2026-08-18-kept']);
    expect((await readConceptionConfig()).workspace_path).toBe('/home/alice/src');
  });

  it('rejects a non-array batch', async () => {
    await expect(prune('2026-08-18-alpha')).rejects.toThrow(/pruneStarredProjects/);
  });

  it('treats a non-true `starred` argument as unstar and rejects a blank slug', async () => {
    await setStar('2026-08-18-alpha', true);
    // Anything other than a literal `true` unstars — the renderer only ever
    // sends booleans, but the handler must not star on a truthy string.
    expect(await setStar('2026-08-18-alpha', 'yes')).toEqual([]);
    await expect(setStar('', true)).rejects.toThrow(/setProjectStar/);
  });
});
