/**
 * `setLayout` validates its payload through `layoutSchema`, which is now
 * dynamic-imported from `config-schema` inside the handler (review finding S4)
 * so the ≈45 ms zod construction stays off the pre-window boot graph. This test
 * exercises that lazy seam: a valid layout persists, a malformed one is rejected
 * by the lazily-loaded schema.
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

const trustedEvent = {
  sender: { getType: () => 'window' },
  senderFrame: { url: 'file:///app/dist/index.html', parent: null },
};

beforeEach(async () => {
  vi.resetModules();
  tmp = mkdtempSync(join(tmpdir(), 'condash-set-layout-'));
  settingsPathValue = join(tmp, 'settings.json');
  const isolatedTmp = tmp;
  vi.doMock('../user-data-dir', () => ({ userDataDir: () => isolatedTmp }));

  handlers = {};
  const { ipcMain } = await import('electron');
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
    /* not loaded */
  }
  rmSync(tmp, { recursive: true, force: true });
  vi.doUnmock('../user-data-dir');
});

describe('setLayout (lazily-imported config-schema seam)', () => {
  const validLayout = {
    projects: true,
    working: 'code',
    terminal: true,
    projectsSplit: 0.32,
  };

  it('persists a valid layout via the lazily-loaded schema', async () => {
    await handlers.setLayout(trustedEvent, validLayout);
    const { drainSettingsQueue } = await import('../settings');
    await drainSettingsQueue();
    const onDisk = JSON.parse(await fs.readFile(settingsPathValue, 'utf8'));
    expect(onDisk.layout).toEqual(validLayout);
    expect(await handlers.getLayout(trustedEvent)).toEqual(validLayout);
  });

  it('rejects a malformed layout at the boundary', async () => {
    await expect(
      handlers.setLayout(trustedEvent, { projects: 'yes', working: 'nope' }),
    ).rejects.toThrow(/setLayout/);
  });

  it('accepts EVERY WorkingSurface the type allows', async () => {
    // Same regression guard, transposed onto the working union: the schema's
    // `working` validator must cover every value the TS type allows, because
    // `updateLayout` spreads the persisted layout into every later write — one
    // unlisted surface would make every subsequent layout save throw for as
    // long as it stayed selected. Enumerate from the type's DEFAULT_LAYOUT +
    // a literal over the union so a new surface cannot silently go untested.
    const { DEFAULT_LAYOUT } = await import('../settings');
    const { drainSettingsQueue } = await import('../settings');
    const surfaces = ['code', 'knowledge', 'resources', 'skills', 'automations', 'logs'] as const;
    for (const working of surfaces) {
      await handlers.setLayout(trustedEvent, { ...validLayout, working });
      await drainSettingsQueue();
      expect(await handlers.getLayout(trustedEvent)).toMatchObject({
        ...DEFAULT_LAYOUT,
        working,
      });
    }
  });

  it('rejects a retired shape: leftView key or a hidden working pane', async () => {
    // The strict schema is the migration backstop: a layout carrying the
    // retired `leftView` key, or `working: null` (the retired hide state), is
    // rejected at the IPC boundary rather than persisted. migrateRawSettings
    // maps legacy FILES before they reach this handler.
    await expect(
      handlers.setLayout(trustedEvent, { ...validLayout, leftView: 'projects' }),
    ).rejects.toThrow(/setLayout/);
    await expect(
      handlers.setLayout(trustedEvent, { ...validLayout, working: null }),
    ).rejects.toThrow(/setLayout/);
  });
});
