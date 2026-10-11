import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, writeFile, unlink, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootApp, sendMenu } from './fixtures/electron-app';
import { holdFirstCalls } from './fixtures/ipc-hold';
import type { TreeEvent } from '../src/shared/types';

const localSettings = {
  dashboard: { enabled: false },
  autoSync: { enabled: false },
  terminal: { memory: { enabled: false, appScope: { enabled: false } } },
  agents: [{ id: 'local', label: 'Local fixture', command: '/bin/false', promptFlags: true }],
};
const noteText = (count = 120, hits = count) =>
  '# Reload probe\n\n' +
  Array.from(
    { length: count },
    (_, index) => `${index < hits ? 'needle' : 'plain'} paragraph ${index}.\n`,
  ).join('\n');
const projectDir = (root: string) => join(root, 'projects', '2026-04', '2026-04-26-sample');
const taskPath = (root: string) => join(root, 'tasks', 'probe', 'task.json');
let logPath = '';
async function seed(root: string): Promise<void> {
  await writeFile(join(root, 'knowledge', 'probe.md'), noteText());
  await mkdir(join(projectDir(root), 'notes'), { recursive: true });
  await writeFile(
    join(projectDir(root), 'notes', 'probe.md'),
    '# Project child probe\n\ninitial child\n',
  );
  await mkdir(join(root, 'tasks', 'probe'), { recursive: true });
  await writeFile(
    taskPath(root),
    JSON.stringify({ name: 'Initial automation', agent: 'local', submit: true }),
  );
  await writeFile(join(root, 'tasks', 'probe', 'prompt.md'), 'Work on {AREA:initial area}');
  await mkdir(join(root, '.agents', 'skills', 'probe'), { recursive: true });
  await writeFile(
    join(root, '.agents', 'skills', 'probe', 'SKILL.md'),
    '# Skill probe\n\ninitial skill\n',
  );
  const now = new Date();
  const day = [
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ];
  const dir = join(root, '.condash', 'logs', ...day);
  await mkdir(dir, { recursive: true });
  logPath = join(dir, '091203-t-live.txt');
  await writeFile(
    logPath,
    '# condash: ' +
      JSON.stringify({
        sid: 't-live',
        side: 'my',
        started: now.toISOString(),
        cmd: 'local fixture',
        kind: 'transcript',
      }) +
      '\n' +
      Array.from({ length: 200 }, (_, index) => `needle transcript ${index}`).join('\n') +
      '\n# condash: {"finished":"2026-10-08T12:00:00Z","exitCode":0}\n',
  );
}
async function boot() {
  return bootApp({ prepare: seed, globalConfig: localSettings });
}
async function batch(app: ElectronApplication, window: Page, events: TreeEvent[]): Promise<void> {
  const received = await window.evaluate(() => {
    const state = window as typeof window & { __liveBatches?: number };
    if (state.__liveBatches === undefined) {
      state.__liveBatches = 0;
      window.condash.onTreeEvents(() => {
        state.__liveBatches!++;
      });
    }
    return state.__liveBatches;
  });
  await app.evaluate(({ BrowserWindow }, events) => {
    BrowserWindow.getAllWindows()[0].webContents.send('tree-events', events);
  }, events);
  await expect
    .poll(() =>
      window.evaluate(() => (window as typeof window & { __liveBatches: number }).__liveBatches),
    )
    .toBeGreaterThan(received);
  await window.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
async function openNote(app: ElectronApplication, window: Page): Promise<void> {
  await sendMenu(app, 'show-knowledge');
  await window.locator('.knowledge-card', { hasText: 'Reload probe' }).click();
  await expect(window.locator('.note-modal .md-rendered')).toContainText('paragraph 119');
}
async function openSearch(app: ElectronApplication, window: Page, query = 'needle'): Promise<void> {
  await sendMenu(app, 'search');
  await window.locator('.search-modal-input').fill(query);
  await expect(window.locator('.search-row').first()).toBeVisible();
}
async function failNext(app: ElectronApplication, channel: string): Promise<void> {
  await app.evaluate(({ ipcMain }, channel) => {
    const handlers = (
      ipcMain as unknown as {
        _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
      }
    )._invokeHandlers;
    const original = handlers.get(channel)!;
    let failed = false;
    handlers.set(channel, async (...args) => {
      if (!failed) {
        failed = true;
        throw new Error('local injected failure');
      }
      return original(...args);
    });
  }, channel);
}

async function switchRoot(app: ElectronApplication, window: Page, root: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, root) => {
    BrowserWindow.getAllWindows()[0].webContents.send('menu-open-recent', root);
  }, root);
  await expect(window.locator('.status-bar-path')).toHaveText(root);
  expect(await window.evaluate(() => window.condash.getConceptionPath())).toBe(root);
}

async function secondRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'condash-live-second-'));
  await mkdir(join(root, '.condash'), { recursive: true });
  await mkdir(join(root, 'projects'), { recursive: true });
  await mkdir(join(root, 'knowledge'), { recursive: true });
  await writeFile(join(root, '.condash', 'settings.json'), '{}\n');
  await writeFile(join(root, 'knowledge', 'index.md'), '# Second root\n');
  return root;
}

for (const stage of ['pending', 'held'] as const) {
  for (const surface of ['note', 'tasks'] as const) {
    test(`Same-root config change retains ${stage} index-batch notifications for ${surface}`, async ({}, testInfo) => {
      const fixture = await boot();
      try {
        const { app, window, conceptionDir } = fixture;
        const notePath = join(projectDir(conceptionDir), 'notes', 'probe.md');
        await app.evaluate(
          (_electron, { notePath, taskPath, configPath, stage }) => {
            const fs = process.getBuiltinModule('fs').promises;
            const original = fs.readFile.bind(fs);
            const emitter = process.getBuiltinModule('events').EventEmitter;
            const originalEmit = emitter.prototype.emit;
            const state = {
              armed: false,
              reads: 0,
              intercepted: 0,
              configWritten: false,
              configDelivered: false,
              release: null as null | (() => void),
            };
            (globalThis as unknown as { __liveRearmGate: typeof state }).__liveRearmGate = state;
            emitter.prototype.emit = function (event: string | symbol, ...args: any[]) {
              const result = originalEmit.call(this, event, ...args);
              if (event === 'all' && String(args[1]) === configPath) state.configDelivered = true;
              return result;
            };
            fs.readFile = async (...args: any[]) => {
              if (String(args[0]) !== notePath) return original(...args);
              state.reads++;
              const result = await original(...args);
              if (!state.armed || state.intercepted > 0) return result;
              state.intercepted++;
              await fs.writeFile(
                taskPath,
                JSON.stringify({ name: 'Rearm automation', agent: 'local' }),
              );
              if (stage === 'pending') {
                await fs.writeFile(configPath, JSON.stringify({ retired_apps: [] }));
                state.configWritten = true;
              } else {
                await new Promise<void>((resolve) => {
                  state.release = resolve;
                });
              }
              return result;
            };
          },
          {
            notePath,
            taskPath: taskPath(conceptionDir),
            configPath: join(conceptionDir, '.condash', 'settings.json'),
            stage,
          },
        );
        // A zero-read query proves this fixture's initial index is built before arming the file hold.
        await expect
          .poll(async () => {
            const before = await app.evaluate(
              () =>
                (globalThis as unknown as { __liveRearmGate: { reads: number } }).__liveRearmGate
                  .reads,
            );
            const result = await window.evaluate(() =>
              window.condash.search('initial child', ['projects']),
            );
            const after = await app.evaluate(
              () =>
                (globalThis as unknown as { __liveRearmGate: { reads: number } }).__liveRearmGate
                  .reads,
            );
            return result.hits.length > 0 && before === after;
          })
          .toBe(true);
        if (surface === 'note') {
          await openSearch(app, window, 'initial child');
          await window.locator('.search-file-row').click();
          await expect(window.locator('.note-modal .md-rendered')).toContainText('initial child');
        } else {
          await window.getByRole('button', { name: 'Automations', exact: true }).click();
          await expect(window.locator('.tasks-row-name')).toHaveText('Initial automation');
        }
        await window.evaluate(() => {
          const state = window as typeof window & { __liveRearmEvents?: TreeEvent[][] };
          state.__liveRearmEvents = [];
          window.condash.onTreeEvents((events) => {
            state.__liveRearmEvents!.push(events);
          });
        });
        await app.evaluate(() => {
          const gate = (
            globalThis as unknown as {
              __liveRearmGate: { armed: boolean; configDelivered: boolean };
            }
          ).__liveRearmGate;
          gate.armed = true;
          gate.configDelivered = false;
        });
        await writeFile(notePath, '# Project child probe\n\nrearm disk replacement\n');
        await expect
          .poll(() =>
            app.evaluate(
              () =>
                (globalThis as unknown as { __liveRearmGate: { intercepted: number } })
                  .__liveRearmGate.intercepted,
            ),
          )
          .toBe(1);
        if (stage === 'held') {
          // Let the existing 250 ms debounce capture the batch while its file preparation is parked.
          await window.waitForTimeout(300);
          await writeFile(
            join(conceptionDir, '.condash', 'settings.json'),
            JSON.stringify({ retired_apps: [] }),
          );
        }
        if (stage === 'held') {
          // Observe real main-process config delivery while publication is held,
          // without an arbitrary stability-poll count or synthetic target event.
          await expect
            .poll(() =>
              app.evaluate(
                () =>
                  (globalThis as unknown as { __liveRearmGate: { configDelivered: boolean } })
                    .__liveRearmGate.configDelivered,
              ),
            )
            .toBe(true);
          await app.evaluate(() => {
            (
              globalThis as unknown as { __liveRearmGate: { release: null | (() => void) } }
            ).__liveRearmGate.release?.();
          });
        }
        await expect
          .poll(() =>
            window.evaluate((notePath) => {
              const events = (
                window as typeof window & { __liveRearmEvents: TreeEvent[][] }
              ).__liveRearmEvents.flat();
              return (
                events.some(
                  (event) => event.kind === 'project' && event.changedPath === notePath,
                ) &&
                events.some((event) => event.kind === 'tasks') &&
                events.some((event) => event.kind === 'config')
              );
            }, notePath),
          )
          .toBe(true);
        if (surface === 'note') {
          await expect(window.locator('.note-modal').getByText('Changed on disk')).toBeVisible();
          await expect(window.locator('.note-modal .md-rendered')).toContainText('initial child');
        } else {
          await expect(window.locator('.tasks-row-name')).toHaveText('Rearm automation');
        }
      } finally {
        await writeFile(
          testInfo.outputPath('same-root-rearm-state.json'),
          JSON.stringify(await windowState(fixture.window).catch(() => null)),
        );
        await testInfo.attach('same-root-rearm-state', {
          body: JSON.stringify(await windowState(fixture.window).catch(() => null)),
          contentType: 'application/json',
        });
        await fixture.app
          .evaluate(() => {
            (
              globalThis as unknown as { __liveRearmGate?: { release: null | (() => void) } }
            ).__liveRearmGate?.release?.();
          })
          .catch(() => undefined);
        await fixture.cleanup();
      }
    });
  }
}

async function windowState(window: Page) {
  return window.evaluate(() => ({
    events: (window as typeof window & { __liveRearmEvents?: TreeEvent[][] }).__liveRearmEvents,
    changedNotice: [...document.querySelectorAll('.note-modal [role="status"]')].map(
      (element) => element.textContent,
    ),
    taskNames: [...document.querySelectorAll('.tasks-row-name')].map(
      (element) => element.textContent,
    ),
  }));
}

for (const surface of ['note', 'tasks'] as const) {
  test(`Same-root config change preserves not-yet-delivered real ${surface} change`, async ({}, testInfo) => {
    const fixture = await boot();
    try {
      const { app, window, conceptionDir } = fixture;
      const notePath = join(projectDir(conceptionDir), 'notes', 'probe.md');
      const target = surface === 'note' ? notePath : taskPath(conceptionDir);
      if (surface === 'note') {
        await openSearch(app, window, 'initial child');
        await window.locator('.search-file-row').click();
        await expect(window.locator('.note-modal .md-rendered')).toContainText('initial child');
      } else {
        await window.getByRole('button', { name: 'Automations', exact: true }).click();
        await expect(window.locator('.tasks-row-name')).toHaveText('Initial automation');
        await window.locator('.tasks-row').click();
        await window.locator('.tasks-prompt-textarea').fill('gap draft remains intact');
      }
      await window.evaluate(() => {
        const state = window as typeof window & { __liveRearmEvents: TreeEvent[][] };
        state.__liveRearmEvents = [];
        window.condash.onTreeEvents((events) => state.__liveRearmEvents.push(events));
      });
      await app.evaluate((_electron, target) => {
        const fs = process.getBuiltinModule('fs');
        const original = fs.stat.bind(fs);
        const state = { intercepted: 0, release: null as null | (() => void) };
        (globalThis as unknown as { __liveUndeliveredGate: typeof state }).__liveUndeliveredGate =
          state;
        fs.stat = ((...args: any[]) => {
          if (String(args[0]) === target && state.intercepted === 0) {
            const callback = args[args.length - 1];
            args[args.length - 1] = (...values: any[]) => {
              if (state.intercepted > 0) {
                callback(...values);
                return;
              }
              state.intercepted++;
              state.release = () => callback(...values);
            };
          }
          return (original as any)(...args);
        }) as typeof fs.stat;
      }, target);
      await writeFile(
        target,
        surface === 'note'
          ? '# Project child probe\n\nundelivered disk replacement\n'
          : JSON.stringify({ name: 'Undelivered automation', agent: 'local' }),
      );
      await expect
        .poll(() =>
          app.evaluate(
            () =>
              (globalThis as unknown as { __liveUndeliveredGate: { intercepted: number } })
                .__liveUndeliveredGate.intercepted,
          ),
        )
        .toBe(1);
      const targetEventSeen = () =>
        window.evaluate(
          ({ surface, target }) => {
            const events = (
              window as typeof window & { __liveRearmEvents: TreeEvent[][] }
            ).__liveRearmEvents.flat();
            return events.some((event) =>
              surface === 'tasks'
                ? event.kind === 'tasks'
                : event.kind === 'project' && event.changedPath === target,
            );
          },
          { surface, target },
        );
      expect(await targetEventSeen()).toBe(false);
      await writeFile(
        join(conceptionDir, '.condash', 'settings.json'),
        JSON.stringify({ retired_apps: [] }),
      );
      await expect
        .poll(() =>
          window.evaluate(() =>
            (window as typeof window & { __liveRearmEvents: TreeEvent[][] }).__liveRearmEvents
              .flat()
              .some((event) => event.kind === 'config' || event.kind === 'unknown'),
          ),
        )
        .toBe(true);
      expect(await targetEventSeen()).toBe(false);
      await app.evaluate(() => {
        (
          globalThis as unknown as { __liveUndeliveredGate: { release: null | (() => void) } }
        ).__liveUndeliveredGate.release?.();
      });
      await expect.poll(targetEventSeen).toBe(true);
      if (surface === 'note') {
        await expect(window.locator('.note-modal').getByText('Changed on disk')).toBeVisible();
        await expect(window.locator('.note-modal .md-rendered')).toContainText('initial child');
      } else {
        await expect(window.locator('.tasks-row-name')).toHaveText('Undelivered automation');
        await expect(window.locator('.tasks-prompt-textarea')).toHaveValue(
          'gap draft remains intact',
        );
      }
    } finally {
      await writeFile(
        testInfo.outputPath('not-yet-delivered-state.json'),
        JSON.stringify(await windowState(fixture.window).catch(() => null)),
      );
      await fixture.app
        .evaluate(() => {
          (
            globalThis as unknown as { __liveUndeliveredGate?: { release: null | (() => void) } }
          ).__liveUndeliveredGate?.release?.();
        })
        .catch(() => undefined);
      await fixture.cleanup();
    }
  });
}

test('Search updates unchanged indexed queries, ignores other scopes and closed events', async () => {
  const fixture = await boot();
  try {
    const { app, window, conceptionDir } = fixture;
    await openSearch(app, window);
    const gate = await holdFirstCalls(app, 'search', 0);
    await window.getByRole('radio', { name: 'Knowledge' }).click();
    await expect.poll(gate.count).toBe(1);
    await batch(app, window, [
      { kind: 'tasks' },
      { kind: 'resources', op: 'change', path: join(conceptionDir, 'resources', 'x.md') },
    ]);
    expect(await gate.count()).toBe(1);
    await writeFile(
      join(conceptionDir, 'knowledge', 'added.md'),
      '# Newly matching needle\n\nneedle\n',
    );
    await expect(window.locator('.search-row', { hasText: 'Newly matching' })).toBeVisible();
    await unlink(join(conceptionDir, 'knowledge', 'added.md'));
    await expect(window.locator('.search-row', { hasText: 'Newly matching' })).toHaveCount(0);
    await window.locator('.search-modal').getByRole('button', { name: 'Close' }).click();
    const closedCount = await gate.count();
    await batch(app, window, [
      { kind: 'unknown' },
      { kind: 'knowledge', op: 'change', path: join(conceptionDir, 'knowledge', 'probe.md') },
    ]);
    expect(await gate.count()).toBe(closedCount);
  } finally {
    await fixture.cleanup();
  }
});

test('Search holds one flight plus one coalesced follow-up and recovers after a failure', async () => {
  const fixture = await boot();
  try {
    const { app, window, conceptionDir } = fixture;
    await openSearch(app, window);
    const gate = await holdFirstCalls(app, 'search', 1);
    const event: TreeEvent = {
      kind: 'knowledge',
      op: 'change',
      path: join(conceptionDir, 'knowledge', 'probe.md'),
    };
    await batch(app, window, [event]);
    await expect.poll(gate.count).toBe(1);
    await batch(app, window, [event, event]);
    await batch(app, window, [event]);
    expect(await gate.count()).toBe(1);
    await gate.releaseWithValue(0, { hits: [], terms: [], totalBeforeCap: 0, truncated: false });
    await expect.poll(gate.count).toBe(2);
    await expect(window.locator('.search-row')).toHaveCount(1);
    await gate.uninstall();
    await failNext(app, 'search');
    await batch(app, window, [event]);
    await expect(window.locator('.search-modal .modal-error')).toContainText(
      'local injected failure',
    );
    await expect(window.locator('.search-row')).toHaveCount(1);
    await batch(app, window, [event]);
    await expect(window.locator('.search-modal .modal-error')).toHaveCount(0);
  } finally {
    await fixture.cleanup();
  }
});

test('Search preserves semantic selection and real scroll after reordered rows and rejects departed queries', async () => {
  const fixture = await boot();
  try {
    const { app, window, conceptionDir } = fixture;
    for (let index = 0; index < 12; index++)
      await writeFile(
        join(conceptionDir, 'knowledge', `row-${index}.md`),
        `# needle row ${index}\n\nneedle\n`,
      );
    await openSearch(app, window);
    await expect(window.locator('.search-row')).toHaveCount(13);
    await window.locator('.search-modal-input').press('ArrowDown');
    const selected = await window
      .locator('.search-row[data-selected]')
      .getAttribute('data-result-id');
    await window.locator('.search-results').evaluate((element) => {
      element.scrollTop = 200;
    });
    const before = await window.locator('.search-results').evaluate((element) => element.scrollTop);
    expect(before).toBeGreaterThan(0);
    const results = await window.evaluate(() => window.condash.search('needle', ['knowledge']));
    const gate = await holdFirstCalls(app, 'search', 1);
    await batch(app, window, [{ kind: 'unknown' }]);
    await expect.poll(gate.count).toBe(1);
    await gate.releaseWithValue(0, { ...results, hits: [...results.hits].reverse() });
    await expect(window.locator('.search-row[data-selected]')).toHaveAttribute(
      'data-result-id',
      selected!,
    );
    await expect
      .poll(() => window.locator('.search-results').evaluate((element) => element.scrollTop))
      .toBe(before);
    await gate.uninstall();
    const held = await holdFirstCalls(app, 'search', 1);
    await batch(app, window, [{ kind: 'unknown' }]);
    await expect.poll(held.count).toBe(1);
    await window.locator('.search-modal-input').fill('no-matching-term');
    await held.releaseWithOriginal(0);
    await expect(window.locator('.search-row')).toHaveCount(0);
    await expect(window.locator('.search-modal-input')).toHaveValue('no-matching-term');
  } finally {
    await fixture.cleanup();
  }
});

test('Automations reads only while open and retains editor and fill drafts through external changes', async () => {
  let gate!: Awaited<ReturnType<typeof holdFirstCalls>>;
  const fixture = await bootApp({
    prepare: seed,
    globalConfig: localSettings,
    beforeFirstWindow: async (app) => {
      gate = await holdFirstCalls(app, 'listTasks', 0);
    },
  });
  try {
    const { app, window, conceptionDir } = fixture;
    await expect(window.locator('.rail')).toBeVisible();
    await batch(app, window, [{ kind: 'tasks' }, { kind: 'unknown' }]);
    expect(await gate.count()).toBe(0);
    await window.getByRole('button', { name: 'Automations', exact: true }).click();
    await expect(window.locator('.tasks-row-name')).toHaveText('Initial automation');
    await window.locator('.tasks-row').click();
    await window.locator('.tasks-prompt-textarea').fill('unsaved editor bytes');
    await writeFile(
      taskPath(conceptionDir),
      JSON.stringify({ name: 'External automation', agent: 'local' }),
    );
    await expect(window.locator('.tasks-row-name')).toHaveText('External automation');
    await expect(window.locator('.tasks-prompt-textarea')).toHaveValue('unsaved editor bytes');
    await window
      .locator('.tasks-editor-modal')
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    await window.locator('.tasks-run').click();
    await window.locator('.tasks-fill-scroll input').fill('unsaved fill bytes');
    await writeFile(
      join(conceptionDir, 'tasks', 'probe', 'prompt.md'),
      'Different {AREA:new disk default}',
    );
    const count = await gate.count();
    await batch(app, window, [{ kind: 'tasks' }, { kind: 'tasks' }]);
    await expect.poll(gate.count).toBeGreaterThan(count);
    await expect(window.locator('.tasks-fill-scroll input')).toHaveValue('unsaved fill bytes');
    await window
      .locator('.tasks-fill-modal')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await window
      .getByRole('alertdialog', { name: 'Discard automation edits?' })
      .getByRole('button', { name: 'Discard', exact: true })
      .click();
    await window
      .locator('.surface-overlay')
      .getByRole('button', { name: '← Back', exact: true })
      .click();
    const closed = await gate.count();
    await batch(app, window, [{ kind: 'tasks' }]);
    expect(await gate.count()).toBe(closed);
  } finally {
    await fixture.cleanup();
  }
});

test('Automations coalesces held invalidations and disposal cannot issue a trailing read', async () => {
  const fixture = await boot();
  try {
    const { app, window } = fixture;
    const gate = await holdFirstCalls(app, 'listTasks', 1);
    await window.getByRole('button', { name: 'Automations', exact: true }).click();
    await expect.poll(gate.count).toBe(1);
    await batch(app, window, [{ kind: 'tasks' }]);
    await batch(app, window, [{ kind: 'tasks' }, { kind: 'tasks' }]);
    expect(await gate.count()).toBe(1);
    await gate.releaseWithValue(0, [
      { slug: 'stale', name: 'Stale list', agent: 'local', agentPresent: true, markers: [] },
    ]);
    await expect.poll(gate.count).toBe(2);
    await expect(window.locator('.tasks-row-name')).toHaveText('Initial automation');
    await gate.uninstall();
    const departure = await holdFirstCalls(app, 'listTasks', 1);
    await batch(app, window, [{ kind: 'tasks' }]);
    await expect.poll(departure.count).toBe(1);
    await batch(app, window, [{ kind: 'tasks' }]);
    await window
      .locator('.surface-overlay')
      .getByRole('button', { name: '← Back', exact: true })
      .click();
    await departure.releaseWithOriginal(0);
    await batch(app, window, [{ kind: 'tasks' }]);
    expect(await departure.count()).toBe(1);
  } finally {
    await fixture.cleanup();
  }
});

test('Automations external add/delete and read failure recover without reseeding the open draft', async () => {
  const fixture = await boot();
  try {
    const { app, window, conceptionDir } = fixture;
    await window.getByRole('button', { name: 'Automations', exact: true }).click();
    await window.locator('.tasks-row').click();
    await window.locator('.tasks-prompt-textarea').fill('persistent draft');
    const gate = await holdFirstCalls(app, 'listTasks', 0);
    await batch(app, window, [
      { kind: 'unknown' },
      { kind: 'knowledge', op: 'change', path: join(conceptionDir, 'knowledge', 'probe.md') },
    ]);
    expect(await gate.count()).toBe(0);
    await gate.uninstall();
    await failNext(app, 'listTasks');
    await mkdir(join(conceptionDir, 'tasks', 'new-task'));
    await writeFile(
      join(conceptionDir, 'tasks', 'new-task', 'task.json'),
      JSON.stringify({ name: 'Added automation', agent: 'local' }),
    );
    await writeFile(join(conceptionDir, 'tasks', 'new-task', 'prompt.md'), 'New prompt');
    await batch(app, window, [{ kind: 'tasks' }]);
    await batch(app, window, [{ kind: 'tasks' }]);
    await expect(window.locator('.tasks-row-name', { hasText: 'Added automation' })).toBeVisible();
    await rm(join(conceptionDir, 'tasks', 'new-task'), { recursive: true });
    await expect(window.locator('.tasks-row-name', { hasText: 'Added automation' })).toHaveCount(0);
    await expect(window.locator('.tasks-prompt-textarea')).toHaveValue('persistent draft');
  } finally {
    await fixture.cleanup();
  }
});

test('Root departure drops held Search and task-list work and leaves closed new-root overlays unread', async () => {
  const root = await secondRoot();
  const fixture = await boot();
  try {
    const { app, window } = fixture;
    await openSearch(app, window);
    const search = await holdFirstCalls(app, 'search', 1);
    await batch(app, window, [{ kind: 'unknown' }]);
    await expect.poll(search.count).toBe(1);
    await batch(app, window, [{ kind: 'unknown' }]);
    await switchRoot(app, window, root);
    await search.releaseWithOriginal(0);
    await batch(app, window, [{ kind: 'unknown' }]);
    expect(await search.count()).toBe(1);
    await expect(window.locator('.search-modal')).toHaveCount(0);
    const tasks = await holdFirstCalls(app, 'listTasks', 1);
    await window.getByRole('button', { name: 'Automations', exact: true }).click();
    await expect.poll(tasks.count).toBe(1);
    await batch(app, window, [{ kind: 'tasks' }]);
    await switchRoot(app, window, fixture.conceptionDir);
    await tasks.releaseWithOriginal(0);
    await batch(app, window, [{ kind: 'tasks' }]);
    expect(await tasks.count()).toBe(1);
    await expect(window.locator('.tasks-pane')).toHaveCount(0);
  } finally {
    await fixture.cleanup();
    await rm(root, { recursive: true });
  }
});

test('A held dynamic editor mount cannot seed pre-Reload content or save an unmounted draft', async () => {
  const fixture = await boot();
  try {
    const { app, window } = fixture;
    await openNote(app, window);
    await app.evaluate(({ session }) => {
      const state = { count: 0, release: null as null | (() => void) };
      (globalThis as unknown as { __liveEditorGate: typeof state }).__liveEditorGate = state;
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        if (/\/editor-[^/]+\.js$/.test(details.url)) {
          state.count++;
          state.release = () => callback({});
        } else callback({});
      });
    });
    await window
      .locator('.note-modal')
      .getByRole('button', { name: 'Switch to edit mode' })
      .click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as unknown as { __liveEditorGate: { count: number } }).__liveEditorGate
              .count,
        ),
      )
      .toBe(1);
    const writes = await holdFirstCalls(app, 'writeNote', 0);
    await window.keyboard.press('Control+s');
    expect(await writes.count()).toBe(0);
    const read = await holdFirstCalls(app, 'readNote', 1);
    await window
      .locator('.note-modal')
      .getByRole('button', { name: 'Reload', exact: true })
      .click();
    await expect.poll(read.count).toBe(1);
    await read.releaseWithValue(0, '# New editor baseline\n');
    await app.evaluate(() =>
      (
        globalThis as unknown as { __liveEditorGate: { release: () => void } }
      ).__liveEditorGate.release(),
    );
    await expect(window.locator('.cm-content')).toContainText('New editor baseline');
    await expect(window.locator('.cm-content')).not.toContainText('paragraph 0');
  } finally {
    await fixture.cleanup();
  }
});

test('Note Reload retains mounted editor selection and real scroll; shorter preview clamps scroll', async () => {
  const fixture = await boot();
  try {
    const { app, window, conceptionDir } = fixture;
    await openNote(app, window);
    await window
      .locator('.note-modal')
      .getByRole('button', { name: 'Switch to edit mode' })
      .click();
    const editor = window.locator('.cm-content');
    await expect(editor).toBeVisible();
    const gate = await holdFirstCalls(app, 'readNote', 1);
    await window
      .locator('.note-modal')
      .getByRole('button', { name: 'Reload', exact: true })
      .click();
    await expect.poll(gate.count).toBe(1);
    await editor.click();
    await window.keyboard.press('Control+Home');
    await window.keyboard.press('ArrowRight');
    await window.keyboard.press('ArrowRight');
    await window.keyboard.press('Shift+ArrowRight');
    const selection = await window.evaluate(() => window.getSelection()?.toString());
    expect(selection).toBe('R');
    await window.locator('.cm-scroller').evaluate((element) => {
      (element as HTMLElement).dataset.ownerProbe = 'same-editor';
    });
    const editorSelection = () =>
      editor.evaluate((element) => {
        const view = (
          element as unknown as {
            cmTile: {
              root: { view: { state: { selection: { main: { anchor: number; head: number } } } } };
            };
          }
        ).cmTile.root.view;
        return { anchor: view.state.selection.main.anchor, head: view.state.selection.main.head };
      });
    const selectedRange = await editorSelection();
    await window.locator('.note-modal .modal-body').evaluate((element) => {
      element.scrollTop = 700;
    });
    await window.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const editScroll = await window
      .locator('.note-modal .modal-body')
      .evaluate((element) => element.scrollTop);
    expect(editScroll).toBeGreaterThan(0);
    await gate.releaseWithValue(0, noteText(110));
    await expect
      .poll(() =>
        window.locator('.note-modal .modal-body').evaluate((element) => element.scrollTop),
      )
      .toBe(editScroll);
    await expect(window.locator('.cm-scroller')).toHaveAttribute('data-owner-probe', 'same-editor');
    await expect.poll(editorSelection).toEqual(selectedRange);
    await gate.uninstall();
    await window
      .locator('.note-modal')
      .getByRole('button', { name: 'Switch to view mode' })
      .click();
    await window.locator('.note-modal .modal-body').evaluate((element) => {
      element.scrollTop = 1000;
    });
    await writeFile(join(conceptionDir, 'knowledge', 'probe.md'), '# Short\n\nneedle\n');
    await expect(window.locator('.note-modal').getByText('Changed on disk')).toBeVisible();
    await window
      .locator('.note-modal')
      .getByRole('button', { name: 'Reload', exact: true })
      .click();
    await expect(window.locator('.note-modal .md-rendered')).toHaveText(/Short\s+needle/);
    await expect
      .poll(() =>
        window.locator('.note-modal .modal-body').evaluate((element) => element.scrollTop),
      )
      .toBe(0);
  } finally {
    await fixture.cleanup();
  }
});

test('Notes reject held Reload after root departure and late navigation replies', async () => {
  const root = await secondRoot();
  const fixture = await boot();
  try {
    const { app, window, conceptionDir } = fixture;
    await openNote(app, window);
    const gate = await holdFirstCalls(app, 'readNote', 1);
    await window
      .locator('.note-modal')
      .getByRole('button', { name: 'Reload', exact: true })
      .click();
    await expect.poll(gate.count).toBe(1);
    await switchRoot(app, window, root);
    await gate.releaseWithValue(0, '# Forbidden old-root reply\n');
    await expect(window.locator('.note-modal')).not.toContainText('Forbidden old-root reply');
    await window.locator('.note-modal').getByRole('button', { name: 'Close', exact: true }).click();
    await gate.uninstall();
    await switchRoot(app, window, conceptionDir);
    await openNote(app, window);
    await window.locator('.note-modal').getByRole('button', { name: 'Close', exact: true }).click();
    await writeFile(
      join(conceptionDir, 'knowledge', 'linked.md'),
      '# Linked document\n\n[Next](probe.md)\n',
    );
    await expect(window.locator('.knowledge-card', { hasText: 'Linked document' })).toBeVisible();
    await window.locator('.knowledge-card', { hasText: 'Linked document' }).click();
    const held = await holdFirstCalls(app, 'readNote', 1);
    await window
      .locator('.note-modal')
      .getByRole('button', { name: 'Reload', exact: true })
      .click();
    await expect.poll(held.count).toBe(1);
    await window.locator('.note-modal .md-rendered').getByRole('link', { name: 'Next' }).click();
    await expect(window.locator('.note-modal .md-rendered')).toContainText('paragraph 119');
    await held.releaseWithValue(0, '# Forbidden previous-path reply\n');
    await expect(window.locator('.note-modal')).not.toContainText('Forbidden previous-path reply');
  } finally {
    await fixture.cleanup();
    await rm(root, { recursive: true });
  }
});

test('Logs Reload retains current query/ordinal changes, failures and zero-hit shorter-content clamp', async () => {
  const fixture = await boot();
  try {
    const { app, window } = fixture;
    await openSearch(app, window);
    await window.getByRole('radio', { name: 'Logs', exact: true }).click();
    await window.locator('.search-row').first().click();
    await expect(window.locator('.logs-transcript')).toBeVisible();
    await failNext(app, 'logsReadSession');
    await window
      .locator('.logs-modal')
      .getByRole('button', { name: 'Reload', exact: true })
      .click();
    await expect(window.locator('.logs-modal .modal-error')).toContainText(
      'local injected failure',
    );
    await expect(window.locator('.logs-transcript')).toContainText('needle transcript');
    const gate = await holdFirstCalls(app, 'logsReadSession', 1);
    await window
      .locator('.logs-modal')
      .getByRole('button', { name: 'Reload', exact: true })
      .click();
    await expect.poll(gate.count).toBe(1);
    await window.locator('.logs-search').fill('transcript');
    await window.getByRole('button', { name: 'Next match', exact: true }).click();
    await window.locator('.logs-transcript').evaluate((element) => {
      element.scrollTop = 500;
    });
    await gate.releaseWithValue(0, { meta: null, text: 'short body with zero matches' });
    await expect(window.locator('.logs-search')).toHaveValue('transcript');
    await expect(window.locator('.logs-hit-count')).toHaveText('0');
    await expect(window.locator('.logs-transcript')).toContainText('short body');
    await expect
      .poll(() => window.locator('.logs-transcript').evaluate((element) => element.scrollTop))
      .toBe(0);
  } finally {
    await fixture.cleanup();
  }
});

test('Note Reload preserves real preview scroll/find and clamps active matches without centering', async ({}, testInfo) => {
  const fixture = await boot();
  try {
    const { app, window, conceptionDir } = fixture;
    await openNote(app, window);
    await window.keyboard.press('Control+f');
    await window.locator('.find-input').fill('needle');
    await expect(window.locator('.find-count')).toHaveText('1 / 120');
    await window.locator('.find-input').press('Enter');
    await window.locator('.note-modal .modal-body').evaluate((element) => {
      element.scrollTop = 600;
    });
    const scroll = await window
      .locator('.note-modal .modal-body')
      .evaluate((element) => element.scrollTop);
    expect(scroll).toBeGreaterThan(0);
    await writeFile(join(conceptionDir, 'knowledge', 'probe.md'), noteText(100, 1));
    await expect(window.locator('.note-modal').getByText('Changed on disk')).toBeVisible();
    await expect(window.locator('.find-count')).toHaveText('2 / 120');
    await window
      .locator('.note-modal')
      .getByRole('button', { name: 'Reload', exact: true })
      .click();
    await expect(window.locator('.find-count')).toHaveText('1 / 1');
    await expect(window.locator('.find-input')).toHaveValue('needle');
    await expect
      .poll(() =>
        window.locator('.note-modal .modal-body').evaluate((element) => element.scrollTop),
      )
      .toBe(scroll);
    await window
      .locator('.note-modal')
      .screenshot({ path: testInfo.outputPath('note-reload-preserved.png') });
  } finally {
    await fixture.cleanup();
  }
});

test('Note Reload guards discard, allows held-read typing, blocks Save and reseeds the mounted editor', async ({}, testInfo) => {
  const fixture = await boot();
  try {
    const { app, window, conceptionDir } = fixture;
    await openNote(app, window);
    await window
      .locator('.note-modal')
      .getByRole('button', { name: 'Switch to edit mode' })
      .click();
    const editor = window.locator('.note-modal .cm-content');
    await expect(editor).toContainText('paragraph 0');
    const gate = await holdFirstCalls(app, 'readNote', 1);
    const writes = await holdFirstCalls(app, 'writeNote', 0);
    await window
      .locator('.note-modal')
      .getByRole('button', { name: 'Reload', exact: true })
      .click();
    await expect.poll(gate.count).toBe(1);
    await editor.click();
    await window.keyboard.press('Control+End');
    await window.keyboard.type('held typing survives');
    await window.keyboard.press('Control+s');
    expect(await writes.count()).toBe(0);
    await gate.releaseWithValue(0, '# Replacement that must not paint\n');
    await expect(editor).toContainText('held typing survives');
    await expect(editor).not.toContainText('Replacement that must not paint');
    await expect(window.locator('.note-modal').getByText('Changed on disk')).toBeVisible();
    await gate.uninstall();
    await window
      .locator('.note-modal')
      .getByRole('button', { name: 'Reload', exact: true })
      .click();
    await window
      .getByRole('alertdialog', { name: 'Reload with unsaved changes?' })
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    await expect(editor).toContainText('held typing survives');
    await writeFile(join(conceptionDir, 'knowledge', 'probe.md'), '# Accepted disk replacement\n');
    await window.screenshot({ path: testInfo.outputPath('before-discard-reload.png') });
    await window
      .locator('.note-modal')
      .getByRole('button', { name: 'Reload', exact: true })
      .click({ timeout: 5000 });
    await window
      .getByRole('alertdialog', { name: 'Reload with unsaved changes?' })
      .getByRole('button', { name: 'Discard changes' })
      .click();
    await expect(editor).toContainText('Accepted disk replacement');
    await expect(editor).not.toContainText('held typing survives');
    await expect(
      window.locator('.note-modal').getByRole('button', { name: 'Save', exact: true }),
    ).toBeDisabled();
  } finally {
    await fixture.cleanup();
  }
});

test('Note Save keeps later typing dirty, rejects Reload overlap and failed/newer disk reads retain the notice', async () => {
  const fixture = await boot();
  try {
    const { app, window, conceptionDir } = fixture;
    await openNote(app, window);
    await window
      .locator('.note-modal')
      .getByRole('button', { name: 'Switch to edit mode' })
      .click();
    const editor = window.locator('.note-modal .cm-content');
    await expect(editor).toBeVisible();
    await editor.click();
    await window.keyboard.press('Control+End');
    await window.keyboard.type('submitted text');
    const gate = await holdFirstCalls(app, 'writeNote', 1);
    await window.locator('.note-modal').getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(gate.count).toBe(1);
    await expect(
      window.locator('.note-modal').getByRole('button', { name: 'Reload', exact: true }),
    ).toBeDisabled();
    await editor.click();
    await window.keyboard.press('Control+End');
    await window.keyboard.type('later typing');
    await gate.releaseWithOriginal(0);
    await expect(editor).toContainText('later typing');
    await expect(
      window.locator('.note-modal').getByRole('button', { name: 'Save', exact: true }),
    ).toBeEnabled();
    await gate.uninstall();
    await window.locator('.note-modal').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      window.locator('.note-modal').getByRole('button', { name: 'Save', exact: true }),
    ).toBeDisabled();
    await writeFile(join(conceptionDir, 'knowledge', 'probe.md'), '# New disk state\n');
    await expect(window.locator('.note-modal').getByText('Changed on disk')).toBeVisible();
    await failNext(app, 'readNote');
    await window
      .locator('.note-modal')
      .getByRole('button', { name: 'Reload', exact: true })
      .click();
    await expect(window.locator('.note-modal .modal-error')).toContainText(
      'local injected failure',
    );
    await expect(editor).toContainText('later typing');
    const readGate = await holdFirstCalls(app, 'readNote', 1);
    await window
      .locator('.note-modal')
      .getByRole('button', { name: 'Reload', exact: true })
      .click();
    await expect.poll(readGate.count).toBe(1);
    await batch(app, window, [
      { kind: 'knowledge', op: 'change', path: join(conceptionDir, 'knowledge', 'probe.md') },
    ]);
    await expect(
      window.locator('.note-modal').getByRole('button', { name: 'Reload', exact: true }),
    ).toBeDisabled();
    await readGate.releaseWithValue(0, '# Eligible snapshot\n');
    await expect(editor).toContainText('Eligible snapshot');
    await expect(window.locator('.note-modal').getByText('Changed on disk')).toBeVisible();
    expect(await readGate.count()).toBe(1);
  } finally {
    await fixture.cleanup();
  }
});

test('Exact mixed-batch note paths survive shared README tickets; late close replies cannot paint', async () => {
  const fixture = await boot();
  try {
    const { app, window, conceptionDir } = fixture;
    await openNote(app, window);
    const path = join(conceptionDir, 'knowledge', 'probe.md');
    await batch(app, window, [{ kind: 'unknown' }]);
    await expect(window.locator('.note-modal').getByText('Changed on disk')).toHaveCount(0);
    const readme = join(projectDir(conceptionDir), 'README.md');
    await batch(app, window, [
      { kind: 'project', op: 'change', path: readme, changedPath: path },
      { kind: 'unknown' },
      {
        kind: 'project',
        op: 'change',
        path: readme,
        changedPath: join(projectDir(conceptionDir), 'notes', 'probe.md'),
      },
    ]);
    await expect(window.locator('.note-modal').getByText('Changed on disk')).toBeVisible();
    const gate = await holdFirstCalls(app, 'readNote', 1);
    await window
      .locator('.note-modal')
      .getByRole('button', { name: 'Reload', exact: true })
      .click();
    await expect.poll(gate.count).toBe(1);
    await window.locator('.note-modal').getByRole('button', { name: 'Close', exact: true }).click();
    await gate.releaseWithValue(0, '# Departed snapshot\n');
    await openNote(app, window);
    await expect(window.locator('.note-modal')).not.toContainText('Departed snapshot');
  } finally {
    await fixture.cleanup();
  }
});

test('Skills expose explicit Reload and only exact watched paths show changed-on-disk', async () => {
  const fixture = await boot();
  try {
    const { app, window, conceptionDir } = fixture;
    await sendMenu(app, 'show-skills');
    await window.locator('.tree-dir-header', { hasText: 'probe' }).click();
    await window.locator('.skill-special-file', { hasText: 'Skill probe' }).click();
    await expect(window.locator('.note-modal .md-rendered')).toContainText('initial skill');
    const path = join(conceptionDir, '.agents', 'skills', 'probe', 'SKILL.md');
    await batch(app, window, [{ kind: 'skills', op: 'change', path: `${path}-other` }]);
    await expect(window.locator('.note-modal').getByText('Changed on disk')).toHaveCount(0);
    await writeFile(path, '# Skill probe\n\nupdated skill\n');
    await expect(window.locator('.note-modal').getByText('Changed on disk')).toBeVisible();
    await expect(window.locator('.note-modal .md-rendered')).toContainText('initial skill');
    await window
      .locator('.note-modal')
      .getByRole('button', { name: 'Reload', exact: true })
      .click();
    await expect(window.locator('.note-modal .md-rendered')).toContainText('updated skill');
  } finally {
    await fixture.cleanup();
  }
});

test('Logs stay snapshots until Reload and preserve mounted scroll/find with same-line-count fewer hits', async ({}, testInfo) => {
  const fixture = await boot();
  try {
    const { app, window } = fixture;
    await openSearch(app, window, 'needle');
    await window.getByRole('radio', { name: 'Logs', exact: true }).click();
    await window.locator('.search-row').first().click();
    await expect(window.locator('.logs-transcript')).toContainText('needle transcript');
    await window.locator('.logs-search').fill('needle');
    await expect(window.locator('.logs-hit-count')).toHaveText('1 / 200');
    await window.getByRole('button', { name: 'Next match', exact: true }).click();
    await window.locator('.logs-transcript').evaluate((element) => {
      element.scrollTop = 900;
      (element as HTMLElement).dataset.ownerProbe = 'mounted';
    });
    const scroll = await window
      .locator('.logs-transcript')
      .evaluate((element) => element.scrollTop);
    expect(scroll).toBeGreaterThan(0);
    const gate = await holdFirstCalls(app, 'logsReadSession', 1);
    await writeFile(
      logPath,
      Array.from(
        { length: 200 },
        (_, index) => `${index === 0 ? 'needle' : 'plain'} replacement ${index}`,
      ).join('\n'),
    );
    await batch(app, window, [{ kind: 'unknown' }]);
    expect(await gate.count()).toBe(0);
    await expect(window.locator('.logs-hit-count')).toHaveText('2 / 200');
    await window
      .locator('.logs-modal')
      .getByRole('button', { name: 'Reload', exact: true })
      .click();
    await expect.poll(gate.count).toBe(1);
    await expect(window.locator('.logs-transcript')).toHaveAttribute('data-owner-probe', 'mounted');
    await window.locator('.logs-transcript').evaluate((element) => {
      element.scrollTop = 1100;
    });
    await gate.releaseWithOriginal(0);
    await expect(window.locator('.logs-hit-count')).toHaveText('1 / 1');
    await expect(window.locator('.logs-search')).toHaveValue('needle');
    await expect
      .poll(() => window.locator('.logs-transcript').evaluate((element) => element.scrollTop))
      .toBe(1100);
    await expect(window.locator('.logs-transcript')).toHaveAttribute('data-owner-probe', 'mounted');
    await window
      .locator('.logs-modal')
      .screenshot({ path: testInfo.outputPath('logs-reload-preserved.png') });
    await gate.uninstall();
    const closed = await holdFirstCalls(app, 'logsReadSession', 1);
    await window
      .locator('.logs-modal')
      .getByRole('button', { name: 'Reload', exact: true })
      .click();
    await expect.poll(closed.count).toBe(1);
    await window.locator('.logs-modal').getByRole('button', { name: 'Close', exact: true }).click();
    await closed.releaseWithOriginal(0);
    await batch(app, window, [{ kind: 'unknown' }]);
    expect(await closed.count()).toBe(1);
    await expect(window.locator('.logs-modal')).toHaveCount(0);
  } finally {
    await fixture.cleanup();
  }
});
