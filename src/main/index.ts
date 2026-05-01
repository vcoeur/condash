import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { autoUpdater } from 'electron-updater';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { toPosix } from '../shared/path';

import { detectConceptionState, initConception } from './conception-init';
import { DEFAULT_LAYOUT, readSettings, settingsPath, writeSettings } from './settings';
import { findProjectReadmes } from './walk';
import { parseReadme } from './parse';
import { setWatchedConception } from './watcher';
import { addStep, editStepText, setStatus, toggleStep, writeNote } from './mutate';
import { listProjectFiles } from './files';
import { readKnowledgeTree } from './knowledge';
import { createProjectNote, readNote } from './note';
import { search } from './search';
import { listRepos } from './repos';
import { invalidateAll } from './git-status-cache';
import { getDirtyDetails } from './git-details';
import { forceStopRepo, launchOpenWith, listOpenWith } from './launchers';
import {
  attachTerminal,
  closeSession,
  getTerminalPrefs,
  killAll,
  listTerminalSessions,
  migrateTerminalFromConfigIfNeeded,
  resizeTerminal,
  setSessionSide,
  setTerminalPrefs,
  spawnTerminal,
  writeTerminal,
} from './terminals';
import { latestScreenshot } from './screenshot';
import { readHelpDoc } from './help';
import type {
  LayoutState,
  OpenWithSlotKey,
  Project,
  StepMarker,
  TermSpawnRequest,
  Theme,
} from '../shared/types';
import { KNOWN_STATUSES } from '../shared/types';

// CLI dispatch — when invoked with a known noun (e.g. `condash projects list`),
// short-circuit the GUI and route through the CLI bundle instead. The packaged
// `condash` binary on PATH is the same launcher whether the user wants the
// dashboard or a CLI call; detecting here means a deb / AppImage install
// works for both without a separate `condash-cli` binary.
//
// Detection rule: scan args for the first non-flag token; if it's a CLI noun,
// we're in CLI mode. Electron's own switches (--no-sandbox, --enable-features
// from afterPack, …) start with `-` and are skipped.
const CLI_NOUNS: ReadonlySet<string> = new Set([
  'projects',
  'knowledge',
  'search',
  'repos',
  'worktrees',
  'dirty',
  'skills',
  'config',
  'help',
]);
function isCliInvocation(): boolean {
  for (let i = 1; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (!arg || arg.startsWith('-')) continue;
    return CLI_NOUNS.has(arg);
  }
  return false;
}
const IS_CLI = isCliInvocation();
if (IS_CLI) {
  // dist-cli/condash.cjs is a sibling of dist-electron/. From this file
  // (dist-electron/main/index.js post-build), `../../dist-cli/condash.cjs`
  // resolves to that bundle in both dev and packaged builds. The CLI sets
  // process.exitCode itself when its async dispatcher resolves; we leave
  // node running until the promise settles, and we gate every Electron-
  // side-effect block below on !IS_CLI so no window ever opens.
  //
  // The require path is constructed at runtime — a literal
  // `require('../../dist-cli/condash.cjs')` would be statically followed
  // by esbuild and the entire CLI bundle would be inlined into this main
  // bundle, which (a) doubles the file size and (b) breaks every
  // `__dirname`-based lookup inside the CLI (the CLI walks up from its
  // own __dirname to find conception-template/, so it must be loaded
  // from its own file).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(`${__dirname}/../../dist-cli/condash.cjs`);
}

const THEMES: ReadonlySet<Theme> = new Set(['light', 'dark', 'system']);

// Wayland fractional-scaling fix.
//
// Without these flags, Electron renders at integer scale (1x) and the Wayland
// compositor up-scales the pixel buffer to the real fractional scale (1.25,
// 1.5, …) — text and icons end up blurry. The fix is twofold:
//
// 1. Force the Wayland Ozone backend so Chromium talks the Wayland protocols
//    directly (vs. running through XWayland, which always blits at 1x).
// 2. Enable WaylandFractionalScaleV1 + WaylandPerSurfaceScale so Chromium
//    negotiates wp_fractional_scale_v1 with the compositor and renders the
//    real scale per-surface.
//
// We only apply this when XDG_SESSION_TYPE=wayland — on X11 Linux sessions,
// forcing the Wayland backend would crash. The flags MUST be appended before
// app.whenReady(); putting them at module-top makes that obvious.
//
// Override hatch: CONDASH_FORCE_DEVICE_SCALE_FACTOR=<n> falls back to a fixed
// integer scale (Chromium then renders at that scale and the compositor
// down-scales) — useful as a last-ditch escape if a specific compositor still
// renders blurry.
if (!IS_CLI && process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland') {
  // Strongly prefer native Wayland over XWayland — XWayland always blits at
  // integer scale, which produces blurry text on fractional-scaled monitors
  // (1.25, 1.5, …). The `wayland` hint (vs. `auto`) is more reliable in
  // Electron 33 when both DISPLAY and WAYLAND_DISPLAY are exported. We also
  // set ELECTRON_OZONE_PLATFORM_HINT in package.json's dev script as a
  // belt-and-suspenders — some Electron paths read the env earlier than the
  // cmdline switch.
  app.commandLine.appendSwitch('ozone-platform-hint', 'wayland');
  app.commandLine.appendSwitch(
    'enable-features',
    'UseOzonePlatform,WaylandFractionalScaleV1,WaylandWindowDecorations',
  );
}
const forcedScale = !IS_CLI ? process.env.CONDASH_FORCE_DEVICE_SCALE_FACTOR : undefined;
if (forcedScale) {
  app.commandLine.appendSwitch('force-device-scale-factor', forcedScale);
}

const DEV_URL = 'http://localhost:5600';
// Treat the build as "dev" when not packaged AND not explicitly forced into
// production mode. CONDASH_FORCE_PROD=1 is set by the Playwright fixture so
// tests load the real file:// build instead of the Vite dev URL.
const isDev = !app.isPackaged && process.env.CONDASH_FORCE_PROD !== '1';

let mainWindow: BrowserWindow | null = null;

function windowTitleFor(path: string | null): string {
  return path ? `Condash - ${path}` : 'Condash';
}

function updateWindowTitle(path: string | null): void {
  if (!mainWindow) return;
  mainWindow.setTitle(windowTitleFor(path));
}

async function createWindow(initialPath: string | null): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#1a1a1a',
    show: false,
    title: windowTitleFor(initialPath),
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

  // Electron resets the title to the page <title> on load — pin our path-aware
  // title against any such update.
  win.on('page-title-updated', (event) => {
    event.preventDefault();
  });

  // Defensive backstop: a stray <a href> click in rendered markdown must never
  // replace the renderer with a blank file:// page. The renderer-side click
  // routers in note-modal / help-modal handle every link type explicitly; this
  // catches anything that slips through and routes http(s)/mailto out to the
  // OS browser instead of letting Chromium navigate the BrowserWindow itself.
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (/^(https?|mailto):/i.test(url)) {
      void shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
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

/**
 * Build the application menu. The View submenu mirrors the unified
 * layout's pane-visibility state — Show/Hide Projects + Show/Hide
 * Terminal as toggles, plus a three-state group (Code | Knowledge |
 * neither) for the right-slot working surface. Pass the current layout
 * so check marks line up with what's actually shown; rebuild the menu
 * after any layout change so the marks refresh. No Quit accelerator on
 * purpose: Ctrl+Q is too easy to hit by accident, and File → Quit
 * routes through a renderer-side confirmation modal anyway.
 */
function buildMenu(layout: LayoutState = DEFAULT_LAYOUT): void {
  const send = (command: string): void => {
    mainWindow?.webContents.send('menu-command', command);
  };

  const fileSubmenu: MenuItemConstructorOptions[] = [
    {
      label: 'Open…',
      accelerator: 'CommandOrControl+O',
      click: () => send('open-folder'),
    },
    {
      label: 'Open conception directory',
      click: () => send('open-conception'),
    },
    { type: 'separator' },
    {
      label: 'Settings',
      accelerator: 'CommandOrControl+,',
      click: () => send('open-settings'),
    },
    {
      label: 'Search…',
      accelerator: 'CommandOrControl+Shift+F',
      click: () => send('search'),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      // No accelerator on purpose — see the comment above buildMenu().
      click: () => send('request-quit'),
    },
  ];

  const viewSubmenu: MenuItemConstructorOptions[] = [
    {
      label: 'Show Projects',
      type: 'checkbox',
      checked: layout.projects,
      click: () => send('toggle-projects'),
    },
    {
      label: 'Show Code',
      type: 'checkbox',
      checked: layout.working === 'code',
      click: () => send('show-code'),
    },
    {
      label: 'Show Knowledge',
      type: 'checkbox',
      checked: layout.working === 'knowledge',
      click: () => send('show-knowledge'),
    },
    {
      label: 'Hide working surface',
      enabled: layout.working !== null,
      click: () => send('hide-working'),
    },
    {
      label: 'Show Terminal',
      type: 'checkbox',
      checked: layout.terminal,
      accelerator: 'CommandOrControl+`',
      click: () => send('toggle-terminal'),
    },
    { type: 'separator' },
    {
      label: 'Refresh',
      accelerator: 'F5',
      click: () => send('refresh'),
    },
    { type: 'separator' },
    { role: 'reload', label: 'Reload window' },
    { role: 'toggleDevTools' },
    { type: 'separator' },
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ];

  const helpSubmenu: MenuItemConstructorOptions[] = [
    {
      label: 'About Condash',
      click: () => send('about'),
    },
    { type: 'separator' },
    { label: 'Architecture', click: () => send('help-architecture') },
    { label: 'Configuration reference', click: () => send('help-configuration') },
    { label: 'Non-goals', click: () => send('help-non-goals') },
    { label: 'Documentation index', click: () => send('help-index') },
  ];

  const template: MenuItemConstructorOptions[] = [
    { label: 'File', submenu: fileSubmenu },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    { label: 'View', submenu: viewSubmenu },
    { label: 'Help', role: 'help', submenu: helpSubmenu },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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

  // Click-to-inspect on the per-branch dirty badge. Returns the parsed
  // `git status` line set + a `git diff --stat HEAD` snippet so the user
  // can see what's dirty without dropping into a shell.
  ipcMain.handle('getDirtyDetails', (_, path: string, opts?: { scopeToSubtree?: boolean }) =>
    getDirtyDetails(path, opts ?? {}),
  );

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

  ipcMain.handle('help.readDoc', (_, name: string) => readHelpDoc(name));

  ipcMain.handle('openInEditor', async (_, path: string) => {
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  });

  ipcMain.handle('getConceptionPath', async () => {
    const { conceptionPath } = await readSettings();
    return conceptionPath ? toPosix(conceptionPath) : null;
  });

  ipcMain.handle('pdf.toFileUrl', (_, path: string) => {
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error('pdf.toFileUrl: path must be a non-empty string');
    }
    return {
      url: pathToFileURL(path).href,
      filename: basename(path),
    };
  });

  ipcMain.handle('getTheme', async () => {
    const { theme } = await readSettings();
    return theme;
  });

  ipcMain.handle('getSettingsPath', () => toPosix(settingsPath()));

  ipcMain.handle('setTheme', async (_, theme: Theme) => {
    if (!THEMES.has(theme)) throw new Error(`Unknown theme: ${theme}`);
    const next = await readSettings();
    next.theme = theme;
    await writeSettings(next);
  });

  ipcMain.handle('getLayout', async () => {
    const { layout } = await readSettings();
    return layout ?? DEFAULT_LAYOUT;
  });

  ipcMain.handle('setLayout', async (_, layout: LayoutState) => {
    const next = await readSettings();
    next.layout = layout;
    await writeSettings(next);
    // Application menu reflects layout state — rebuild so the View
    // submenu's check marks line up with the new state.
    buildMenu(layout);
  });

  ipcMain.handle(
    'step.toggle',
    (_, path: string, lineIndex: number, expectedMarker: StepMarker, newMarker: StepMarker) =>
      toggleStep(path, lineIndex, expectedMarker, newMarker),
  );

  ipcMain.handle(
    'step.editText',
    (_, path: string, lineIndex: number, expectedText: string, newText: string) =>
      editStepText(path, lineIndex, expectedText, newText),
  );

  ipcMain.handle('step.add', (_, path: string, text: string) => addStep(path, text));

  ipcMain.handle('listProjectFiles', (_, path: string) => listProjectFiles(path));

  ipcMain.handle('setStatus', (_, path: string, newStatus: string) => setStatus(path, newStatus));

  ipcMain.handle('note.read', (_, path: string) => readNote(path));

  ipcMain.handle('note.write', (_, path: string, expectedContent: string, newContent: string) =>
    writeNote(path, expectedContent, newContent),
  );

  ipcMain.handle('detectConceptionState', (_, path: string) => detectConceptionState(path));

  ipcMain.handle('initConception', async (_, path: string) => {
    const created = await initConception(path);
    return { created };
  });

  ipcMain.handle('pickConceptionPath', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose conception directory',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const picked = toPosix(result.filePaths[0]);
    const next = await readSettings();
    next.conceptionPath = picked;
    await writeSettings(next);
    await setWatchedConception(picked);
    updateWindowTitle(picked);
    return picked;
  });

  ipcMain.handle('openConceptionDirectory', async () => {
    const { conceptionPath } = await readSettings();
    if (!conceptionPath) return;
    const error = await shell.openPath(conceptionPath);
    if (error) throw new Error(error);
  });

  ipcMain.handle('openExternal', async (_, target: string) => {
    if (typeof target !== 'string' || target.length === 0) return;
    // shell.openExternal already filters non-http/https on most platforms but
    // we additionally clamp to safe schemes here so a hostile pty can't pop a
    // file:// or jar: handler.
    if (!/^(https?|mailto):/i.test(target)) return;
    await shell.openExternal(target);
  });

  ipcMain.handle('project.createNote', async (_, projectPath: string, slug: string) => {
    return createProjectNote(projectPath, slug);
  });

  ipcMain.handle('quitApp', () => {
    app.quit();
  });

  ipcMain.handle('getAppInfo', () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
  }));
}

if (!IS_CLI)
  app.whenReady().then(async () => {
    registerIpc();
    // One-shot: copy any pre-existing terminal block out of configuration.json
    // and into settings.json. Idempotent — does nothing once settings owns
    // the data. Runs before window creation so the renderer's first
    // term.getPrefs always sees the post-migration state.
    await migrateTerminalFromConfigIfNeeded();
    const { conceptionPath, layout } = await readSettings();
    await setWatchedConception(conceptionPath);
    buildMenu(layout ?? DEFAULT_LAYOUT);
    mainWindow = await createWindow(conceptionPath);
    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        const settings = await readSettings();
        mainWindow = await createWindow(settings.conceptionPath);
        mainWindow.on('closed', () => {
          mainWindow = null;
        });
      }
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

if (!IS_CLI) {
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
}
