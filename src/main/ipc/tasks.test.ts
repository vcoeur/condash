/**
 * Tasks-IPC tests for the per-task config (`taskConfig`) read/write path.
 *
 * Regression cover for the shipped bug where per-task `runMode` was added to
 * the schema, types, editor UI, and scheduler but the `setTaskConfig` handler
 * kept a stale three-key projection (`schedule` / `timeout` / `excludeFromLogs`)
 * — so saving a task as one-shot (`--run`) silently dropped `runMode`, and on
 * reopen the task reverted to the interactive (`--prompt`) default.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskConfigEntry } from '../../shared/types';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => '/tmp/electron-app' },
}));

let tmp: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let handlers: Record<string, (...args: any[]) => Promise<unknown>>;
let settingsPathValue: string;
let conceptionConfigPathValue: string;

/** Minimal event shape accepted by `requireMainWindowSender`. */
const trustedEvent = {
  sender: { getType: () => 'window' },
  senderFrame: { url: 'file:///app/dist/index.html', parent: null },
};

/** Read the conception config file (`<conception>/.condash/settings.json`) —
 *  the conception-scoped home `setTaskConfig` writes `taskConfig` into. */
async function readConceptionConfig(): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(conceptionConfigPathValue, 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

async function getTaskConfig(): Promise<Record<string, TaskConfigEntry>> {
  return (await handlers.getTaskConfig(trustedEvent)) as Record<string, TaskConfigEntry>;
}

beforeEach(async () => {
  vi.resetModules();
  tmp = mkdtempSync(join(tmpdir(), 'condash-task-config-'));
  settingsPathValue = join(tmp, 'settings.json');
  conceptionConfigPathValue = join(tmp, '.condash', 'settings.json');
  const isolatedTmp = tmp;
  vi.doMock('../user-data-dir', () => ({ userDataDir: () => isolatedTmp }));

  handlers = {};
  const { ipcMain } = await import('electron');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ipcMain.handle as any).mockImplementation(
    (channel: string, fn: (...args: any[]) => Promise<unknown>) => {
      handlers[channel] = fn;
    },
  );
  // Point the active conception at the tmp dir via the global settings pointer.
  // `taskConfig` is conception-scoped, so setTaskConfig writes it into
  // `<tmp>/.condash/settings.json`; the global settings.json carries only the
  // path pointer and never a `taskConfig` key.
  await fs.writeFile(
    settingsPathValue,
    JSON.stringify({ lastConceptionPath: tmp, recentConceptionPaths: [] }),
  );
  const { registerTasksIpc } = await import('./tasks');
  registerTasksIpc();
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

describe('setTaskConfig / getTaskConfig runMode round-trip', () => {
  it('persists a one-shot runMode and reads it back', async () => {
    await handlers.setTaskConfig(trustedEvent, 'sample-task', {
      schedule: '1m',
      runMode: 'oneshot',
    });

    const onDisk = await readConceptionConfig();
    expect(onDisk.taskConfig).toEqual({ 'sample-task': { schedule: '1m', runMode: 'oneshot' } });

    // F1 regression: the conception-scoped key must NOT leak into the
    // per-machine global settings.json — a write there throws `Unrecognized
    // key` on the next Global Settings save.
    const globalRaw = await fs.readFile(settingsPathValue, 'utf8');
    expect((JSON.parse(globalRaw) as Record<string, unknown>).taskConfig).toBeUndefined();

    const effective = await getTaskConfig();
    expect(effective['sample-task'].runMode).toBe('oneshot');
  });

  it('does not persist the interactive default (stays absent)', async () => {
    await handlers.setTaskConfig(trustedEvent, 'sample-task', {
      schedule: '1m',
      runMode: 'interactive',
    });

    const onDisk = await readConceptionConfig();
    // interactive is the implied default — only schedule survives.
    expect(onDisk.taskConfig).toEqual({ 'sample-task': { schedule: '1m' } });

    const effective = await getTaskConfig();
    expect(effective['sample-task'].runMode).toBeUndefined();
  });

  it('keeps a task whose only setting is a one-shot runMode', async () => {
    // The delete-guard must treat runMode as a real setting, not prune the
    // entry as empty when schedule/timeout/excludeFromLogs are all absent.
    await handlers.setTaskConfig(trustedEvent, 'solo', { runMode: 'oneshot' });

    const onDisk = await readConceptionConfig();
    expect(onDisk.taskConfig).toEqual({ solo: { runMode: 'oneshot' } });
  });

  it('persists runMode alongside the other per-task settings', async () => {
    await handlers.setTaskConfig(trustedEvent, 'sample-task', {
      schedule: '1m',
      timeout: '10m',
      excludeFromLogs: true,
      runMode: 'oneshot',
    });

    const onDisk = await readConceptionConfig();
    expect(onDisk.taskConfig).toEqual({
      'sample-task': { schedule: '1m', timeout: '10m', excludeFromLogs: true, runMode: 'oneshot' },
    });
  });
});

describe('setTaskConfig / getTaskConfig gateOnUpdatedTabs round-trip', () => {
  it('persists an opted-in growth gate and reads it back', async () => {
    await handlers.setTaskConfig(trustedEvent, 'sample-task', {
      schedule: '1m',
      gateOnUpdatedTabs: true,
    });

    const onDisk = await readConceptionConfig();
    expect(onDisk.taskConfig).toEqual({
      'sample-task': { schedule: '1m', gateOnUpdatedTabs: true },
    });

    const effective = await getTaskConfig();
    expect(effective['sample-task'].gateOnUpdatedTabs).toBe(true);
  });

  it('does not persist the default (no gate) — stays absent', async () => {
    await handlers.setTaskConfig(trustedEvent, 'sample-task', {
      schedule: '1m',
      gateOnUpdatedTabs: false,
    });

    const onDisk = await readConceptionConfig();
    expect(onDisk.taskConfig).toEqual({ 'sample-task': { schedule: '1m' } });

    const effective = await getTaskConfig();
    expect(effective['sample-task'].gateOnUpdatedTabs).toBeUndefined();
  });

  it('keeps a task whose only setting is the growth gate', async () => {
    // The delete-guard must treat gateOnUpdatedTabs as a real setting.
    await handlers.setTaskConfig(trustedEvent, 'solo', { gateOnUpdatedTabs: true });

    const onDisk = await readConceptionConfig();
    expect(onDisk.taskConfig).toEqual({ solo: { gateOnUpdatedTabs: true } });
  });
});
