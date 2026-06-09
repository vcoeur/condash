import { ipcMain } from 'electron';
import { listAgents } from '../agents';
import { requireMainWindowSender, withConception } from './utils';

/**
 * Wire the agents IPC. Agents are read from the conception's effective config
 * (`agents` list); the renderer uses them to populate the tab-strip spawn
 * dropdown and resolve Tasks bindings. Editing agents happens in the Settings
 * modal, so there is no write verb here.
 */
export function registerAgentsIpc(): void {
  ipcMain.handle('listAgents', (event) => {
    requireMainWindowSender(event);
    return withConception((c) => listAgents(c), []);
  });
}
