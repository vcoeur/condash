import { clipboard, ipcMain } from 'electron';
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
import { requireScreenshotDir } from '../path-bounds';
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

  // Read the system clipboard from the main process. The renderer's
  // navigator.clipboard.readText() is permission-gated (no clipboard-read
  // permission handler is wired) and unreliable in Electron, so terminal
  // paste reads through here instead. See xterm-mount.ts's Ctrl+V handler.
  ipcMain.handle('clipboardReadText', () => clipboard.readText());

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
    // Bound the renderer-supplied directory to `terminal.screenshot_dir`
    // from settings — without this a compromised renderer could pass any
    // path through and have us stat it. `requireScreenshotDir` realpaths
    // both sides so a symlinked target outside the configured root is
    // rejected too.
    const canonical = await requireScreenshotDir(dir);
    return latestScreenshot(canonical);
  });
}
