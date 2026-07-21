/**
 * Regression cover for the `perfSetEnabled` write path.
 *
 * `setTerminalPrefs` REPLACES the whole `terminal` block despite reading like a
 * patch, so a handler that writes `{ perf: … }` on its own silently wipes the
 * user's shell, shortcuts, logging, and memory caps. That is the same
 * settings-clobbering class the repo has shipped several times before (the
 * `taskConfig.runMode` projection, the `cardMinWidth` key list); this locks the
 * merge so the toggle can never become destructive again.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalPrefs } from '../../shared/types';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  clipboard: { readText: () => '' },
  app: { getPath: () => '/tmp/electron-app' },
}));

let tmp: string;
let settingsPathValue: string;
let handlers: Record<string, (...args: any[]) => Promise<unknown>>;

const trustedEvent = {
  sender: { getType: () => 'window' },
  senderFrame: { url: 'file:///app/dist/index.html', parent: null },
};

/** The `terminal` block a real user has: several unrelated keys the perf toggle
 *  must not touch. */
const EXISTING_TERMINAL: TerminalPrefs = {
  shell: '/usr/bin/fish',
  shortcut: 'Ctrl+T',
  logging: { enabled: true, retentionDays: 30 },
  memory: { enabled: true, high: '4G', max: '6G' },
};

async function readSettingsFile(): Promise<Record<string, any>> {
  return JSON.parse(await fs.readFile(settingsPathValue, 'utf8'));
}

beforeEach(async () => {
  vi.resetModules();
  tmp = mkdtempSync(join(tmpdir(), 'condash-perf-toggle-'));
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
  await fs.writeFile(
    settingsPathValue,
    JSON.stringify({
      lastConceptionPath: tmp,
      recentConceptionPaths: [],
      terminal: EXISTING_TERMINAL,
    }),
  );
  const { registerTerminalIpc } = await import('./terminal');
  registerTerminalIpc();
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

describe('perfSetEnabled', () => {
  it('persists the flag without clobbering the rest of the terminal block', async () => {
    await handlers.perfSetEnabled(trustedEvent, true);

    const settings = await readSettingsFile();
    expect(settings.terminal.perf).toEqual({ enabled: true });
    // The whole point: every pre-existing key survives.
    expect(settings.terminal.shell).toBe('/usr/bin/fish');
    expect(settings.terminal.shortcut).toBe('Ctrl+T');
    expect(settings.terminal.logging).toEqual({ enabled: true, retentionDays: 30 });
    expect(settings.terminal.memory).toEqual({ enabled: true, high: '4G', max: '6G' });
  });

  it('round-trips back off, still without collateral damage', async () => {
    await handlers.perfSetEnabled(trustedEvent, true);
    await handlers.perfSetEnabled(trustedEvent, false);

    const settings = await readSettingsFile();
    expect(settings.terminal.perf).toEqual({ enabled: false });
    expect(settings.terminal.shell).toBe('/usr/bin/fish');
    expect(settings.terminal.memory).toEqual({ enabled: true, high: '4G', max: '6G' });
  });

  it('treats any non-true payload as off rather than throwing', async () => {
    // The renderer is the only caller, but a malformed payload must not leave
    // recording in an indeterminate state.
    await handlers.perfSetEnabled(trustedEvent, 'yes');
    const settings = await readSettingsFile();
    expect(settings.terminal.perf).toEqual({ enabled: false });
  });

  it('reports vitals back to the caller', async () => {
    const vitals = (await handlers.perfSetEnabled(trustedEvent, true)) as {
      recording: boolean;
      heapUsed: number;
    };
    expect(vitals.recording).toBe(true);
    expect(vitals.heapUsed).toBeGreaterThan(0);
  });
});
