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
