/**
 * Unit tests for the settings.json read/write layer: the session-only
 * `CONDASH_CONCEPTION_PATH` override (it must never persist to disk),
 * the read-path legacy migration, and the degenerate-JSON-root guard.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmp: string;
let settingsFile: string;
let savedEnvOverride: string | undefined;

async function loadSettingsModule(): Promise<typeof import('./settings')> {
  return import('./settings');
}

beforeEach(() => {
  vi.resetModules();
  tmp = mkdtempSync(join(tmpdir(), 'condash-settings-'));
  settingsFile = join(tmp, 'settings.json');
  const isolatedTmp = tmp;
  vi.doMock('./user-data-dir', () => ({ userDataDir: () => isolatedTmp }));
  savedEnvOverride = process.env.CONDASH_CONCEPTION_PATH;
  delete process.env.CONDASH_CONCEPTION_PATH;
});

afterEach(async () => {
  const { drainSettingsQueue } = await loadSettingsModule();
  await drainSettingsQueue();
  if (savedEnvOverride === undefined) delete process.env.CONDASH_CONCEPTION_PATH;
  else process.env.CONDASH_CONCEPTION_PATH = savedEnvOverride;
  rmSync(tmp, { recursive: true, force: true });
  vi.doUnmock('./user-data-dir');
});

describe('CONDASH_CONCEPTION_PATH override', () => {
  it('overlays lastConceptionPath on read', async () => {
    await fs.writeFile(settingsFile, JSON.stringify({ lastConceptionPath: '/real/tree' }));
    process.env.CONDASH_CONCEPTION_PATH = '/scratch/tree';
    const { readSettings } = await loadSettingsModule();
    expect((await readSettings()).lastConceptionPath).toBe('/scratch/tree');
  });

  it('is never persisted by a settings mutation', async () => {
    await fs.writeFile(settingsFile, JSON.stringify({ lastConceptionPath: '/real/tree' }));
    process.env.CONDASH_CONCEPTION_PATH = '/scratch/tree';
    const { updateSettings } = await loadSettingsModule();
    await updateSettings((cur) => ({ ...cur, theme: 'dark' }));
    const onDisk = JSON.parse(await fs.readFile(settingsFile, 'utf8')) as Record<string, unknown>;
    expect(onDisk.theme).toBe('dark');
    expect(onDisk.lastConceptionPath).toBe('/real/tree');
  });

  it('an explicit mutation of lastConceptionPath still persists', async () => {
    await fs.writeFile(settingsFile, JSON.stringify({ lastConceptionPath: '/real/tree' }));
    process.env.CONDASH_CONCEPTION_PATH = '/scratch/tree';
    const { updateSettings } = await loadSettingsModule();
    await updateSettings((cur) => ({ ...cur, lastConceptionPath: '/picked/tree' }));
    const onDisk = JSON.parse(await fs.readFile(settingsFile, 'utf8')) as Record<string, unknown>;
    expect(onDisk.lastConceptionPath).toBe('/picked/tree');
  });
});

describe('read-path legacy migration', () => {
  it('migrates a persisted leftView "outputs" to "deliverables"', async () => {
    await fs.writeFile(
      settingsFile,
      JSON.stringify({
        layout: {
          projects: true,
          leftView: 'outputs',
          working: 'code',
          terminal: true,
          projectsSplit: 0.32,
        },
      }),
    );
    const { readSettings } = await loadSettingsModule();
    const settings = await readSettings();
    expect(settings.layout?.leftView).toBe('deliverables');
  });
});

describe('degenerate settings.json roots', () => {
  it.each([
    ['null', 'null'],
    ['a string', '"hello"'],
    ['an array', '[1, 2]'],
  ])('falls back to defaults when the root is %s', async (_label, body) => {
    await fs.writeFile(settingsFile, body);
    const { readSettings, DEFAULT_LAYOUT } = await loadSettingsModule();
    const settings = await readSettings();
    expect(settings.lastConceptionPath).toBeNull();
    expect(settings.recentConceptionPaths).toEqual([]);
    expect(settings.layout).toEqual(DEFAULT_LAYOUT);
  });

  it('a mutation on a degenerate root still writes a valid file', async () => {
    await fs.writeFile(settingsFile, 'null');
    const { updateSettings } = await loadSettingsModule();
    await updateSettings((cur) => ({ ...cur, theme: 'light' }));
    const onDisk = JSON.parse(await fs.readFile(settingsFile, 'utf8')) as Record<string, unknown>;
    expect(onDisk.theme).toBe('light');
  });
});

describe('corrupt settings.json recovery (B1)', () => {
  it('boots with defaults and renames the corrupt file aside on a parse error', async () => {
    // A truncated / hand-broken JSON body — JSON.parse throws a SyntaxError.
    await fs.writeFile(settingsFile, '{ "theme": "dark", ');
    const { readSettings, DEFAULT_LAYOUT } = await loadSettingsModule();
    const settings = await readSettings();
    // Degrades to defaults rather than rethrowing into the boot chain.
    expect(settings.lastConceptionPath).toBeNull();
    expect(settings.theme).toBe('system');
    expect(settings.layout).toEqual(DEFAULT_LAYOUT);
    // The original path is cleared…
    await expect(fs.access(settingsFile)).rejects.toThrow();
    // …and a `.corrupt-<ts>` sibling now holds the bad content.
    const entries = await fs.readdir(tmp);
    const aside = entries.filter((e) => e.startsWith('settings.json.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(await fs.readFile(join(tmp, aside[0]), 'utf8')).toBe('{ "theme": "dark", ');
  });

  it('a subsequent write after recovery produces a valid file', async () => {
    await fs.writeFile(settingsFile, 'not json at all');
    const { readSettings, updateSettings } = await loadSettingsModule();
    // Recovery renames the corrupt file aside and returns defaults.
    await readSettings();
    await updateSettings((cur) => ({ ...cur, theme: 'light' }));
    const onDisk = JSON.parse(await fs.readFile(settingsFile, 'utf8')) as Record<string, unknown>;
    expect(onDisk.theme).toBe('light');
  });
});

describe('mutateSettingsJson corrupt-file recovery (C2)', () => {
  it('quarantines a corrupt settings.json and writes a valid replacement', async () => {
    await fs.writeFile(settingsFile, '{ "theme": "dark", ');
    const { mutateSettingsJson } = await loadSettingsModule();
    await mutateSettingsJson((current) => {
      current.theme = 'light';
    });
    // The corrupt file was moved aside…
    const entries = await fs.readdir(tmp);
    const aside = entries.filter((e) => e.startsWith('settings.json.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(await fs.readFile(join(tmp, aside[0]), 'utf8')).toBe('{ "theme": "dark", ');
    // …and a fresh, valid file holds the mutation.
    const onDisk = JSON.parse(await fs.readFile(settingsFile, 'utf8')) as Record<string, unknown>;
    expect(onDisk.theme).toBe('light');
  });

  it('creates a valid file from scratch when settings.json is missing', async () => {
    const { mutateSettingsJson } = await loadSettingsModule();
    await mutateSettingsJson((current) => {
      current.terminal = { shell: '/bin/zsh' };
    });
    const onDisk = JSON.parse(await fs.readFile(settingsFile, 'utf8')) as Record<string, unknown>;
    expect(onDisk.terminal).toEqual({ shell: '/bin/zsh' });
  });
});

describe('settings.json read memo', () => {
  // `dark` and `lite` are both 4-char sentinels: writing one over the other
  // keeps the JSON byte length (hence the stat `size`) identical, so these tests
  // can isolate the `mtime` half of the (mtimeMs, size) memo key. (`lite` is not
  // a real Theme — the zod-free read path doesn't validate, it just round-trips.)
  it('caches an unchanged file and returns the same object reference', async () => {
    await fs.writeFile(settingsFile, JSON.stringify({ theme: 'dark' }));
    const { readSettings } = await loadSettingsModule();
    const first = await readSettings();
    const second = await readSettings();
    // A cache hit returns the memoised object — it did not re-read or re-parse.
    expect(second).toBe(first);
    expect(first.theme).toBe('dark');
  });

  it('re-reads once the file mtime changes (same size)', async () => {
    await fs.writeFile(settingsFile, JSON.stringify({ theme: 'dark' }));
    const { readSettings } = await loadSettingsModule();
    expect((await readSettings()).theme).toBe('dark');
    // Rewrite with a same-length value and force a strictly-later mtime so only
    // the mtime half of the key can trigger the miss.
    await fs.writeFile(settingsFile, JSON.stringify({ theme: 'lite' }));
    const { mtimeMs } = await fs.stat(settingsFile);
    const later = new Date(mtimeMs + 5000);
    await fs.utimes(settingsFile, later, later);
    expect((await readSettings()).theme).toBe('lite');
  });

  it('a settings write invalidates the memo', async () => {
    await fs.writeFile(settingsFile, JSON.stringify({ theme: 'dark' }));
    const { readSettings, updateSettings } = await loadSettingsModule();
    expect((await readSettings()).theme).toBe('dark');
    await updateSettings((cur) => ({ ...cur, theme: 'light' }));
    expect((await readSettings()).theme).toBe('light');
  });

  it('serves a stale hit under an unchanged stat, and invalidateSettingsMemo forces a re-read', async () => {
    // Pin a fixed integer-ms mtime so an in-place same-length rewrite keeps the
    // exact (mtimeMs, size) key — proving both the staleness contract and that
    // explicit invalidation (not a stat change) is what forces the re-read.
    const pinned = new Date(1_700_000_000_000);
    await fs.writeFile(settingsFile, JSON.stringify({ theme: 'dark' }));
    await fs.utimes(settingsFile, pinned, pinned);
    const { readSettings, invalidateSettingsMemo } = await loadSettingsModule();
    expect((await readSettings()).theme).toBe('dark');
    // Edit externally but restore the identical mtime and byte length: the memo
    // key is unchanged, so the stale parse is still served (accepted contract).
    await fs.writeFile(settingsFile, JSON.stringify({ theme: 'lite' }));
    await fs.utimes(settingsFile, pinned, pinned);
    expect((await readSettings()).theme).toBe('dark');
    // Explicit invalidation drops the memo → the next read re-reads from disk.
    invalidateSettingsMemo();
    expect((await readSettings()).theme).toBe('lite');
  });

  it('falls back to defaults (and drops the memo) when the file is removed', async () => {
    await fs.writeFile(settingsFile, JSON.stringify({ theme: 'dark' }));
    const { readSettings, DEFAULT_LAYOUT } = await loadSettingsModule();
    expect((await readSettings()).theme).toBe('dark');
    await fs.rm(settingsFile);
    const afterRemoval = await readSettings();
    expect(afterRemoval.theme).toBe('system');
    expect(afterRemoval.layout).toEqual(DEFAULT_LAYOUT);
  });
});
