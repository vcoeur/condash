import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { readSettings, writeSettings } from './settings';
import { findProjectReadmes } from './walk';
import { parseReadme } from './parse';
import { setWatchedConception } from './watcher';
import { setStatus, toggleStep, writeNote } from './mutate';
import { readKnowledgeTree } from './knowledge';
import { readNote } from './note';
import { search } from './search';
import { listRepos } from './repos';
import { forceStopRepo, launchOpenWith, listOpenWith } from './launchers';
import type { OpenWithSlotKey, Project, StepMarker, Theme } from '../shared/types';
import { KNOWN_STATUSES } from '../shared/types';

const THEMES: ReadonlySet<Theme> = new Set(['light', 'dark', 'system']);

const DEV_URL = 'http://localhost:5600';
const isDev = !app.isPackaged;

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
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
