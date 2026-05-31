import { ipcMain } from 'electron';
import type { TaskDef } from '../../shared/tasks';
import type { TaskConfigEntry } from '../../shared/types';
import { deleteTask, listTasks, readTask, writeTask } from '../tasks';
import { getEffectiveConceptionConfig } from '../effective-config';
import { updateSettings } from '../settings';
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

  // Per-task schedule / excludeFromLogs config (capability 1). Read merges
  // through the effective config (condash.json over settings.json); writes
  // always target the per-machine settings.json `taskConfig` map.
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
    const excludeFromLogs = entry?.excludeFromLogs === true ? true : undefined;
    await updateSettings((cur) => {
      const map = { ...((cur.taskConfig ?? {}) as Record<string, TaskConfigEntry>) };
      if (schedule === undefined && excludeFromLogs === undefined) {
        delete map[slug];
      } else {
        map[slug] = {
          ...(schedule ? { schedule } : {}),
          ...(excludeFromLogs ? { excludeFromLogs } : {}),
        };
      }
      return { ...cur, taskConfig: Object.keys(map).length > 0 ? map : undefined };
    });
  });
}
