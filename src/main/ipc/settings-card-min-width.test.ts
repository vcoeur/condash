/**
 * Settings-IPC tests for the card-density (`cardMinWidth`) read/write path.
 *
 * Regression cover for the shipped bug where the Logs / Tasks / Deliverables
 * panes were added to the type + UI but the IPC handler kept a stale five-key
 * allow-list — so `setCardMinWidth({ logs })` threw `unknown key "logs"` on the
 * Global tab and `getCardMinWidth` silently dropped those keys on read. The
 * handler now derives its key list from the canonical `CARD_MIN_WIDTH_KEYS`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CARD_MIN_WIDTH } from '../../shared/types';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => '/tmp/electron-app' },
}));

let tmp: string;
let handlers: Record<string, (...args: any[]) => Promise<unknown>>;
let settingsPathValue: string;

/** Minimal event shape accepted by `requireMainWindowSender`. */
const trustedEvent = {
  sender: { getType: () => 'window' },
  senderFrame: { url: 'file:///app/dist/index.html', parent: null },
};

async function writeSettings(content: object): Promise<void> {
  await fs.writeFile(settingsPathValue, JSON.stringify(content));
}

async function readSettingsFile(): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(settingsPathValue, 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

beforeEach(async () => {
  vi.resetModules();
  tmp = mkdtempSync(join(tmpdir(), 'condash-card-min-width-'));
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
  // No conception open — getCardMinWidth then reads the global cardMinWidth.
  await writeSettings({ lastConceptionPath: null, recentConceptionPaths: [], terminal: {} });
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

describe('setCardMinWidth / getCardMinWidth round-trip', () => {
  it('persists and reads back the new logs / tasks / deliverables keys', async () => {
    await handlers.setCardMinWidth(trustedEvent, {
      projects: 700,
      logs: 500,
      tasks: 360,
      deliverables: 380,
    });

    // Read path returns the set values, with built-in defaults for the rest.
    const effective = (await handlers.getCardMinWidth(trustedEvent)) as Record<string, number>;
    expect(effective.projects).toBe(700);
    expect(effective.logs).toBe(500);
    expect(effective.tasks).toBe(360);
    expect(effective.deliverables).toBe(380);
    expect(effective.code).toBe(DEFAULT_CARD_MIN_WIDTH.code);

    // On disk only the non-default keys are kept (pruneDefaults).
    const onDisk = await readSettingsFile();
    expect(onDisk.cardMinWidth).toEqual({
      projects: 700,
      logs: 500,
      tasks: 360,
      deliverables: 380,
    });
  });

  it('round-trips every canonical card key', async () => {
    const widths = Object.fromEntries(Object.keys(DEFAULT_CARD_MIN_WIDTH).map((key) => [key, 700]));
    await handlers.setCardMinWidth(trustedEvent, widths);
    const effective = (await handlers.getCardMinWidth(trustedEvent)) as Record<string, number>;
    for (const key of Object.keys(DEFAULT_CARD_MIN_WIDTH)) {
      expect(effective[key], `getCardMinWidth should return ${key}`).toBe(700);
    }
  });

  it('rejects an unknown key (typo guard intact)', async () => {
    await expect(handlers.setCardMinWidth(trustedEvent, { logz: 500 })).rejects.toThrow(
      /unknown key/,
    );
  });

  it('drops a key whose value equals the built-in default', async () => {
    await handlers.setCardMinWidth(trustedEvent, { logs: DEFAULT_CARD_MIN_WIDTH.logs, tasks: 360 });
    const onDisk = await readSettingsFile();
    // logs == default → pruned; tasks != default → kept.
    expect(onDisk.cardMinWidth).toEqual({ tasks: 360 });
    const effective = (await handlers.getCardMinWidth(trustedEvent)) as Record<string, number>;
    expect(effective.logs).toBe(DEFAULT_CARD_MIN_WIDTH.logs);
  });

  it('clamps an out-of-range value to the inherited default', async () => {
    await handlers.setCardMinWidth(trustedEvent, { logs: 5 });
    const effective = (await handlers.getCardMinWidth(trustedEvent)) as Record<string, number>;
    // 5 < 120 floor → rejected by clampMinWidth → inherits the default.
    expect(effective.logs).toBe(DEFAULT_CARD_MIN_WIDTH.logs);
  });
});
