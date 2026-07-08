/**
 * Tests for `writeNote`'s global-settings branch: the raw Settings-modal save
 * must share the in-process settings queue with `updateSettings`, so a narrow
 * IPC mutation (setTheme, setLayout, …) landing during a raw save is never
 * silently overwritten — the raw save's drift check fails loudly instead.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmp: string;
let settingsFile: string;

beforeEach(() => {
  vi.resetModules();
  tmp = mkdtempSync(join(tmpdir(), 'condash-write-config-'));
  settingsFile = join(tmp, 'settings.json');
  const isolatedTmp = tmp;
  vi.doMock('./user-data-dir', () => ({ userDataDir: () => isolatedTmp }));
});

afterEach(async () => {
  const { drainSettingsQueue } = await import('./settings');
  await drainSettingsQueue();
  rmSync(tmp, { recursive: true, force: true });
  vi.doUnmock('./user-data-dir');
});

describe('writeNote on the global settings.json', () => {
  it('serialises against updateSettings instead of overwriting its result', async () => {
    const initial = JSON.stringify({ theme: 'light' }, null, 2) + '\n';
    await fs.writeFile(settingsFile, initial);
    const { updateSettings } = await import('./settings');
    const { writeNote } = await import('./write-config');

    // Hold the settings queue open mid-mutation so the raw save is forced to
    // queue behind it (pre-fix it would read+write concurrently and the
    // queued mutation's result would be lost).
    let releaseMutator!: () => void;
    const mutatorGate = new Promise<void>((resolve) => (releaseMutator = resolve));
    const mutation = updateSettings(async (cur) => {
      await mutatorGate;
      return { ...cur, theme: 'dark' };
    });
    // Let the mutation enter the queue and take its on-disk read.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Capture the outcome up-front: the rejection lands while we await the
    // mutation, and an unobserved rejection would trip vitest's
    // unhandled-error detector.
    const rawSaveError = writeNote(settingsFile, initial, JSON.stringify({ theme: 'system' })).then(
      () => null,
      (err: unknown) => err,
    );
    releaseMutator();
    await mutation;

    // The raw save ran after the mutation, saw the changed bytes, and failed
    // its drift check — the mutation's write survives.
    const err = await rawSaveError;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/drifted/);
    const onDisk = JSON.parse(await fs.readFile(settingsFile, 'utf8')) as Record<string, unknown>;
    expect(onDisk.theme).toBe('dark');
  });

  it('still performs a plain save when nothing is queued', async () => {
    const initial = JSON.stringify({ theme: 'light' }, null, 2) + '\n';
    await fs.writeFile(settingsFile, initial);
    const { writeNote } = await import('./write-config');
    const saved = await writeNote(settingsFile, initial, JSON.stringify({ theme: 'system' }));
    expect(JSON.parse(saved).theme).toBe('system');
    const onDisk = JSON.parse(await fs.readFile(settingsFile, 'utf8')) as Record<string, unknown>;
    expect(onDisk.theme).toBe('system');
  });
});

describe('writeNote config dispatch by directory (B4)', () => {
  let conceptionDir: string;

  // `settingsFile` (mocked user-data-dir) is the exact global settings path.
  // Point it at a conception root so the legacy-name dir-gate has a root to
  // compare against.
  beforeEach(async () => {
    conceptionDir = join(tmp, 'my-conception');
    await fs.mkdir(conceptionDir, { recursive: true });
    await fs.writeFile(
      settingsFile,
      JSON.stringify({ lastConceptionPath: conceptionDir }, null, 2) + '\n',
    );
  });

  // A body the strict conception-config schema rejects — its presence proves
  // which branch handled the write.
  const UNKNOWN_KEY_BODY = JSON.stringify({ totallyUnknownKey123: 1 }, null, 2);

  it('saves an in-tree docs/examples/configuration.json as a plain note', async () => {
    const { writeNote } = await import('./write-config');
    const sampleDir = join(conceptionDir, 'docs', 'examples');
    await fs.mkdir(sampleDir, { recursive: true });
    const samplePath = join(sampleDir, 'configuration.json');
    // Plain-note path: saved verbatim, never canonicalised or rejected.
    const saved = await writeNote(samplePath, '', UNKNOWN_KEY_BODY);
    expect(saved).toBe(UNKNOWN_KEY_BODY);
    expect(await fs.readFile(samplePath, 'utf8')).toBe(UNKNOWN_KEY_BODY);
  });

  it('still treats a legacy configuration.json AT the conception root as config', async () => {
    const { writeNote } = await import('./write-config');
    const legacyPath = join(conceptionDir, 'configuration.json');
    // Config path: the strict schema rejects the unknown key and throws.
    await expect(writeNote(legacyPath, '', UNKNOWN_KEY_BODY)).rejects.toThrow(
      /totallyUnknownKey123/,
    );
  });

  it('saves an in-tree settings.json (not the exact global path) as a plain note', async () => {
    const { writeNote } = await import('./write-config');
    const noteDir = join(conceptionDir, 'docs');
    await fs.mkdir(noteDir, { recursive: true });
    const notePath = join(noteDir, 'settings.json');
    const saved = await writeNote(notePath, '', UNKNOWN_KEY_BODY);
    expect(saved).toBe(UNKNOWN_KEY_BODY);
  });
});
