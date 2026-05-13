import { app, BrowserWindow, net, protocol, shell } from 'electron';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DEFAULT_LAYOUT, readSettings } from './settings';
import { setWatchedConception } from './watcher';
import { disposeRepoWatchers } from './repo-watchers';
import { killAll, migrateTerminalFromConfigIfNeeded } from './terminals';
import { runLogJanitor } from './terminal-logger-janitor';
import { getEffectiveConceptionConfig } from './effective-config';
import { buildMenu, rebuildMenu, rebuildMenuFromSettings, setMenuWindow } from './menu';
import { registerProjectsIpc } from './ipc/projects';
import { registerReposIpc } from './ipc/repos';
import { registerSettingsIpc } from './ipc/settings';
import { registerSystemIpc } from './ipc/system';
import { registerTerminalIpc } from './ipc/terminal';
import { registerLogsIpc } from './ipc/logs';
import { registerTreesIpc } from './ipc/trees';

// Hard flip from v2.14.0: CLI nouns belong on `condash-cli`, not `condash`.
// If a user types a CLI noun on `condash`, error before any GUI init so the
// migration is loud, not silent. The packaged `condash-cli` launcher
// (build/after-pack.cjs) runs the same Electron binary in plain-Node mode
// (ELECTRON_RUN_AS_NODE=1) against the bundled `dist-cli/condash.cjs`, so
// it never reaches this file.
const CLI_NOUNS: ReadonlySet<string> = new Set([
  'projects',
  'knowledge',
  'search',
  'repos',
  'worktrees',
  'audit',
  'dirty',
  'skills',
  'templates',
  'config',
  'help',
]);
function detectCliMisuse(): string | null {
  for (let i = 1; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (!arg) continue;
    if (arg === '--help' || arg === '-h' || arg === '--version' || arg === '-v') {
      return arg;
    }
    if (arg.startsWith('-')) continue;
    return CLI_NOUNS.has(arg) ? arg : null;
  }
  return null;
}
const cliMisuse = detectCliMisuse();
if (cliMisuse !== null) {
  const hint =
    cliMisuse === '--help' || cliMisuse === '-h'
      ? 'condash-cli help'
      : cliMisuse === '--version' || cliMisuse === '-v'
        ? 'condash-cli --version'
        : `condash-cli ${cliMisuse}`;
  process.stderr.write(
    `condash: '${cliMisuse}' is a CLI command, not a GUI option.\n` + `Use \`${hint}\` instead.\n`,
  );
  process.exit(1);
}

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
if (process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland') {
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
const forcedScale = process.env.CONDASH_FORCE_DEVICE_SCALE_FACTOR;
if (forcedScale) {
  app.commandLine.appendSwitch('force-device-scale-factor', forcedScale);
}

// Register a custom scheme for serving local files (images embedded in note
// markdown via relative paths). The renderer is loaded over file:// (prod) or
// http:// (dev), neither of which can resolve cross-directory file:// images
// under our CSP. The custom scheme is restricted to files inside the active
// conception path and is the only way relative-path images surface in note
// view. See `renderMarkdown` for the matching renderer-side rewrite.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'condash-file',
    privileges: { standard: true, supportFetchAPI: true, secure: true, bypassCSP: false },
  },
]);

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
      void shell
        .openExternal(url)
        .catch((err) => console.error('[shell] openExternal failed', url, err));
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) {
      void shell
        .openExternal(url)
        .catch((err) => console.error('[shell] openExternal failed', url, err));
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
 * Serve files referenced from note-view markdown (images via relative path)
 * over a `condash-file:///abs/path` URL. Sandboxed: the requested path must
 * resolve under the current conception path. The renderer rewrites relative
 * `<img src="…">` to this scheme; see `renderer/markdown.ts`.
 */
function registerNoteAssetProtocol(): void {
  protocol.handle('condash-file', async (request) => {
    const url = new URL(request.url);
    // The renderer formats URLs as `condash-file:///<abs-path>` (triple
    // slash, empty host). Chromium's URL parser for standard schemes can't
    // hold an empty host though — it shifts the first path segment into the
    // host slot, so what we get back is `condash-file://<seg0>/<seg1>/…`.
    // Re-stitch host + pathname to recover the original absolute path. Both
    // shapes are decoded individually to handle %-escaped segments uniformly,
    // then joined with the leading `/` re-added by the pathname itself.
    const host = decodeURIComponent(url.host);
    const path = decodeURIComponent(url.pathname);
    const requested = host ? `/${host}${path}` : path;
    const settings = await readSettings();
    const root = settings.lastConceptionPath;
    if (!root) return new Response('no conception path', { status: 403 });
    // Reject `..` traversal at the URL layer before we touch the filesystem.
    // realpath() alone could resolve a symlink that escapes the conception,
    // so this also catches the `<conception>/foo → /etc` symlink case.
    if (requested.split(/[/\\]/).some((seg) => seg === '..')) {
      return new Response('forbidden', { status: 403 });
    }
    // Require the resolved path to live inside the conception tree. This
    // blocks both absolute-path tricks (`condash-file:///etc/passwd`) and
    // `..`-traversal attempts.
    const resolved = await fsp.realpath(requested).catch(() => null);
    const rootResolved = await fsp.realpath(root).catch(() => root);
    if (!resolved || !isPathUnder(resolved, rootResolved)) {
      return new Response('forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(resolved).toString());
  });
}

// `child.startsWith(parent + sep)` test that handles both `/` and `\` so a
// Windows realpath result with backslashes still gets the trailing-separator
// terminator that prevents `/foo-evil/` from matching `/foo`.
function isPathUnder(child: string, parent: string): boolean {
  const trail = (s: string): string => {
    if (s.endsWith('/') || s.endsWith('\\')) return s;
    // sep('\\') only matters on Windows; on POSIX the realpath always uses '/'.
    return process.platform === 'win32' ? s + '\\' : s + '/';
  };
  const c = trail(child);
  const p = trail(parent);
  return c === p || c.startsWith(p);
}

/**
 * Wire every IPC handler. Per-domain modules under `ipc/` own the actual
 * handler bodies; this dispatcher just calls each module's
 * `register*Ipc(opts?)` once at app start. New verbs go in (or alongside)
 * the matching domain module — keep this body a flat list of registrations.
 *
 * The per-domain split:
 *   • projects — listProjects, getProject, step.*, listProjectFiles,
 *     setStatus, createProject, note.*, settings.read/writeRaw,
 *     createProjectNote.
 *   • trees — read{Knowledge,Resources,Skills}Tree, tree.*, search.
 *   • repos — listRepos, listReposForPrimary, invalidateGitStatus,
 *     getDirtyDetails, listOpenWith, launchOpenWith, forceStopRepo.
 *   • settings — theme/layout/welcome/cardMinWidth/treeExpansion/getSettingsPath.
 *   • system — shell-out + app-info + conception path mutation.
 *   • terminal — every term.* verb.
 */
function registerIpc(): void {
  registerProjectsIpc();
  registerTreesIpc();
  registerReposIpc();
  registerTerminalIpc();
  registerLogsIpc();
  registerSettingsIpc({ onLayoutChange: rebuildMenu });
  registerSystemIpc({
    onConceptionPicked: (picked) => {
      updateWindowTitle(picked);
      void rebuildMenuFromSettings();
    },
    onRecentsChange: () => {
      void rebuildMenuFromSettings();
    },
  });
}

app.whenReady().then(async () => {
  registerIpc();
  registerNoteAssetProtocol();
  // One-shot: copy any pre-existing terminal block out of configuration.json
  // and into settings.json. Idempotent — does nothing once settings owns
  // the data. Runs before window creation so the renderer's first
  // termGetPrefs always sees the post-migration state.
  await migrateTerminalFromConfigIfNeeded();
  const settings = await readSettings();
  const conceptionPath = settings.lastConceptionPath;
  await setWatchedConception(conceptionPath);
  // Sweep `.condash/logs/` for expired day-directories. Runs once at
  // startup and on a 24 h interval. Bounded by the effective
  // `terminal.logging.retentionDays` / `maxDirMb` settings; defaults are
  // 14 days / 500 MB.
  if (conceptionPath) {
    void runJanitorSafe(conceptionPath);
    setInterval(() => void runJanitorSafe(conceptionPath), 24 * 60 * 60 * 1000);
  }
  buildMenu(settings.layout ?? DEFAULT_LAYOUT, {
    paths: settings.recentConceptionPaths ?? [],
    current: conceptionPath,
  });
  mainWindow = await createWindow(conceptionPath);
  setMenuWindow(mainWindow);
  mainWindow.on('closed', () => {
    mainWindow = null;
    setMenuWindow(null);
  });

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const settings = await readSettings();
      mainWindow = await createWindow(settings.lastConceptionPath);
      setMenuWindow(mainWindow);
      mainWindow.on('closed', () => {
        mainWindow = null;
        setMenuWindow(null);
      });
    }
  });

  // Auto-update is disabled. The dashboard is installed/upgraded
  // out-of-band (apt / dpkg / make install) so the in-app updater would
  // race against the system package manager; left here as a no-op so
  // electron-updater stays a tracked dependency without firing on launch.
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
  void disposeRepoWatchers();
});

/** Run the terminal-logs janitor for `conceptionPath`. Pulls the
 * effective config so settings-level overrides apply. Errors are
 * swallowed locally — a janitor failure must not crash app start nor
 * propagate into the IPC layer. */
async function runJanitorSafe(conceptionPath: string): Promise<void> {
  try {
    const config = await getEffectiveConceptionConfig(conceptionPath);
    await runLogJanitor(conceptionPath, config.terminal?.logging);
  } catch (err) {
    process.stderr.write(`condash terminal-logs janitor: ${(err as Error).message}\n`);
  }
}
