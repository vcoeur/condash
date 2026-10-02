import { expect, test, type ElectronApplication } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootApp, sendMenu } from './fixtures/electron-app';

/** Seed a local, harmless automation; no external agent or provider is launched. */
async function seedTask(root: string): Promise<void> {
  const dir = join(root, 'tasks', 'fixture');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'task.json'),
    JSON.stringify({ name: 'Fixture task', agent: 'fixture' }),
  );
  await writeFile(join(dir, 'prompt.md'), 'Review {TOPIC:docs}');
}

type Probe = {
  calls: Record<string, unknown[][]>;
  held: Set<string>;
  release: Record<string, () => void>;
};

/** Wrap the real main handlers, keeping their result but optionally delaying delivery. */
async function probeIpc(
  app: ElectronApplication,
  channels: string[],
  held: string[] = [],
): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, { channels, held }) => {
      const state: Probe = { calls: {}, held: new Set(held), release: {} };
      (globalThis as unknown as { overlayProbe: Probe }).overlayProbe = state;
      const handlers = (
        ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
      )._invokeHandlers;
      for (const channel of channels) {
        const original = handlers.get(channel)!;
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (event, ...args) => {
          (state.calls[channel] ??= []).push(args);
          const result = await original(event, ...args);
          if (state.held.has(channel)) {
            state.held.delete(channel);
            await new Promise<void>((resolve) => {
              state.release[channel] = resolve;
            });
          }
          return result;
        });
      }
    },
    { channels, held },
  );
}

async function calls(app: ElectronApplication, channel: string): Promise<unknown[][]> {
  return app.evaluate(
    (_, channel) =>
      (globalThis as unknown as { overlayProbe: Probe }).overlayProbe.calls[channel] ?? [],
    channel,
  );
}

async function release(app: ElectronApplication, channel: string): Promise<void> {
  await app.evaluate(
    (_, channel) =>
      (globalThis as unknown as { overlayProbe: Probe }).overlayProbe.release[channel]?.(),
    channel,
  );
}

async function switchConception(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, path) =>
      BrowserWindow.getAllWindows()[0]?.webContents.send('menu-open-recent', path),
    path,
  );
}

async function seedLogs(root: string, label: string): Promise<string> {
  const now = new Date();
  const day = [
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ];
  const dir = join(root, '.condash', 'logs', ...day);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `091203-t-${label}.txt`);
  const content =
    '# condash: ' +
    JSON.stringify({
      sid: `t-${label}`,
      side: 'my',
      cmd: label,
      started: now.toISOString(),
      kind: 'transcript',
    }) +
    `\n${label} searchable transcript\n`;
  await writeFile(file, content);
  const older = join(root, '.condash', 'logs', '2024', '01', '02');
  await mkdir(older, { recursive: true });
  await writeFile(join(older, `091203-t-older-${label}.txt`), content);
  const runs = join(root, '.condash', 'manual', label);
  await mkdir(runs, { recursive: true });
  await writeFile(join(runs, `20260102-091203-t-run-${label}.txt`), content);
  return file;
}

async function secondTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'condash-overlay-second-'));
  await mkdir(join(root, '.condash'), { recursive: true });
  await writeFile(join(root, '.condash', 'settings.json'), '{}');
  await mkdir(join(root, 'projects', '2026-10', '2026-10-02-second'), { recursive: true });
  await writeFile(
    join(root, 'projects', '2026-10', '2026-10-02-second', 'README.md'),
    '# Second\n\n**Status**: now\n**Kind**: project\n',
  );
  await seedTask(root);
  await seedLogs(root, 'second-tree');
  return root;
}

test('full-window utility overlays preserve drafts, close children first and restore focus', async () => {
  const booted = await bootApp({
    prepare: async (root) => {
      await seedTask(root);
      await seedLogs(root, 'narrow-fixture');
    },
    globalConfig: {
      agents: [{ id: 'fixture', label: 'Fixture', command: '/bin/echo', promptFlags: true }],
    },
  });
  const { window, app } = booted;
  try {
    await window.setViewportSize({ width: 760, height: 650 });
    await mkdir('tests/screenshots-out/overlays', { recursive: true });
    for (const label of ['Automations', 'Logs', 'Diagnostics', 'Settings']) {
      await expect(window.getByRole('button', { name: label, exact: true })).toBeInViewport();
    }
    await window.screenshot({ path: 'tests/screenshots-out/overlays/narrow-header.png' });
    const launch = window.getByRole('button', { name: 'Automations', exact: true });
    await launch.click();
    const parent = window.locator('.surface-overlay');
    expect(await parent.boundingBox()).toMatchObject({ x: 0, y: 0, width: 760, height: 650 });
    await window.locator('.tasks-row').click();
    await window.locator('.tasks-editor-delete').click();
    await window.keyboard.press('Tab');
    expect(
      await window.getByRole('alertdialog').evaluate((el) => el.contains(document.activeElement)),
    ).toBe(true);
    await window.keyboard.press('Escape');
    await expect(window.locator('.confirm-modal')).toHaveCount(0);
    await expect(window.locator('.tasks-editor-modal')).toBeVisible();
    await expect(parent).toBeVisible();
    const name = window.locator('.tasks-editor input[type="text"]').first();
    await name.fill('Unsaved edit');
    await window.keyboard.press('Escape');
    await expect(window.getByRole('alertdialog')).toContainText('Discard automation edits?');
    await window.keyboard.press('Escape');
    await expect(window.locator('.confirm-modal')).toHaveCount(0);
    await expect(name).toHaveValue('Unsaved edit');
    await window.locator('.surface-back').evaluate((el: HTMLButtonElement) => el.click());
    await expect(window.getByRole('alertdialog')).toBeVisible();
    await window.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(name).toHaveValue('Unsaved edit');
    await sendMenu(app, 'open-settings');
    await expect(window.getByRole('alertdialog')).toBeVisible();
    await window.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(window.locator('.settings-modal')).toHaveCount(0);
    await window.screenshot({ path: 'tests/screenshots-out/overlays/narrow-editor.png' });
    // A genuine backdrop click requires the same discard decision as Escape.
    await window
      .locator('.tasks-editor-modal')
      .locator('..')
      .click({ position: { x: 3, y: 3 } });
    await window.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(window.locator('.tasks-editor-modal')).toHaveCount(0);
    await expect(parent).toBeVisible();
    await window.locator('.tasks-run').click();
    await window.locator('.tasks-fill-scroll input').fill('typed run fields');
    await window.keyboard.press('Escape');
    await expect(window.getByRole('alertdialog')).toBeVisible();
    await window.screenshot({ path: 'tests/screenshots-out/overlays/narrow-discard.png' });
    await window.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(window.locator('.tasks-fill-modal')).toHaveCount(0);
    await window.keyboard.press('Escape');
    await expect(parent).toHaveCount(0);
    await expect(launch).toBeFocused();
    for (const label of ['Logs', 'Diagnostics']) {
      const button = window.getByRole('button', { name: label, exact: true });
      await button.click();
      await expect(parent).toHaveCount(1);
      await window.keyboard.press('Shift+Tab');
      expect(await parent.evaluate((el) => el.contains(document.activeElement))).toBe(true);
      await window.screenshot({
        path: `tests/screenshots-out/overlays/narrow-${label.toLowerCase()}.png`,
      });
      if (label === 'Logs') {
        await window.locator('.logs-session-card').first().click();
        await expect(window.locator('.logs-line')).toContainText([
          'narrow-fixture searchable transcript',
        ]);
        await window.screenshot({ path: 'tests/screenshots-out/overlays/narrow-log-viewer.png' });
        await window.keyboard.press('Escape');
        await expect(parent).toBeVisible();
      }
      await window.keyboard.press('Escape');
      await expect(parent).toHaveCount(0);
      await expect(button).toBeFocused();
    }
  } finally {
    await booted.cleanup();
  }
});

test('dirty conception switches require a decision and delayed task reads cannot resurrect old drafts', async () => {
  const second = await secondTree();
  const booted = await bootApp({
    prepare: seedTask,
    globalConfig: {
      agents: [{ id: 'fixture', label: 'Fixture', command: '/bin/echo', promptFlags: true }],
    },
  });
  const { window, app } = booted;
  try {
    await window.getByRole('button', { name: 'Automations', exact: true }).click();
    await window.locator('.tasks-row').click();
    const name = window.locator('.tasks-editor input').first();
    await name.fill('must keep');
    await switchConception(app, second);
    await expect(window.getByRole('alertdialog')).toBeVisible();
    expect(await window.evaluate(() => window.condash.getConceptionPath())).toBe(
      booted.conceptionDir,
    );
    await window.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(name).toHaveValue('must keep');
    await switchConception(app, second);
    await window.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(window.locator('.status-bar-path')).toHaveText(second);
    await expect(window.locator('.surface-overlay')).toHaveCount(0);
    await switchConception(app, booted.conceptionDir);
    await expect(window.locator('.status-bar-path')).toHaveText(booted.conceptionDir);
    await probeIpc(app, ['readTask'], ['readTask']);
    await window.getByRole('button', { name: 'Automations', exact: true }).click();
    await window.locator('.tasks-row').click();
    await expect.poll(async () => (await calls(app, 'readTask')).length).toBe(1);
    await switchConception(app, second);
    await expect(window.locator('.status-bar-path')).toHaveText(second);
    await release(app, 'readTask');
    await window.getByRole('button', { name: 'Automations', exact: true }).click();
    await expect(window.locator('.tasks-row')).toHaveCount(1);
    await expect(window.locator('.tasks-editor-modal, .tasks-fill-modal')).toHaveCount(0);
    // A held switch: the overlay closes, fill editing cannot start during it,
    // and an overlapping switch request is refused until the path agrees.
    await probeIpc(app, ['openConception'], ['openConception']);
    const overlap = switchConception(app, booted.conceptionDir);
    await expect.poll(async () => (await calls(app, 'openConception')).length).toBe(1);
    await expect(window.locator('.surface-overlay')).toHaveCount(0);
    await window.evaluate(() =>
      (document.querySelector('.tasks-run') as HTMLElement | null)?.click(),
    );
    await expect(window.locator('.tasks-fill-modal')).toHaveCount(0);
    const secondOverlap = switchConception(app, second);
    await expect.poll(async () => (await calls(app, 'openConception')).length).toBe(1);
    await release(app, 'openConception');
    await expect(window.locator('.status-bar-path')).toHaveText(booted.conceptionDir);
    await secondOverlap;
    await overlap;
    // The refused overlapping request for `second` leaves the committed
    // destination — the first tree — in place.
    await expect(window.locator('.status-bar-path')).toHaveText(booted.conceptionDir);
    await window.getByRole('button', { name: 'Automations', exact: true }).click();
    await window.locator('.tasks-run').click();
    await expect(window.locator('.tasks-fill-modal')).toBeVisible();
    await window.locator('.tasks-fill-scroll input').fill('keep run');
    await switchConception(app, booted.conceptionDir);
    await window.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(window.locator('.tasks-fill-scroll input')).toHaveValue('keep run');
    await window.keyboard.press('Escape');
    await window.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(window.locator('.tasks-fill-modal')).toHaveCount(0);
    // A held rename commit still lands its destination config and clears the
    // old slug before the editor closes or departure proceeds.
    await window.locator('.tasks-row').click();
    await window.locator('.tasks-editor input').first().fill('Renamed local fixture');
    await window
      .locator('.tasks-editor label', { hasText: 'Slug' })
      .locator('input')
      .fill('renamed-fixture');
    await probeIpc(app, ['writeTask', 'setTaskConfig'], ['writeTask']);
    await window.locator('.tasks-editor-actions button', { hasText: 'Save' }).click();
    await expect.poll(async () => (await calls(app, 'writeTask')).length).toBe(1);
    await expect(
      window.locator('.tasks-editor-actions button', { hasText: 'Cancel' }),
    ).toBeDisabled();
    await window.keyboard.press('Escape');
    await expect(window.locator('.tasks-editor-modal')).toBeVisible();
    await release(app, 'writeTask');
    await expect.poll(async () => (await calls(app, 'setTaskConfig')).length).toBe(2);
    await expect(window.locator('.tasks-editor-modal')).toHaveCount(0);
    const renamedDefinition = JSON.parse(
      await readFile(join(booted.conceptionDir, 'tasks', 'renamed-fixture', 'task.json'), 'utf8'),
    );
    expect(renamedDefinition.name).toBe('Renamed local fixture');
    const storedConfig = await window.evaluate(() => window.condash.getTaskConfig());
    expect(storedConfig.renamedFixture?.schedule).toBeUndefined();
    expect(storedConfig.fixture).toBeUndefined();
    await expect(window.locator('.tasks-row')).toHaveCount(1);
    await expect(window.locator('.tasks-row')).toContainText('Renamed local fixture');
  } finally {
    await booted.cleanup();
    await rm(second, { recursive: true, force: true });
  }
});

test('Logs keeps lazy archives and child-first viewer deletion, consumes search once and drops delayed old-tree results', async () => {
  const second = await secondTree();
  let firstLog = '';
  const booted = await bootApp({
    globalConfig: { terminal: { logging: { retentionDays: 0 } } },
    prepare: async (root) => {
      firstLog = await seedLogs(root, 'first-tree');
    },
  });
  const { window, app } = booted;
  try {
    await probeIpc(app, ['logsListSessions', 'logsReadSession', 'logsListTaskRuns']);
    await window.getByRole('button', { name: 'Logs', exact: true }).click();
    await expect(window.locator('.logs-session-card')).toHaveCount(1);
    expect(await calls(app, 'logsListSessions')).toHaveLength(1);
    await expect(window.locator('.logs-month-header')).toHaveCount(1);
    await window.screenshot({ path: 'tests/screenshots-out/overlays/logs-archive.png' });
    await window.locator('.logs-month-header').click();
    await expect(window.locator('.logs-session-card')).toHaveCount(2);
    expect(await calls(app, 'logsListSessions')).toHaveLength(2);
    await window.locator('.logs-session-card').first().click();
    await expect(window.locator('.logs-line')).toContainText(['first-tree searchable transcript']);
    await window.locator('.logs-search').fill('searchable');
    await expect(window.locator('.logs-hit-count')).toContainText('1 / 1');
    await window.getByRole('button', { name: 'Delete this session', exact: true }).click();
    await window.keyboard.press('Escape');
    await expect(window.locator('.confirm-modal')).toHaveCount(0);
    await expect(window.locator('.logs-modal')).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(window.locator('.logs-modal')).toHaveCount(0);
    await expect(window.locator('.surface-overlay')).toBeVisible();
    await window.getByRole('tab', { name: 'Task runs', exact: true }).click();
    await expect(window.locator('.logs-taskruns')).toContainText('first-tree');
    await sendMenu(app, 'search');
    await window.locator('.search-modal-input').fill('searchable');
    await window.getByRole('radio', { name: 'Logs' }).click();
    await window.locator('.search-row').first().click();
    await expect(window.locator('.logs-modal')).toBeVisible();
    await expect(window.locator('.surface-overlay')).toHaveCount(1);
    await window.keyboard.press('Escape');
    await window.keyboard.press('Escape');
    await window.getByRole('button', { name: 'Logs', exact: true }).click();
    await expect(window.locator('.logs-modal')).toHaveCount(0);
    await window.keyboard.press('Escape');
    await window.getByRole('button', { name: 'Logs', exact: true }).click();
    await expect(window.locator('.logs-session-card')).toHaveCount(1);
    await probeIpc(
      app,
      ['logsDeleteSession', 'logsListDays', 'logsListSessions', 'logsListTaskRuns'],
      ['logsDeleteSession'],
    );
    await window.locator('.logs-session-card').first().click();
    await window.getByRole('button', { name: 'Delete this session', exact: true }).click();
    await window.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect
      .poll(async () =>
        app.evaluate(() =>
          Boolean(
            (globalThis as unknown as { overlayProbe: Probe }).overlayProbe.release
              .logsDeleteSession,
          ),
        ),
      )
      .toBe(true);
    expect(await calls(app, 'logsDeleteSession')).toHaveLength(1);
    await window.keyboard.press('Escape');
    await window.keyboard.press('Escape');
    await window.keyboard.press('Escape');
    await expect(window.locator('.surface-overlay')).toHaveCount(0);
    await release(app, 'logsDeleteSession');
    await window.evaluate(() => window.condash.getConceptionPath());
    expect(await calls(app, 'logsListDays')).toHaveLength(0);
    expect(await calls(app, 'logsListSessions')).toHaveLength(0);
    expect(await calls(app, 'logsListTaskRuns')).toHaveLength(0);
    // The deletion probe above already wraps `logsDeleteSession`; re-wrap the
    // read/task-run pair for this second held-response stage.
    await probeIpc(
      app,
      ['logsReadSession', 'logsListTaskRuns'],
      ['logsReadSession', 'logsListTaskRuns'],
    );
    await window.getByRole('button', { name: 'Logs', exact: true }).click();
    await expect(window.locator('.logs-month-header')).toHaveCount(1);
    await window.locator('.logs-month-header').click();
    await expect(window.locator('.logs-session-card')).toHaveCount(1);
    await window.locator('.logs-session-card').first().click();
    await expect(window.locator('.logs-modal')).toBeVisible();
    await expect.poll(async () => (await calls(app, 'logsReadSession')).length).toBe(1);
    await switchConception(app, second);
    await expect(window.locator('.status-bar-path')).toHaveText(second);
    await expect
      .poll(async () => window.evaluate(() => window.condash.getConceptionPath()))
      .toBe(second);
    await release(app, 'logsReadSession');
    await release(app, 'logsListTaskRuns');
    await window.getByRole('button', { name: 'Logs', exact: true }).click();
    await expect(window.locator('.logs-pane')).toContainText('second-tree');
    await expect(window.locator('.logs-pane')).not.toContainText('first-tree');
    await expect(window.locator('.logs-modal')).toHaveCount(0);
    await window.getByRole('tab', { name: 'Task runs', exact: true }).click();
    await expect(window.locator('.logs-taskruns')).toContainText('second-tree');
    await expect(window.locator('.logs-taskruns')).not.toContainText('first-tree');
    expect(await calls(app, 'logsReadSession')).toHaveLength(1);
    expect(
      await window.evaluate(
        (path) =>
          window.condash.logsReadSession(path).then(
            () => 'allowed',
            () => 'rejected',
          ),
        firstLog,
      ),
    ).toBe('rejected');
    const link = join(second, '.condash', 'logs', 'linked.txt');
    await symlink(firstLog, link);
    expect(
      await window.evaluate(
        (path) =>
          window.condash.logsReadSession(path).then(
            () => 'allowed',
            () => 'rejected',
          ),
        link,
      ),
    ).toBe('rejected');
    await window.keyboard.press('Escape');
    await probeIpc(app, ['search'], ['search']);
    await sendMenu(app, 'search');
    await window.locator('.search-modal-input').fill('searchable');
    await window.getByRole('radio', { name: 'Logs' }).click();
    await expect
      .poll(async () =>
        app.evaluate(() =>
          Boolean((globalThis as unknown as { overlayProbe: Probe }).overlayProbe.release.search),
        ),
      )
      .toBe(true);
    await switchConception(app, booted.conceptionDir);
    await expect(window.locator('.status-bar-path')).toHaveText(booted.conceptionDir);
    await release(app, 'search');
    await expect(window.locator('.search-modal, .surface-overlay, .logs-modal')).toHaveCount(0);
  } finally {
    await booted.cleanup();
    await rm(second, { recursive: true, force: true });
  }
});

test('Diagnostics is on-demand and retains Terminal identity, layout and recorder state', async () => {
  const booted = await bootApp({ globalConfig: { layout: { terminal: true } } });
  const { window, app } = booted;
  try {
    await probeIpc(app, ['perfVitals']);
    const session = await window.evaluate(
      (cwd) =>
        window.condash.termSpawn({
          side: 'my',
          cwd,
          command: 'printf "diagnostic identity\\n"; sleep 60',
        }),
      booted.conceptionDir,
    );
    await expect(window.locator(`.terminal-tab[data-sid="${session.id}"]`)).toBeVisible();
    await window.clock.install();
    await window.clock.runFor(3000);
    expect(await calls(app, 'perfVitals')).toHaveLength(0);
    const layout = await window.evaluate(() => window.condash.getLayout());
    const sessions = await window.evaluate(() => window.condash.termList());
    const button = window.getByRole('button', { name: 'Diagnostics', exact: true });
    await button.click();
    await expect(window.locator('.perf-vital')).toHaveCount(4);
    await expect(window.locator('.perf-tab-name > span').first()).toHaveText(booted.conceptionDir);
    expect(
      (await window.locator('.perf-tab-name > span').first().boundingBox())!.width,
    ).toBeGreaterThan(100);
    await expect(window.locator('.terminal-pane .perf-view')).toHaveCount(0);
    await window.locator('.perf-toggle').click();
    await expect(window.locator('.perf-toggle')).toContainText('Recording');
    await window.clock.runFor(3000);
    await expect
      .poll(async () => (await calls(app, 'perfVitals')).length)
      .toBeGreaterThanOrEqual(2);
    await window.locator('.surface-back').click();
    const closedCalls = (await calls(app, 'perfVitals')).length;
    await window.clock.runFor(6000);
    expect(await calls(app, 'perfVitals')).toHaveLength(closedCalls);
    expect(await window.evaluate(() => window.condash.getLayout())).toEqual(layout);
    expect((await window.evaluate(() => window.condash.termList())).map((s) => s.id)).toEqual(
      sessions.map((s) => s.id),
    );
    await expect(window.locator(`.terminal-tab[data-sid="${session.id}"]`)).toBeVisible();
    await button.click();
    await expect(window.locator('.perf-toggle')).toContainText('Recording');
    await sendMenu(app, 'open-settings');
    await window
      .locator('summary.settings-subgroup-summary', { hasText: 'Performance recording' })
      .click();
    const recording = window.getByLabel('Record main-process performance counters');
    await expect(recording).toBeChecked();
    await recording.uncheck();
    await window.keyboard.press('Escape');
    await button.click();
    await expect(window.locator('.perf-toggle')).toHaveText('Record');
    await window.locator('.perf-toggle').click();
    await window.locator('.perf-toggle').click();
    await expect(window.locator('.perf-toggle')).toHaveText('Record');
    await window.locator('.surface-back').click();
    await window.evaluate((id) => window.condash.termClose(id), session.id);
  } finally {
    await booted.cleanup();
  }
});

test('Automations closes roster polling and running tails without stopping a real scheduled run', async () => {
  test.setTimeout(60_000);
  const booted = await bootApp({
    prepare: async (root) => {
      await seedTask(root);
      await writeFile(
        join(root, 'fixture-agent.sh'),
        '#!/bin/sh\nprintf "local scheduled fixture\\n"\nsleep 55\n',
      );
    },
    extraConfig: { taskConfig: { fixture: { schedule: '1h', timeout: '1m', runMode: 'oneshot' } } },
  });
  const { window, app } = booted;
  try {
    // Set a harmless local command before the scheduler's first 20s tick.
    const original = await window.evaluate(() => window.condash.getGlobalSettingsRaw());
    const settings = JSON.parse(original);
    settings.agents = [
      {
        id: 'fixture',
        label: 'Fixture',
        command: `/bin/sh '${join(booted.conceptionDir, 'fixture-agent.sh')}'`,
        promptFlags: true,
      },
    ];
    settings.terminal = {
      ...settings.terminal,
      memory: { enabled: false, appScope: { enabled: false } },
    };
    await window.evaluate(
      ({ original, raw }) => window.condash.writeGlobalSettings(original, raw),
      { original, raw: JSON.stringify(settings) },
    );
    await sendMenu(app, 'refresh');
    await probeIpc(app, ['listRunningTaskRuns', 'logsReadSession', 'termSpawn']);
    await window.getByRole('button', { name: 'Automations', exact: true }).click();
    await expect.poll(async () => (await calls(app, 'listRunningTaskRuns')).length).toBe(1);
    await expect(window.locator('.tasks-run-row')).toHaveCount(1, { timeout: 30_000 });
    await window.locator('.tasks-run-head').click();
    await expect(window.locator('.tasks-run-log')).toContainText('local scheduled fixture', {
      timeout: 12_000,
    });
    await window.locator('.surface-back').click();
    await window.clock.install();
    const rosterCalls = (await calls(app, 'listRunningTaskRuns')).length;
    const tailCalls = (await calls(app, 'logsReadSession')).length;
    await window.clock.runFor(31_000);
    expect(await calls(app, 'listRunningTaskRuns')).toHaveLength(rosterCalls);
    expect(await calls(app, 'logsReadSession')).toHaveLength(tailCalls);
    await window.getByRole('button', { name: 'Automations', exact: true }).click();
    await expect(window.locator('.tasks-run-row')).toHaveCount(1);
    expect(await calls(app, 'listRunningTaskRuns')).toHaveLength(rosterCalls + 1);
    await window.locator('.tasks-run-kill').click();
    await expect(window.locator('.tasks-run-row')).toHaveCount(0);
    await window.locator('.tasks-row .tasks-run').click();
    await window.locator('.tasks-fill-scroll input').fill('typed local run');
    await window.locator('.tasks-fill-run').click();
    await expect(window.locator('.tasks-fill-modal')).toHaveCount(0);
    await expect.poll(async () => (await calls(app, 'termSpawn')).length).toBe(1);
    expect((await calls(app, 'termSpawn'))[0][0]).toMatchObject({
      command: expect.stringContaining('Review typed local run'),
    });
    await window.locator('.surface-back').click();
    const manual = await window.evaluate(() => window.condash.termList());
    expect(manual).toHaveLength(1);
    await expect(window.locator(`.terminal-tab[data-sid="${manual[0].id}"]`)).toBeVisible();
    await expect
      .poll(async () =>
        window.evaluate(
          (id) => window.condash.termAttach(id).then((session) => session?.output),
          manual[0].id,
        ),
      )
      .toContain('local scheduled fixture');
    await window.evaluate((id) => window.condash.termClose(id), manual[0].id);
  } finally {
    await booted.cleanup();
  }
});

for (const working of ['automations', 'logs']) {
  test(`legacy ${working} selection boots as Code without changing task files`, async () => {
    const booted = await bootApp({
      prepare: seedTask,
      globalConfig: { layout: { projects: true, working, terminal: false, projectsSplit: 0.43 } },
    });
    try {
      const before = await readFile(
        join(booted.conceptionDir, 'tasks', 'fixture', 'prompt.md'),
        'utf8',
      );
      expect(await booted.window.evaluate(() => window.condash.getLayout())).toEqual({
        projects: true,
        working: 'code',
        terminal: false,
        projectsSplit: 0.43,
      });
      await booted.window.getByRole('button', { name: 'Automations', exact: true }).click();
      await expect(booted.window.locator('.tasks-row')).toHaveCount(1);
      expect(
        await readFile(join(booted.conceptionDir, 'tasks', 'fixture', 'prompt.md'), 'utf8'),
      ).toBe(before);
    } finally {
      await booted.cleanup();
    }
  });
}
