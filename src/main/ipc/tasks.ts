import { ipcMain } from 'electron';
import type { TaskDef } from '../../shared/tasks';
import type { TaskConfigEntry } from '../../shared/types';
import { deleteTask, listTasks, readTask, writeTask } from '../tasks';
import { getEffectiveConceptionConfig, mutateConceptionConfig } from '../effective-config';
import { killTaskRun, listRunningTaskRuns } from '../task-scheduler';
import {
  requireMainWindowSender,
  requireNonEmptyString,
  requireRecord,
  withConception,
} from './utils';

/**
 * Wire the Tasks-pane IPC. Every verb is conception-scoped (tasks live at
 * `<conception>/tasks/`). A task references an agent by `id` from the `agents`
 * settings list.
 */
export function registerTasksIpc(): void {
  ipcMain.handle('listTasks', (event) => {
    requireMainWindowSender(event);
    return withConception((c) => listTasks(c), []);
  });

  ipcMain.handle('readTask', (event, slug: unknown) => {
    requireMainWindowSender(event);
    const taskSlug = requireNonEmptyString('readTask', slug);
    return withConception((c) => readTask(c, taskSlug), null);
  });

  ipcMain.handle('writeTask', (event, slug: unknown, def: unknown, previousSlug?: string) => {
    requireMainWindowSender(event);
    const taskSlug = requireNonEmptyString('writeTask', slug);
    const taskDef = requireRecord('writeTask', def) as unknown as TaskDef;
    return withConception((c) => writeTask(c, taskSlug, taskDef, previousSlug), '');
  });

  ipcMain.handle('deleteTask', (event, slug: unknown) => {
    requireMainWindowSender(event);
    const taskSlug = requireNonEmptyString('deleteTask', slug);
    return withConception(async (c) => {
      await deleteTask(c, taskSlug);
    }, undefined);
  });

  // Live headless scheduled runs (capability 1) — the Tasks pane's "Running"
  // section lists them and can kill one. Process-global, not conception-scoped:
  // the scheduler only ever runs the active conception's tasks.
  ipcMain.handle('listRunningTaskRuns', (event) => {
    requireMainWindowSender(event);
    return listRunningTaskRuns();
  });
  ipcMain.handle('killTaskRun', (event, sid: string) => {
    requireMainWindowSender(event);
    return killTaskRun(sid);
  });

  // Per-task schedule / timeout / excludeFromLogs / runMode config
  // (capability 1). Both read and write target the conception-owned
  // `taskConfig` map in `<conception>/.condash/settings.json` — `taskConfig` is
  // a conception-scoped key (`SCOPE_OF.taskConfig === 'conception'`), so it must
  // never land in the per-machine global `settings.json`.
  ipcMain.handle('getTaskConfig', (event) => {
    requireMainWindowSender(event);
    return withConception(async (c) => {
      const config = await getEffectiveConceptionConfig(c);
      return (config.taskConfig ?? {}) as Record<string, TaskConfigEntry>;
    }, {});
  });

  ipcMain.handle('setTaskConfig', async (event, slug: unknown, entry: TaskConfigEntry) => {
    requireMainWindowSender(event);
    const taskSlug = requireNonEmptyString('setTaskConfig', slug);
    const schedule =
      typeof entry?.schedule === 'string' && entry.schedule.trim().length > 0
        ? entry.schedule.trim()
        : undefined;
    const timeout =
      typeof entry?.timeout === 'string' && entry.timeout.trim().length > 0
        ? entry.timeout.trim()
        : undefined;
    const excludeFromLogs = entry?.excludeFromLogs === true ? true : undefined;
    // Only the non-default `oneshot` mode is persisted; `interactive` is the
    // implied default and stays absent (matches the renderer's contract).
    const runMode = entry?.runMode === 'oneshot' ? 'oneshot' : undefined;
    // Opt-in growth gate — only `true` is persisted (absent = no gate).
    const gateOnUpdatedTabs = entry?.gateOnUpdatedTabs === true ? true : undefined;
    // Exhaustive projection keyed by `keyof TaskConfigEntry`: adding a field to
    // the type without giving it a projection here is a tsc error, not a
    // silently-dropped setting (the bug this whole entry-shape has shipped
    // before). Build the persisted entry by stripping the absent/default
    // fields generically so the field list lives in exactly one place.
    const projected = {
      schedule,
      timeout,
      excludeFromLogs,
      runMode,
      gateOnUpdatedTabs,
    } satisfies Record<keyof TaskConfigEntry, unknown>;
    const persisted: TaskConfigEntry = {};
    for (const [key, value] of Object.entries(projected)) {
      if (value !== undefined) (persisted as Record<string, unknown>)[key] = value;
    }
    await withConception(async (conceptionPath) => {
      await mutateConceptionConfig(conceptionPath, (config) => {
        const map = { ...((config.taskConfig ?? {}) as Record<string, TaskConfigEntry>) };
        if (Object.keys(persisted).length === 0) {
          delete map[taskSlug];
        } else {
          map[taskSlug] = persisted;
        }
        if (Object.keys(map).length > 0) config.taskConfig = map;
        else delete config.taskConfig;
      });
    }, undefined);
  });
}
