import { ipcMain, shell } from 'electron';
import type { AgentDef } from '../../shared/harnesses';
import {
  deleteAgent,
  ensureAgentsEnv,
  listAgents,
  previewAgent,
  readAgent,
  writeAgent,
} from '../agents';
import { withConception } from './utils';

/**
 * Wire the Agents-pane IPC. Every verb is conception-scoped (agents live at
 * `<conception>/agents/`). Secrets never cross this boundary: the renderer
 * sees token *presence* (via `listAgents`) and `$SECRET_ENV` references (via
 * `previewAgent`), never a value.
 */
export function registerAgentsIpc(): void {
  ipcMain.handle('listAgents', () => withConception((c) => listAgents(c), []));

  ipcMain.handle('readAgent', (_, name: string) => withConception((c) => readAgent(c, name), null));

  ipcMain.handle('writeAgent', (_, def: AgentDef, previousName?: string) =>
    withConception((c) => writeAgent(c, def, previousName), ''),
  );

  ipcMain.handle('deleteAgent', (_, name: string) =>
    withConception(async (c) => {
      await deleteAgent(c, name);
    }, undefined),
  );

  ipcMain.handle('previewAgent', (_, name: string) =>
    withConception((c) => previewAgent(c, name), null),
  );

  // Create agents/.env (with a commented template) if missing, then open it in
  // the OS default editor. Returns the path; throws on an openPath failure.
  ipcMain.handle('openAgentsEnv', () =>
    withConception(async (c) => {
      const file = await ensureAgentsEnv(c);
      const err = await shell.openPath(file);
      if (err) throw new Error(err);
      return file;
    }, null),
  );
}
