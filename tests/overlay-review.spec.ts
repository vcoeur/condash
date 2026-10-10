import { expect, test, type ElectronApplication } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootApp, sendMenu } from './fixtures/electron-app';

type ReviewProbe = {
  calls: Record<string, number>;
  release?: () => void;
  releaseConfig?: () => void;
  configCompleted?: boolean;
};

async function holdResult(app: ElectronApplication, held: string, counted: string[]) {
  await app.evaluate(
    ({ ipcMain }, { held, counted }) => {
      const probe: ReviewProbe = { calls: {} };
      (globalThis as unknown as { reviewProbe: ReviewProbe }).reviewProbe = probe;
      const handlers = (
        ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
      )._invokeHandlers;
      for (const channel of [held, ...counted]) {
        const original = handlers.get(channel)!;
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (event, ...args) => {
          probe.calls[channel] = (probe.calls[channel] ?? 0) + 1;
          const result = await original(event, ...args);
          if (channel === held) {
            await new Promise<void>((resolve) => {
              probe.release = resolve;
            });
          }
          return result;
        });
      }
    },
    { held, counted },
  );
}

async function releaseResult(app: ElectronApplication) {
  await app.evaluate(() => {
    (globalThis as unknown as { reviewProbe: ReviewProbe }).reviewProbe.release?.();
  });
}

async function holdTaskConfigRead(
  app: ElectronApplication,
  path: string,
  stage: 'before-read' | 'after-read',
) {
  await app.evaluate(
    ({ ipcMain }, { path, stage }) => {
      const fs = process.getBuiltinModule('fs').promises;
      const handlers = (
        ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
      )._invokeHandlers;
      const original = handlers.get('setTaskConfig')!;
      handlers.set('setTaskConfig', async (...args) => {
        const probe = (globalThis as unknown as { reviewProbe: ReviewProbe }).reviewProbe;
        const read = fs.readFile;
        fs.readFile = (async (...readArgs: any[]) => {
          if (String(readArgs[0]) !== path) return (read as any).apply(fs, readArgs);
          // Restore before parking so independent config reads do not share the hold.
          fs.readFile = read;
          if (stage === 'before-read') {
            await new Promise<void>((resolve) => {
              probe.releaseConfig = resolve;
            });
          }
          const value = await (read as any).apply(fs, readArgs);
          if (stage === 'after-read') {
            await new Promise<void>((resolve) => {
              probe.releaseConfig = resolve;
            });
          }
          return value;
        }) as typeof fs.readFile;
        try {
          const result = await original(...args);
          probe.configCompleted = true;
          return result;
        } finally {
          fs.readFile = read;
        }
      });
    },
    { path, stage },
  );
}

async function releaseTaskConfigRead(app: ElectronApplication) {
  await app.evaluate(() => {
    (globalThis as unknown as { reviewProbe?: ReviewProbe }).reviewProbe?.releaseConfig?.();
  });
}

async function failAfterMainSwitch(app: ElectronApplication, channel: string) {
  await app.evaluate(({ ipcMain }, channel) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers;
    const original = handlers.get(channel)!;
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      await original(event, ...args);
      throw new Error('injected response failure after main switch');
    });
  }, channel);
}

async function failTaskConfigOnce(app: ElectronApplication, destination: string) {
  await app.evaluate(({ ipcMain }, destination) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers;
    const original = handlers.get('setTaskConfig')!;
    let failed = false;
    ipcMain.removeHandler('setTaskConfig');
    ipcMain.handle('setTaskConfig', async (event, slug, ...args) => {
      if (!failed && slug === destination) {
        failed = true;
        throw new Error('injected destination config failure');
      }
      return original(event, slug, ...args);
    });
  }, destination);
}

async function seedLog(root: string, archived = false) {
  const now = new Date();
  const day = archived
    ? ['2024', '01', '02']
    : [
        String(now.getFullYear()),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
      ];
  const dir = join(root, '.condash', 'logs', ...day);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, '091203-t-review.txt'),
    '# condash: ' +
      JSON.stringify({ sid: 't-review', cmd: 'review', started: now.toISOString() }) +
      '\nreview transcript\n',
  );
}

async function seedTask(root: string, name: string) {
  const dir = join(root, 'tasks', 'fixture');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'task.json'), JSON.stringify({ name, agent: 'fixture' }));
  await writeFile(join(dir, 'prompt.md'), 'Review {TOPIC:docs}');
}

test('review: keyboard-only Logs can reach an archive when no recent sessions exist', async () => {
  const booted = await bootApp({
    globalConfig: { terminal: { logging: { retentionDays: 0 } } },
    prepare: (root) => seedLog(root, true),
  });
  try {
    const page = booted.window;
    await page.getByRole('button', { name: 'Logs', exact: true }).click();
    await expect(page.locator('.logs-month-header')).toHaveCount(1);
    await expect(page.locator('.logs-session-card')).toHaveCount(0);
    await expect(page.locator('.surface-back')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('.logs-month-header')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.logs-session-card')).toHaveCount(1);
    const visited: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      await page.keyboard.press('Tab');
      visited.push(await page.evaluate(() => document.activeElement?.className.toString() ?? ''));
    }
    expect(visited.some((className) => className.includes('logs-month-header'))).toBe(true);
  } finally {
    await booted.cleanup();
  }
});

test('review: a completed delete must not refetch Logs after its overlay is disposed', async () => {
  const second = await mkdtemp(join(tmpdir(), 'condash-review-logs-next-'));
  await mkdir(join(second, '.condash'), { recursive: true });
  await writeFile(join(second, '.condash', 'settings.json'), '{}');
  const booted = await bootApp({ prepare: (root) => seedLog(root) });
  try {
    const { window: page, app } = booted;
    await page.getByRole('button', { name: 'Logs', exact: true }).click();
    await page.locator('.logs-session-card').click();
    await expect(page.locator('.logs-line')).toContainText(['review transcript']);
    await holdResult(app, 'logsDeleteSession', [
      'logsListDays',
      'logsListSessions',
      'logsListTaskRuns',
    ]);
    await page.getByRole('button', { name: 'Delete this session', exact: true }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(() =>
          Boolean((globalThis as unknown as { reviewProbe: ReviewProbe }).reviewProbe.release),
        ),
      )
      .toBe(true);
    await app.evaluate(({ BrowserWindow }, path) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('menu-open-recent', path);
    }, second);
    await expect(page.locator('.surface-overlay')).toHaveCount(0);
    await releaseResult(app);
    // A real main round-trip is a barrier behind delivery of the held result.
    await page.evaluate(() => window.condash.getConceptionPath());
    const counts = await app.evaluate(
      () => (globalThis as unknown as { reviewProbe: ReviewProbe }).reviewProbe.calls,
    );
    expect(counts).toEqual({ logsDeleteSession: 1 });
  } finally {
    await releaseResult(booted.app);
    await booted.cleanup();
    await rm(second, { recursive: true, force: true });
  }
});

test('review: an in-flight conception switch cannot open an editor against the hidden next tree', async () => {
  const second = await mkdtemp(join(tmpdir(), 'condash-review-next-'));
  await mkdir(join(second, '.condash'), { recursive: true });
  await writeFile(join(second, '.condash', 'settings.json'), '{}');
  await seedTask(second, 'Hidden second-tree task');
  const booted = await bootApp({
    prepare: (root) => seedTask(root, 'Visible first-tree task'),
    globalConfig: {
      agents: [{ id: 'fixture', label: 'Fixture', command: '/bin/echo', promptFlags: true }],
    },
  });
  try {
    const { window: page, app } = booted;
    await holdResult(app, 'openConception', []);
    await app.evaluate(({ BrowserWindow }, path) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('menu-open-recent', path);
    }, second);
    await expect
      .poll(() =>
        app.evaluate(() =>
          Boolean((globalThis as unknown as { reviewProbe: ReviewProbe }).reviewProbe.release),
        ),
      )
      .toBe(true);
    await expect(page.locator('.status-bar-path')).toHaveText(booted.conceptionDir);
    expect(await page.evaluate(() => window.condash.getConceptionPath())).toBe(second);
    await app.evaluate(({ BrowserWindow }, path) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('menu-open-recent', path);
    }, booted.conceptionDir);
    await page
      .getByRole('button', { name: 'Automations', exact: true })
      .evaluate((button: HTMLButtonElement) => button.click());
    const openedDuringSwitch = (await page.locator('.surface-overlay').count()) > 0;
    if (openedDuringSwitch) {
      await page.locator('.tasks-row').click();
      const name = page.locator('.tasks-editor input').first();
      await expect(name).toBeVisible();
      await name.fill('Edited under the wrong conception header');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.locator('.tasks-editor-modal')).toHaveCount(0);
      await expect(page.locator('.status-bar-path')).toHaveText(booted.conceptionDir);
      const firstDefinition = JSON.parse(
        await readFile(join(booted.conceptionDir, 'tasks', 'fixture', 'task.json'), 'utf8'),
      );
      const secondDefinition = JSON.parse(
        await readFile(join(second, 'tasks', 'fixture', 'task.json'), 'utf8'),
      );
    }
    const switchCalls = await app.evaluate(
      () => (globalThis as unknown as { reviewProbe: ReviewProbe }).reviewProbe.calls,
    );
    expect(switchCalls.openConception).toBe(1);
    await releaseResult(app);
    await expect(page.locator('.status-bar-path')).toHaveText(second);
    expect(openedDuringSwitch).toBe(false);
  } finally {
    await releaseResult(booted.app);
    await booted.cleanup();
    await rm(second, { recursive: true, force: true });
  }
});

test('review: picker transition owns the root until renderer commit and rejects overlap', async () => {
  const second = await mkdtemp(join(tmpdir(), 'condash-review-picker-'));
  await mkdir(join(second, '.condash'), { recursive: true });
  await writeFile(join(second, '.condash', 'settings.json'), '{}');
  const booted = await bootApp();
  try {
    const { window: page, app } = booted;
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, second);
    await holdResult(app, 'pickConceptionPath', ['openConception']);
    await sendMenu(app, 'open-folder');
    await expect
      .poll(() =>
        app.evaluate(() =>
          Boolean((globalThis as unknown as { reviewProbe: ReviewProbe }).reviewProbe.release),
        ),
      )
      .toBe(true);
    await expect(page.locator('.status-bar-path')).toHaveText(booted.conceptionDir);
    expect(await page.evaluate(() => window.condash.getConceptionPath())).toBe(second);
    await sendMenu(app, 'open-folder');
    await page
      .getByRole('button', { name: 'Automations', exact: true })
      .evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.locator('.surface-overlay')).toHaveCount(0);
    const calls = await app.evaluate(
      () => (globalThis as unknown as { reviewProbe: ReviewProbe }).reviewProbe.calls,
    );
    expect(calls.pickConceptionPath).toBe(1);
    expect(calls.openConception ?? 0).toBe(0);
    await releaseResult(app);
    await expect(page.locator('.status-bar-path')).toHaveText(second);
  } finally {
    await releaseResult(booted.app);
    await booted.cleanup();
    await rm(second, { recursive: true, force: true });
  }
});

for (const entry of ['menu', 'picker'] as const) {
  for (const outcome of ['success', 'failure'] as const) {
    test(`review: ${entry} conception ${outcome} restores the overlay launcher after transition`, async () => {
      const second = await mkdtemp(join(tmpdir(), 'condash-review-focus-next-'));
      await mkdir(join(second, '.condash'), { recursive: true });
      await writeFile(join(second, '.condash', 'settings.json'), '{}');
      const booted = await bootApp();
      try {
        const { window: page, app } = booted;
        const launcher = page.getByRole('button', { name: 'Logs', exact: true });
        await launcher.click();
        await expect(page.locator('.surface-overlay')).toBeVisible();
        if (entry === 'picker') {
          await app.evaluate(({ dialog }, path) => {
            dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
          }, second);
        }
        if (outcome === 'failure') {
          await failAfterMainSwitch(
            app,
            entry === 'menu' ? 'openConception' : 'pickConceptionPath',
          );
        }
        if (entry === 'menu') {
          await app.evaluate(({ BrowserWindow }, path) => {
            BrowserWindow.getAllWindows()[0]?.webContents.send('menu-open-recent', path);
          }, second);
        } else {
          await sendMenu(app, 'open-folder');
        }
        await expect(page.locator('.surface-overlay')).toHaveCount(0);
        await expect(page.locator('.status-bar-path')).toHaveText(second);
        await expect(launcher).not.toBeDisabled();
        await expect(launcher).toBeFocused();
      } finally {
        await booted.cleanup();
        await rm(second, { recursive: true, force: true });
      }
    });
  }
}

test('review: closing during Save must not commit a task without its schedule', async () => {
  const booted = await bootApp({
    prepare: (root) => seedTask(root, 'Scheduled fixture'),
    globalConfig: {
      agents: [{ id: 'fixture', label: 'Fixture', command: '/bin/echo', promptFlags: true }],
    },
  });
  try {
    const { window: page, app } = booted;
    await page.getByRole('button', { name: 'Automations', exact: true }).click();
    await page.locator('.tasks-row').click();
    await page.locator('.tasks-editor input').first().fill('Name committed before disposal');
    await page.getByLabel('Schedule (e.g. 5m / 2h / 1d — blank = off)').fill('1h');
    await holdResult(app, 'writeTask', ['setTaskConfig']);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(() =>
          Boolean((globalThis as unknown as { reviewProbe: ReviewProbe }).reviewProbe.release),
        ),
      )
      .toBe(true);
    await page
      .getByRole('button', { name: 'Cancel', exact: true })
      .evaluate((button: HTMLButtonElement) => button.click());
    await page.keyboard.press('Escape');
    await expect(page.locator('.tasks-editor')).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
    await releaseResult(app);
    await expect(page.locator('.tasks-editor-modal')).toHaveCount(0);
    const definition = JSON.parse(
      await readFile(join(booted.conceptionDir, 'tasks', 'fixture', 'task.json'), 'utf8'),
    );
    expect(definition.name).toBe('Name committed before disposal');
    await expect
      .poll(
        async () =>
          JSON.parse(
            await readFile(join(booted.conceptionDir, '.condash', 'settings.json'), 'utf8'),
          ).taskConfig?.fixture?.schedule,
      )
      .toBe('1h');
    await expect
      .poll(
        async () => (await page.evaluate(() => window.condash.getTaskConfig())).fixture?.schedule,
      )
      .toBe('1h');
  } finally {
    await releaseResult(booted.app);
    await booted.cleanup();
  }
});

test('review: a rename completes destination config before clearing the source config', async () => {
  const booted = await bootApp({
    prepare: async (root) => {
      await seedTask(root, 'Scheduled fixture');
      await writeFile(
        join(root, '.condash', 'settings.json'),
        JSON.stringify({ taskConfig: { fixture: { schedule: '2h' } } }),
      );
    },
    globalConfig: {
      agents: [{ id: 'fixture', label: 'Fixture', command: '/bin/echo', promptFlags: true }],
    },
  });
  try {
    const { window: page, app } = booted;
    await page.getByRole('button', { name: 'Automations', exact: true }).click();
    await page.locator('.tasks-row').click();
    await page.locator('.tasks-editor input').nth(1).fill('renamed-task');
    await page.getByLabel('Schedule (e.g. 5m / 2h / 1d — blank = off)').fill('3h');
    await holdResult(app, 'writeTask', ['setTaskConfig']);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(() =>
          Boolean((globalThis as unknown as { reviewProbe: ReviewProbe }).reviewProbe.release),
        ),
      )
      .toBe(true);
    const overlay = page.locator('.surface-overlay');
    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(1);
    await releaseResult(app);
    await expect
      .poll(async () => (await page.evaluate(() => window.condash.getTaskConfig())).fixture)
      .toBeUndefined();
    const config = await page.evaluate(() => window.condash.getTaskConfig());
    expect(config['renamed-task']?.schedule).toBe('3h');
    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);
  } finally {
    await releaseResult(booted.app);
    await booted.cleanup();
  }
});

test('review: a failed destination config write leaves a rename retryable', async () => {
  const booted = await bootApp({
    prepare: async (root) => {
      await seedTask(root, 'Scheduled fixture');
      await writeFile(
        join(root, '.condash', 'settings.json'),
        JSON.stringify({ taskConfig: { fixture: { schedule: '2h' } } }),
      );
    },
    globalConfig: {
      agents: [{ id: 'fixture', label: 'Fixture', command: '/bin/echo', promptFlags: true }],
    },
  });
  try {
    const { window: page, app } = booted;
    await page.getByRole('button', { name: 'Automations', exact: true }).click();
    await page.locator('.tasks-row').click();
    await page.locator('.tasks-editor input').nth(1).fill('renamed-task');
    await page.getByLabel('Schedule (e.g. 5m / 2h / 1d — blank = off)').fill('3h');
    await failTaskConfigOnce(app, 'renamed-task');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.tasks-editor-modal')).toBeVisible();
    await expect(page.locator('.tasks-editor-modal')).toHaveAttribute(
      'aria-label',
      'Edit renamed-task',
    );
    await expect(
      page.locator('.tasks-editor-actions button', { hasText: 'Cancel' }),
    ).toBeDisabled();
    const renamedDefinition = JSON.parse(
      await readFile(join(booted.conceptionDir, 'tasks', 'renamed-task', 'task.json'), 'utf8'),
    );
    expect(renamedDefinition.name).toBe('Scheduled fixture');
    await expect(page.locator('.tasks-editor-actions button', { hasText: 'Save' })).toBeEnabled();
    const configBeforeRetry = await page.evaluate(() => window.condash.getTaskConfig());
    expect(configBeforeRetry.fixture?.schedule).toBe('2h');
    expect(configBeforeRetry['renamed-task']).toBeUndefined();
    await page.locator('.tasks-editor-actions button', { hasText: 'Save' }).click();
    await expect(page.locator('.tasks-editor-modal')).toHaveCount(0);
    await expect
      .poll(async () => (await page.evaluate(() => window.condash.getTaskConfig())).fixture)
      .toBeUndefined();
    const config = await page.evaluate(() => window.condash.getTaskConfig());
    expect(config['renamed-task']?.schedule).toBe('3h');
  } finally {
    await booted.cleanup();
  }
});

test('review: a committed task delete also clears its task configuration', async () => {
  const booted = await bootApp({
    prepare: async (root) => {
      await seedTask(root, 'Scheduled fixture');
      await writeFile(
        join(root, '.condash', 'settings.json'),
        JSON.stringify({ taskConfig: { fixture: { schedule: '2h' } } }),
      );
    },
    globalConfig: {
      agents: [{ id: 'fixture', label: 'Fixture', command: '/bin/echo', promptFlags: true }],
    },
  });
  try {
    const { window: page, app } = booted;
    await page.getByRole('button', { name: 'Automations', exact: true }).click();
    await page.locator('.tasks-row').click();
    await holdResult(app, 'deleteTask', ['setTaskConfig']);
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.locator('.confirm-modal').getByRole('button', { name: 'Delete' }).click();
    await expect
      .poll(() =>
        app.evaluate(() =>
          Boolean((globalThis as unknown as { reviewProbe: ReviewProbe }).reviewProbe.release),
        ),
      )
      .toBe(true);
    const overlay = page.locator('.surface-overlay');
    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(1);
    await expect(page.locator('.tasks-editor')).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
    await releaseResult(app);
    await expect(page.locator('.tasks-editor-modal')).toHaveCount(0);
    await expect
      .poll(
        async () =>
          JSON.parse(
            await readFile(join(booted.conceptionDir, '.condash', 'settings.json'), 'utf8'),
          ).taskConfig?.fixture,
      )
      .toBeUndefined();
    await expect
      .poll(async () => (await page.evaluate(() => window.condash.getTaskConfig())).fixture)
      .toBeUndefined();
    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);
  } finally {
    await releaseResult(booted.app);
    await booted.cleanup();
  }
});

for (const action of ['Save', 'Delete'] as const) {
  for (const stage of ['before-read', 'after-read'] as const) {
    for (const departure of ['overlay', 'root'] as const) {
      test(`review: held ${action} config ${stage} keeps mutation ownership through ${departure} departure`, async ({}, testInfo) => {
        const second = await mkdtemp(join(tmpdir(), 'condash-mutation-next-'));
        await mkdir(join(second, '.condash'), { recursive: true });
        await writeFile(
          join(second, '.condash', 'settings.json'),
          JSON.stringify({ taskConfig: { fixture: { schedule: '5h' } } }),
        );
        await seedTask(second, 'Second root fixture');
        const booted = await bootApp({
          prepare: async (root) => {
            await seedTask(root, 'Scheduled fixture');
            await mkdir(join(root, 'tasks', 'outside'), { recursive: true });
            await writeFile(
              join(root, 'tasks', 'outside', 'task.json'),
              JSON.stringify({ name: 'Outside initial', agent: 'fixture' }),
            );
            await writeFile(join(root, 'tasks', 'outside', 'prompt.md'), 'Outside prompt');
            await writeFile(
              join(root, '.condash', 'settings.json'),
              JSON.stringify({ taskConfig: { fixture: { schedule: '2h' } } }),
            );
          },
          globalConfig: {
            dashboard: { enabled: false },
            autoSync: { enabled: false },
            terminal: { memory: { enabled: false, appScope: { enabled: false } } },
            agents: [{ id: 'fixture', label: 'Fixture', command: '/bin/echo', promptFlags: true }],
          },
        });
        const { app, window: page, conceptionDir } = booted;
        const configPath = join(conceptionDir, '.condash', 'settings.json');
        const persistedConfig = async () => JSON.parse(await readFile(configPath, 'utf8'));
        try {
          await page.getByRole('button', { name: 'Automations', exact: true }).click();
          await page.locator('.tasks-row', { hasText: 'Scheduled fixture' }).click();
          if (action === 'Save') {
            await page.locator('.tasks-editor input').first().fill('Saved fixture');
            await page.getByLabel('Schedule (e.g. 5m / 2h / 1d — blank = off)').fill('1h');
          }
          await page.evaluate(() => {
            const state = window as typeof window & { mutationTaskEvents: number };
            state.mutationTaskEvents = 0;
            window.condash.onTreeEvents((events) => {
              if (events.some((event) => event.kind === 'tasks')) state.mutationTaskEvents++;
            });
          });
          await holdResult(app, action === 'Save' ? 'writeTask' : 'deleteTask', [
            'setTaskConfig',
            'openConception',
          ]);
          await holdTaskConfigRead(app, configPath, stage);
          await page.getByRole('button', { name: action, exact: true }).click();
          if (action === 'Delete')
            await page
              .locator('.confirm-modal')
              .getByRole('button', { name: 'Delete', exact: true })
              .click();
          await expect
            .poll(() =>
              app.evaluate(() =>
                Boolean(
                  (globalThis as unknown as { reviewProbe: ReviewProbe }).reviewProbe.release,
                ),
              ),
            )
            .toBe(true);
          await expect
            .poll(() =>
              page.evaluate(
                () => (window as typeof window & { mutationTaskEvents: number }).mutationTaskEvents,
              ),
            )
            .toBeGreaterThan(0);
          if (action === 'Delete')
            await expect(page.locator('.tasks-row', { hasText: 'Scheduled fixture' })).toHaveCount(
              0,
            );
          else
            await expect(page.locator('.tasks-row', { hasText: 'Saved fixture' })).toHaveCount(1);
          const editor = page.locator('.tasks-editor-modal');
          const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
          await expect(editor).toBeVisible();
          await expect(page.locator('.tasks-editor')).toHaveAttribute('aria-busy', 'true');
          await expect(cancel).toBeDisabled();
          await cancel.evaluate((button: HTMLButtonElement) => button.click());
          await page.keyboard.press('Escape');
          await expect(editor).toBeVisible();
          await expect(page.locator('.surface-overlay')).toHaveCount(1);
          await releaseResult(app);
          await expect
            .poll(() =>
              app.evaluate(() =>
                Boolean(
                  (globalThis as unknown as { reviewProbe: ReviewProbe }).reviewProbe.releaseConfig,
                ),
              ),
            )
            .toBe(true);
          expect((await persistedConfig()).taskConfig.fixture.schedule).toBe('2h');
          expect(
            (await page.evaluate(() => window.condash.getTaskConfig())).fixture?.schedule,
          ).toBe('2h');
          await expect(editor).toBeVisible();
          await expect(cancel).toBeDisabled();
          const eventsBefore = await page.evaluate(
            () => (window as typeof window & { mutationTaskEvents: number }).mutationTaskEvents,
          );
          await writeFile(
            join(conceptionDir, 'tasks', 'outside', 'task.json'),
            JSON.stringify({ name: 'Outside live update', agent: 'fixture' }),
          );
          await expect
            .poll(() =>
              page.evaluate(
                () => (window as typeof window & { mutationTaskEvents: number }).mutationTaskEvents,
              ),
            )
            .toBeGreaterThan(eventsBefore);
          await expect(page.locator('.tasks-row', { hasText: 'Outside live update' })).toHaveCount(
            1,
          );
          await expect(editor).toBeVisible();
          await cancel.evaluate((button: HTMLButtonElement) => button.click());
          await page.keyboard.press('Escape');
          await expect(editor).toBeVisible();
          if (departure === 'root') {
            await app.evaluate(({ BrowserWindow }, path) => {
              BrowserWindow.getAllWindows()[0].webContents.send('menu-open-recent', path);
            }, second);
            await expect(
              page.getByRole('button', { name: 'Automations', exact: true }),
            ).toBeDisabled();
          } else {
            await page
              .locator('.surface-back')
              .evaluate((button: HTMLButtonElement) => button.click());
          }
          await expect(page.locator('.status-bar-path')).toHaveText(conceptionDir);
          await expect(editor).toBeVisible();
          const before = await app.evaluate(() => {
            const probe = (globalThis as unknown as { reviewProbe: ReviewProbe }).reviewProbe;
            return { calls: probe.calls, configCompleted: probe.configCompleted === true };
          });
          expect(before.configCompleted).toBe(false);
          expect(before.calls.openConception ?? 0).toBe(0);
          expect(before.calls.setTaskConfig).toBe(1);
          await page.screenshot({ path: testInfo.outputPath('held-task-config.png') });
          await releaseTaskConfigRead(app);
          await expect(editor).toHaveCount(0);
          await expect(page.locator('.surface-overlay')).toHaveCount(0);
          const after = await app.evaluate(() => {
            const probe = (globalThis as unknown as { reviewProbe: ReviewProbe }).reviewProbe;
            return { calls: probe.calls, configCompleted: probe.configCompleted === true };
          });
          expect(after.configCompleted).toBe(true);
          expect(after.calls.setTaskConfig).toBe(1);
          await expect
            .poll(async () => (await persistedConfig()).taskConfig?.fixture?.schedule)
            .toBe(action === 'Save' ? '1h' : undefined);
          if (departure === 'root')
            await expect(page.locator('.status-bar-path')).toHaveText(second);
          else await expect(page.locator('.status-bar-path')).toHaveText(conceptionDir);
          const nextConfig = JSON.parse(
            await readFile(join(second, '.condash', 'settings.json'), 'utf8'),
          );
          expect(nextConfig.taskConfig.fixture.schedule).toBe('5h');
          await writeFile(
            testInfo.outputPath('task-mutation-state.json'),
            JSON.stringify(
              {
                action,
                stage,
                departure,
                before,
                after,
                finalConfig: await persistedConfig(),
                nextConfig,
              },
              null,
              2,
            ),
          );
        } finally {
          await releaseResult(app).catch(() => undefined);
          await releaseTaskConfigRead(app).catch(() => undefined);
          await booted.cleanup();
          await rm(second, { recursive: true, force: true });
        }
      });
    }
  }
}
