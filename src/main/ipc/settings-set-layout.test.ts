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
    leftView: 'projects',
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

  it('accepts EVERY LeftView the type allows', async () => {
    // Regression guard for a whole bug class, not one value. `layoutSchema`'s
    // leftView validator used to be a hand-written zod union; adding 'perf' to
    // the TS type left it stale, and tsc could not see the drift. The failure
    // was app-wide, not local to the new pane: `updateLayout` spreads the
    // persisted layout into every later write, so one unlisted view made every
    // subsequent layout save throw for as long as it stayed selected.
    // The schema is now built from LEFT_VIEWS; this asserts the two agree.
    const { LEFT_VIEWS } = await import('../../shared/types/layout');
    const { drainSettingsQueue } = await import('../settings');
    for (const leftView of LEFT_VIEWS) {
      await handlers.setLayout(trustedEvent, { ...validLayout, leftView });
      await drainSettingsQueue();
      expect(await handlers.getLayout(trustedEvent)).toMatchObject({ leftView });
    }
  });
});
