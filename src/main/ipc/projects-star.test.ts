/**
 * Projects-IPC tests for the card star flag (`starredProjects`).
 *
 * Three things are worth pinning at this layer. First, the scope:
 * `starredProjects` is conception-owned, so the write must land in
 * `<conception>/.condash/settings.json` and never in the per-machine global
 * `settings.json` — a key in the wrong file is rejected by that file's strict
 * schema on the next save (the same trap `setTaskConfig` fell into). Second, the
 * empty case: unstarring the last project must remove the key rather than leave
 * `"starredProjects": []` behind in an otherwise-untouched config. Third, the
 * done prune: `getStarredProjects` is where "a done item carries no star" is
 * enforced, and it has to *persist* the shrunk list — a filter that only
 * narrowed the returned value would let the stale slugs sit in the config for
 * ever, and would resurrect the star the moment the item was reopened.
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

/** Write a minimal item README so `listProjects` sees the slug at `status`. */
async function writeItem(slug: string, status: string): Promise<void> {
  const dir = join(tmp, 'projects', slug.slice(0, 7), slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    join(dir, 'README.md'),
    `---\ndate: ${slug.slice(0, 10)}\nkind: project\nstatus: ${status}\n---\n\n# ${slug}\n`,
    'utf8',
  );
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

  it('drops a starred slug once its item is done, and persists the shrunk list', async () => {
    await writeItem('2026-08-18-alpha', 'now');
    await writeItem('2026-08-18-beta', 'done');
    await setStar('2026-08-18-alpha', true);
    await setStar('2026-08-18-beta', true);

    expect(await getStarred()).toEqual(['2026-08-18-alpha']);
    // Persisted, not merely filtered on the way out — a reopen must not
    // resurrect the star, and the config must not accumulate dead slugs.
    const { drainSettingsQueue } = await import('../settings');
    await drainSettingsQueue();
    expect((await readConceptionConfig()).starredProjects).toEqual(['2026-08-18-alpha']);
  });

  it('removes the key when every starred item is done', async () => {
    await writeItem('2026-08-18-alpha', 'done');
    await setStar('2026-08-18-alpha', true);

    expect(await getStarred()).toEqual([]);
    const { drainSettingsQueue } = await import('../settings');
    await drainSettingsQueue();
    expect('starredProjects' in (await readConceptionConfig())).toBe(false);
  });

  it('leaves the config untouched when no starred item is done', async () => {
    await writeItem('2026-08-18-alpha', 'now');
    await writeItem('2026-08-18-beta', 'review');
    await setStar('2026-08-18-alpha', true);
    await setStar('2026-08-18-beta', true);

    expect(await getStarred()).toEqual(['2026-08-18-alpha', '2026-08-18-beta']);
  });

  it('keeps a starred slug whose item does not exist', async () => {
    // Inert, not done: nothing here can tell a deleted item from an unreadable
    // one, so the slug survives until the next deliberate unstar.
    await writeItem('2026-08-18-beta', 'done');
    await setStar('2026-08-18-gone', true);
    await setStar('2026-08-18-beta', true);

    expect(await getStarred()).toEqual(['2026-08-18-gone']);
  });

  it('treats a non-true `starred` argument as unstar and rejects a blank slug', async () => {
    await setStar('2026-08-18-alpha', true);
    // Anything other than a literal `true` unstars — the renderer only ever
    // sends booleans, but the handler must not star on a truthy string.
    expect(await setStar('2026-08-18-alpha', 'yes')).toEqual([]);
    await expect(setStar('', true)).rejects.toThrow(/setProjectStar/);
  });
});
