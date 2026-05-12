import { ipcMain } from 'electron';
import {
  attachTerminal,
  closeSession,
  getTerminalPrefs,
  listTerminalSessions,
  resizeTerminal,
  setSessionSide,
  setTerminalPrefs,
  spawnTerminal,
  writeTerminal,
} from '../terminals';
import { latestScreenshot } from '../screenshot';
import { readSettings } from '../settings';
import type { TermSpawnRequest } from '../../shared/types';

/** Wire every term.* IPC handler. Called once from main entry. */
export function registerTerminalIpc(): void {
  ipcMain.handle('termSpawn', async (event, request: TermSpawnRequest) => {
    const { lastConceptionPath: conceptionPath } = await readSettings();
    return spawnTerminal(conceptionPath, event.sender, request);
  });

  ipcMain.handle('termWrite', (_, id: string, data: string) => {
    writeTerminal(id, data);
  });

  ipcMain.handle('termResize', (_, id: string, cols: number, rows: number) => {
    resizeTerminal(id, cols, rows);
  });

  ipcMain.handle('termClose', (_, id: string) => {
    closeSession(id);
  });

  ipcMain.handle('termList', () => listTerminalSessions());

  ipcMain.handle('termAttach', (event, id: string) => attachTerminal(id, event.sender));

  ipcMain.handle('termSetSide', (_, id: string, side: 'my' | 'code') => {
    if (side !== 'my' && side !== 'code') {
      throw new Error(`termSetSide: invalid side ${JSON.stringify(side)}`);
    }
    return setSessionSide(id, side);
  });

  ipcMain.handle('termGetPrefs', async () => {
    return (await getTerminalPrefs()) ?? {};
  });

  ipcMain.handle('termSetPrefs', async (_, prefs: unknown) => {
    if (!prefs || typeof prefs !== 'object') {
      throw new Error('termSetPrefs: payload must be an object');
    }
    await setTerminalPrefs(prefs as Parameters<typeof setTerminalPrefs>[0]);
  });

  ipcMain.handle('termLatestScreenshot', async (_, dir: string) => {
    return latestScreenshot(dir);
  });
}
