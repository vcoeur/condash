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
  tabsContext,
  writeTerminal,
} from '../terminals';
import { latestScreenshot } from '../screenshot';
import { requireScreenshotDir } from '../path-bounds';
import { readSettings } from '../settings';
import { conceptionConfigSchema } from '../config-schema';
import type { TermSpawnRequest } from '../../shared/types';
import { requireMainWindowSender } from './utils';

// The `terminal` block of the config schema — the same zod shape
// `settings.json` is validated with, reused here so a renderer-supplied
// prefs patch can't persist arbitrary keys (or non-string `shell`, which
// later feeds the pty program) into settings.json.
const terminalPrefsSchema = conceptionConfigSchema.shape.terminal;

/** Wire every term.* IPC handler. Called once from main entry. */
export function registerTerminalIpc(): void {
  ipcMain.handle('termSpawn', async (event, request: TermSpawnRequest) => {
    requireMainWindowSender(event);
    const { lastConceptionPath: conceptionPath } = await readSettings();
    return spawnTerminal(conceptionPath, event.sender, request);
  });

  ipcMain.handle('termWrite', (event, id: string, data: string) => {
    requireMainWindowSender(event);
    writeTerminal(id, data);
  });

  // Read the system clipboard from the main process. The renderer's
  // navigator.clipboard.readText() is permission-gated (no clipboard-read
  // permission handler is wired) and unreliable in Electron, so terminal
  // paste reads through here instead. See xterm-mount.ts's Ctrl+V handler.
  ipcMain.handle('clipboardReadText', (event) => {
    requireMainWindowSender(event);
    return clipboard.readText();
  });

  ipcMain.handle('termResize', (event, id: string, cols: number, rows: number) => {
    requireMainWindowSender(event);
    resizeTerminal(id, cols, rows);
  });

  ipcMain.handle('termClose', (event, id: string) => {
    requireMainWindowSender(event);
    closeSession(id);
  });

  ipcMain.handle('termList', (event) => {
    requireMainWindowSender(event);
    return listTerminalSessions();
  });

  ipcMain.handle('termTabsContext', (event) => {
    requireMainWindowSender(event);
    return tabsContext();
  });

  ipcMain.handle('termAttach', (event, id: string) => {
    requireMainWindowSender(event);
    return attachTerminal(id, event.sender);
  });

  ipcMain.handle('termSetSide', (event, id: string, side: 'my' | 'code') => {
    requireMainWindowSender(event);
    if (side !== 'my' && side !== 'code') {
      throw new Error(`termSetSide: invalid side ${JSON.stringify(side)}`);
    }
    return setSessionSide(id, side);
  });

  ipcMain.handle('termGetPrefs', async (event) => {
    requireMainWindowSender(event);
    return (await getTerminalPrefs()) ?? {};
  });

  ipcMain.handle('termSetPrefs', async (event, prefs: unknown) => {
    requireMainWindowSender(event);
    if (!prefs || typeof prefs !== 'object') {
      throw new Error('termSetPrefs: payload must be an object');
    }
    // Validate the whole nested patch through the config schema before it
    // is persisted — `terminal.shell` becomes the pty program on the next
    // spawn, so a malformed payload must be rejected at this boundary, not
    // discovered at spawn time.
    const parsed = terminalPrefsSchema.safeParse(prefs);
    if (!parsed.success) {
      throw new Error(`termSetPrefs: invalid terminal prefs — ${parsed.error.message}`);
    }
    await setTerminalPrefs(parsed.data ?? {});
  });

  ipcMain.handle('termLatestScreenshot', async (event, dir: string) => {
    requireMainWindowSender(event);
    // Bound the renderer-supplied directory to `terminal.screenshot_dir`
    // from settings — without this a compromised renderer could pass any
    // path through and have us stat it. `requireScreenshotDir` realpaths
    // both sides so a symlinked target outside the configured root is
    // rejected too.
    const canonical = await requireScreenshotDir(dir);
    return latestScreenshot(canonical);
  });
}
