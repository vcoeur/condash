import { ipcMain } from 'electron';
import type { TaskDef } from '../../shared/tasks';
import { deleteTask, listTasks, readTask, writeTask } from '../tasks';
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
}
