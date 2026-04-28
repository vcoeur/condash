import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import { join } from 'node:path';

import { readSettings, writeSettings } from './settings';
import { findProjectReadmes } from './walk';
import { parseReadme } from './parse';
import { setWatchedConception } from './watcher';
import { addStep, editStepText, setStatus, toggleStep, writeNote } from './mutate';
import { listProjectFiles } from './files';
import { readKnowledgeTree } from './knowledge';
import { readNote } from './note';
import { search } from './search';
import { listRepos } from './repos';
import { invalidateAll } from './git-status-cache';
import { forceStopRepo, launchOpenWith, listOpenWith } from './launchers';
import {
  attachTerminal,
  closeSession,
  getTerminalPrefs,
  killAll,
  listTerminalSessions,
  resizeTerminal,
  setSessionSide,
  spawnTerminal,
  writeTerminal,
} from './terminals';
import { latestScreenshot } from './screenshot';
import { readHelpDoc } from './help';
import type {
  OpenWithSlotKey,
  Project,
  StepMarker,
  TermSpawnRequest,
  Theme,
} from '../shared/types';
import { KNOWN_STATUSES } from '../shared/types';

const THEMES: ReadonlySet<Theme> = new Set(['light', 'dark', 'system']);

const DEV_URL = 'http://localhost:5600';
// Treat the build as "dev" when not packaged AND not explicitly forced into
// production mode. CONDASH_FORCE_PROD=1 is set by the Playwright fixture so
// tests load the real file:// build instead of the Vite dev URL.
const isDev = !app.isPackaged && process.env.CONDASH_FORCE_PROD !== '1';

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#1a1a1a',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // <webview> is used for the in-modal PDF viewer. The webview is sandboxed
      // separately and only loads `file://` URLs we control.
      webviewTag: true,
    },
  });

  win.once('ready-to-show', () => win.show());

  if (isDev) {
    await win.loadURL(DEV_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    await win.loadFile(join(__dirname, '../../dist/index.html'));
  }

  return win;
}

function statusOrder(status: string): number {
  const idx = (KNOWN_STATUSES as readonly string[]).indexOf(status);
  return idx === -1 ? KNOWN_STATUSES.length : idx;
}

async function listProjects(): Promise<Project[]> {
  const { conceptionPath } = await readSettings();
  if (!conceptionPath) return [];

  const readmes = await findProjectReadmes(conceptionPath);
  const projects = await Promise.all(readmes.map(parseReadme));

  return projects.sort((a, b) => {
    const o = statusOrder(a.status) - statusOrder(b.status);
    if (o !== 0) return o;
    return a.slug.localeCompare(b.slug);
  });
}

async function getProject(path: string): Promise<Project | null> {
  try {
    return await parseReadme(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function registerIpc(): void {
  ipcMain.handle('listProjects', () => listProjects());

  ipcMain.handle('getProject', (_, path: string) => getProject(path));

  ipcMain.handle('readKnowledgeTree', async () => {
    const { conceptionPath } = await readSettings();
    if (!conceptionPath) return null;
    return readKnowledgeTree(conceptionPath);
  });

  ipcMain.handle('search', async (_, query: string) => {
    const { conceptionPath } = await readSettings();
    if (!conceptionPath) return [];
    return search(conceptionPath, query);
  });

  ipcMain.handle('listRepos', async () => {
    const { conceptionPath } = await readSettings();
    if (!conceptionPath) return [];
    return listRepos(conceptionPath);
  });

  // Drop the per-worktree git status cache. Wired to the renderer's Refresh
  // button so explicit user requests always see fresh data, while ambient
  // re-renders (tab switch, tree-events) still benefit from the TTL cache.
  ipcMain.handle('invalidateGitStatus', () => invalidateAll());

  ipcMain.handle('listOpenWith', async () => {
    const { conceptionPath } = await readSettings();
    if (!conceptionPath) return {};
    return listOpenWith(conceptionPath);
  });

  ipcMain.handle('launchOpenWith', async (_, slot: OpenWithSlotKey, path: string) => {
    const { conceptionPath } = await readSettings();
    if (!conceptionPath) throw new Error('No conception path set');
    return launchOpenWith(conceptionPath, slot, path);
  });

  ipcMain.handle('forceStopRepo', async (_, repoName: string) => {
    const { conceptionPath } = await readSettings();
    if (!conceptionPath) throw new Error('No conception path set');
    return forceStopRepo(conceptionPath, repoName);
  });

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
    const { conceptionPath } = await readSettings();
    return (await getTerminalPrefs(conceptionPath)) ?? {};
  });

  ipcMain.handle('term.latestScreenshot', async (_, dir: string) => {
    return latestScreenshot(dir);
  });

  ipcMain.handle('helpReadDoc', (_, name: string) => readHelpDoc(name));

  ipcMain.handle('openInEditor', async (_, path: string) => {
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  });

  ipcMain.handle('getConceptionPath', async () => {
    const { conceptionPath } = await readSettings();
    return conceptionPath;
  });

  ipcMain.handle('getTheme', async () => {
    const { theme } = await readSettings();
    return theme;
  });

  ipcMain.handle('setTheme', async (_, theme: Theme) => {
    if (!THEMES.has(theme)) throw new Error(`Unknown theme: ${theme}`);
    const next = await readSettings();
    next.theme = theme;
    await writeSettings(next);
  });

  ipcMain.handle(
    'toggleStep',
    (_, path: string, lineIndex: number, expectedMarker: StepMarker, newMarker: StepMarker) =>
      toggleStep(path, lineIndex, expectedMarker, newMarker),
  );

  ipcMain.handle(
    'editStepText',
    (_, path: string, lineIndex: number, expectedText: string, newText: string) =>
      editStepText(path, lineIndex, expectedText, newText),
  );

  ipcMain.handle('addStep', (_, path: string, text: string) => addStep(path, text));

  ipcMain.handle('listProjectFiles', (_, path: string) => listProjectFiles(path));

  ipcMain.handle('setStatus', (_, path: string, newStatus: string) => setStatus(path, newStatus));

  ipcMain.handle('readNote', (_, path: string) => readNote(path));

  ipcMain.handle('writeNote', (_, path: string, expectedContent: string, newContent: string) =>
    writeNote(path, expectedContent, newContent),
  );

  ipcMain.handle('pickConceptionPath', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose conception directory',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const picked = result.filePaths[0];
    const next = await readSettings();
    next.conceptionPath = picked;
    await writeSettings(next);
    await setWatchedConception(picked);
    return picked;
  });
}

app.whenReady().then(async () => {
  registerIpc();
  const { conceptionPath } = await readSettings();
  await setWatchedConception(conceptionPath);
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Auto-update: only in packaged builds. electron-updater pulls
  // latest{,-mac,-linux}.yml from the GitHub Release matching package.json's
  // version. Failures (no network, GH down, no newer release) log and
  // exit silently — never block app startup.
  if (app.isPackaged) {
    autoUpdater.autoDownload = true;
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.warn('[updater]', err);
    });
  }
});

app.on('window-all-closed', () => {
  void killAll();
  if (process.platform !== 'darwin') app.quit();
});

// Cmd-Q on macOS bypasses window-all-closed; before-quit covers it. Linux/
// Windows hit before-quit too, so killAll runs idempotent-cheap on the
// already-empty session map there.
app.on('before-quit', () => {
  void killAll();
});
