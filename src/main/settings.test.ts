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
          projectsWidth: 320,
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
