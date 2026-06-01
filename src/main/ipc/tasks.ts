import { ipcMain } from 'electron';
import type { TaskDef } from '../../shared/tasks';
import type { TaskConfigEntry } from '../../shared/types';
import { deleteTask, listTasks, readTask, writeTask } from '../tasks';
import { getEffectiveConceptionConfig } from '../effective-config';
import { updateSettings } from '../settings';
import { killTaskRun, listRunningTaskRuns } from '../task-scheduler';
import { withConception } from './utils';

/**
 * Wire the Tasks-pane IPC. Every verb is conception-scoped (tasks live at
 * `<conception>/tasks/`). A task references an agent by `id` from the `agents`
 * settings list.
 */
export function registerTasksIpc(): void {
  ipcMain.handle('listTasks', () => withConception((c) => listTasks(c), []));

  ipcMain.handle('readTask', (_, slug: string) => withConception((c) => readTask(c, slug), null));

  ipcMain.handle('writeTask', (_, slug: string, def: TaskDef, previousSlug?: string) =>
    withConception((c) => writeTask(c, slug, def, previousSlug), ''),
  );

  ipcMain.handle('deleteTask', (_, slug: string) =>
    withConception(async (c) => {
      await deleteTask(c, slug);
    }, undefined),
  );

  // Live headless scheduled runs (capability 1) — the Tasks pane's "Running"
  // section lists them and can kill one. Process-global, not conception-scoped:
  // the scheduler only ever runs the active conception's tasks.
  ipcMain.handle('listRunningTaskRuns', () => listRunningTaskRuns());
  ipcMain.handle('killTaskRun', (_, sid: string) => killTaskRun(sid));

  // Per-task schedule / timeout / excludeFromLogs / runMode config
  // (capability 1). Read merges through the effective config (condash.json over
  // settings.json); writes always target the per-machine settings.json
  // `taskConfig` map.
  ipcMain.handle('getTaskConfig', () =>
    withConception(async (c) => {
      const config = await getEffectiveConceptionConfig(c);
      return (config.taskConfig ?? {}) as Record<string, TaskConfigEntry>;
    }, {}),
  );

  ipcMain.handle('setTaskConfig', async (_, slug: string, entry: TaskConfigEntry) => {
    if (typeof slug !== 'string' || slug.length === 0) {
      throw new Error('setTaskConfig: slug must be a non-empty string');
    }
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
    await updateSettings((cur) => {
      const map = { ...((cur.taskConfig ?? {}) as Record<string, TaskConfigEntry>) };
      if (
        schedule === undefined &&
        timeout === undefined &&
        excludeFromLogs === undefined &&
        runMode === undefined &&
        gateOnUpdatedTabs === undefined
      ) {
        delete map[slug];
      } else {
        map[slug] = {
          ...(schedule ? { schedule } : {}),
          ...(timeout ? { timeout } : {}),
          ...(excludeFromLogs ? { excludeFromLogs } : {}),
          ...(runMode ? { runMode } : {}),
          ...(gateOnUpdatedTabs ? { gateOnUpdatedTabs } : {}),
        };
      }
      return { ...cur, taskConfig: Object.keys(map).length > 0 ? map : undefined };
    });
  });
}
