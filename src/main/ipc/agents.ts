import { ipcMain } from 'electron';
import type { AgentDef } from '../../shared/harnesses';
import {
  deleteAgent,
  listAgents,
  previewAgent,
  readAgent,
  readAgentsEnv,
  writeAgent,
  writeAgentsEnv,
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

  // In-app token editing — raw read/write of agents/.env. The renderer's token
  // editor is the one deliberate place secret values surface in the UI.
  ipcMain.handle('readAgentsEnv', () => withConception((c) => readAgentsEnv(c), null));

  ipcMain.handle('writeAgentsEnv', (_, content: string) =>
    withConception(async (c) => {
      await writeAgentsEnv(c, content);
    }, undefined),
  );
}
