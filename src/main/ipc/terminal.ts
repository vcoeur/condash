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
  ipcMain.handle('term.spawn', async (event, request: TermSpawnRequest) => {
    const { conceptionPath } = await readSettings();
    return spawnTerminal(conceptionPath, event.sender, request);
  });

  ipcMain.handle('term.write', (_, id: string, data: string) => {
    writeTerminal(id, data);
  });

  ipcMain.handle('term.resize', (_, id: string, cols: number, rows: number) => {
    resizeTerminal(id, cols, rows);
  });

  ipcMain.handle('term.close', (_, id: string) => {
    closeSession(id);
  });

  ipcMain.handle('term.list', () => listTerminalSessions());

  ipcMain.handle('term.attach', (_, id: string) => attachTerminal(id));

  ipcMain.handle('term.setSide', (_, id: string, side: 'my' | 'code') => setSessionSide(id, side));

  ipcMain.handle('term.getPrefs', async () => {
    return (await getTerminalPrefs()) ?? {};
  });

  ipcMain.handle('term.setPrefs', async (_, prefs: unknown) => {
    if (!prefs || typeof prefs !== 'object') {
      throw new Error('term.setPrefs: payload must be an object');
    }
    await setTerminalPrefs(prefs as Parameters<typeof setTerminalPrefs>[0]);
  });

  ipcMain.handle('term.latestScreenshot', async (_, dir: string) => {
    return latestScreenshot(dir);
  });
}
