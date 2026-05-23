import { ipcMain } from 'electron';
import type { AgentDef } from '../../shared/harnesses';
import {
  agentsEnvPath,
  deleteAgent,
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

  ipcMain.handle('getAgentsEnvPath', () => withConception((c) => agentsEnvPath(c), null));
}
