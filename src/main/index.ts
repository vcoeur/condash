import { app, BrowserWindow, ipcMain, Menu, net, protocol, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseHeader } from '../shared/header';

import { DEFAULT_LAYOUT, readSettings } from './settings';
import { findProjectReadmes } from './walk';
import { parseReadme } from './parse';
import { setWatchedConception } from './watcher';
import { addStep, editStepText, transitionStatus, toggleStep, writeNote } from './mutate';
import { createProjectCore } from '../cli/commands/projects';
import { checkBranchState } from './worktree-ops';
import { listProjectFiles } from './files';
import { readKnowledgeTree } from './knowledge';
import { readResourcesTree } from './resources';
import { readSkillsTree } from './skills';
import { resolveConceptionPaths } from './conception-paths';
import { createProjectNote, readNote } from './note';
import { search } from './search';
import { listRepos, listReposForPrimary } from './repos';
import { invalidateAll } from './git-status-cache';
import {
  disposeRepoWatchers,
  recomputeAllWatchedRepos,
  setRepoWatchers,
  watchTargetsFromRepos,
} from './repo-watchers';
import { getDirtyDetails } from './git-details';
import { forceStopRepo, launchOpenWith, listOpenWith } from './launchers';
import { killAll, migrateTerminalFromConfigIfNeeded } from './terminals';
import { registerTerminalIpc } from './ipc/terminal';
import { registerSettingsIpc } from './ipc/settings';
import { registerSystemIpc } from './ipc/system';
import type {
  LayoutState,
  OpenWithSlotKey,
  Project,
  ProjectCreateInput,
  ProjectCreateResult,
  StepMarker,
} from '../shared/types';
import { statusOrder } from '../shared/projects';

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
  'audit',
  'dirty',
  'skills',
  'config',
  'help',
]);
function isCliInvocation(): boolean {
  for (let i = 1; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (!arg) continue;
    // Top-level --help / --version / short forms are CLI signals — they
    // should print the CLI's help/version text, not open the GUI.
    if (arg === '--help' || arg === '-h' || arg === '--version' || arg === '-v') {
      return true;
    }
    if (arg.startsWith('-')) continue;
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

// Register a custom scheme for serving local files (images embedded in note
// markdown via relative paths). The renderer is loaded over file:// (prod) or
// http:// (dev), neither of which can resolve cross-directory file:// images
// under our CSP. The custom scheme is restricted to files inside the active
// conception path and is the only way relative-path images surface in note
// view. See `renderMarkdown` for the matching renderer-side rewrite.
if (!IS_CLI) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'condash-file',
      privileges: { standard: true, supportFetchAPI: true, secure: true, bypassCSP: false },
    },
  ]);
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
      label: 'Show Resources',
      type: 'checkbox',
      checked: layout.working === 'resources',
      accelerator: 'CommandOrControl+R',
      click: () => send('show-resources'),
    },
    {
      label: 'Show Skills',
      type: 'checkbox',
      checked: layout.working === 'skills',
      accelerator: 'CommandOrControl+L',
      click: () => send('show-skills'),
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
    {
      role: 'reload',
      label: 'Reload window',
      // Reload normally lives at Ctrl+R, but we hand that accelerator to the
      // Resources panel (more useful in day-to-day work). Reload moves to
      // Ctrl+Shift+R, which still aligns with browser muscle memory for
      // a hard reload.
      accelerator: 'CommandOrControl+Shift+R',
    },
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
    { label: 'Welcome', click: () => send('help-welcome') },
    { label: 'Quick start', click: () => send('help-quick-start') },
    { label: 'Keyboard shortcuts', click: () => send('help-shortcuts') },
    { type: 'separator' },
    { label: 'Configuration', click: () => send('help-configuration') },
    { label: 'CLI overview', click: () => send('help-cli') },
    { label: 'Why Markdown-first', click: () => send('help-why-markdown') },
    { type: 'separator' },
    {
      label: 'Open documentation site',
      click: () => {
        void shell.openExternal('https://condash.vcoeur.com');
      },
    },
    {
      label: 'Open issue tracker',
      click: () => {
        void shell.openExternal('https://github.com/vcoeur/condash/issues');
      },
    },
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

async function readBranchFromReadme(readmePath: string): Promise<string | null> {
  try {
    const raw = await fsp.readFile(readmePath, 'utf8');
    return parseHeader(raw).branch;
  } catch {
    return null;
  }
}

async function touchDirtyMarker(
  conceptionPath: string,
  tree: 'projects' | 'knowledge',
): Promise<void> {
  const path = join(conceptionPath, tree, '.index-dirty');
  try {
    await fsp.utimes(path, new Date(), new Date());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await fsp.writeFile(path, '', 'utf8');
    } else throw err;
  }
}

function buildBranchWarning(
  branch: string,
  lingeringWorktrees: { expectedWorktree: string }[],
  lingeringBranches: { name: string }[],
): string {
  const parts: string[] = [];
  if (lingeringWorktrees.length > 0) {
    const paths = lingeringWorktrees.map((r) => r.expectedWorktree).join(', ');
    parts.push(`worktree(s) still on disk at ${paths}`);
  }
  if (lingeringBranches.length > 0) {
    const repos = lingeringBranches.map((r) => r.name).join(', ');
    parts.push(`local branch '${branch}' still exists in ${repos}`);
  }
  return `${parts.join('; ')} — run \`condash worktrees remove ${branch}\` then \`git branch -d ${branch}\` to clean up.`;
}

async function getProject(path: string): Promise<Project | null> {
  try {
    return await parseReadme(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
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
    const root = settings.conceptionPath;
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

function registerIpc(): void {
  ipcMain.handle('listProjects', () => listProjects());

  ipcMain.handle('getProject', (_, path: string) => getProject(path));

  ipcMain.handle('readKnowledgeTree', async () => {
    const { conceptionPath } = await readSettings();
    if (!conceptionPath) return null;
    return readKnowledgeTree(conceptionPath);
  });

  ipcMain.handle('readResourcesTree', async () => {
    const { conceptionPath } = await readSettings();
    if (!conceptionPath) return null;
    const { resources } = await resolveConceptionPaths(conceptionPath);
    return readResourcesTree(conceptionPath, resources);
  });

  ipcMain.handle('readSkillsTree', async () => {
    const { conceptionPath } = await readSettings();
    if (!conceptionPath) return null;
    const { skills } = await resolveConceptionPaths(conceptionPath);
    return readSkillsTree(conceptionPath, skills);
  });

  ipcMain.handle('search', async (_, query: string) => {
    const { conceptionPath } = await readSettings();
    if (!conceptionPath) return [];
    return search(conceptionPath, query);
  });

  ipcMain.handle('listRepos', async () => {
    const { conceptionPath } = await readSettings();
    if (!conceptionPath) return [];
    const repos = await listRepos(conceptionPath);
    // Sync the per-repo FS watchers to the live repo set: a config edit
    // that adds or removes a repo is reflected here, since this handler
    // re-runs on every renderer-driven repos refresh.
    await setRepoWatchers(watchTargetsFromRepos(repos));
    return repos;
  });

  // Per-primary partial reload — driven by the structural FS watcher when
  // `.git/HEAD` or `.git/worktrees/` changes. Returns the primary's
  // RepoEntry plus its submodule children, freshly re-read. Watchers are
  // re-synced for the affected paths so a freshly-added worktree gets a
  // scalar watcher pair right away (and a freshly-removed one is dropped).
  ipcMain.handle('listReposForPrimary', async (_, primaryName: string) => {
    const { conceptionPath } = await readSettings();
    if (!conceptionPath) return [];
    const entries = await listReposForPrimary(conceptionPath, primaryName);
    // Re-list the *full* watcher set: the simplest correct way to make sure
    // an added or removed worktree under this primary is reflected in the
    // watch set without diffing the per-primary subset against the global
    // one. The cost is one extra `listRepos` call on a structural event,
    // which is rare (worktree mutation, branch checkout) — far cheaper
    // than getting the watch-set delta logic wrong.
    const repos = await listRepos(conceptionPath);
    await setRepoWatchers(watchTargetsFromRepos(repos));
    return entries;
  });

  // Drop the per-worktree git status cache + force-recompute every watched
  // repo and broadcast `repo-events`. Wired to the renderer's F5 / Refresh
  // path so the user sees fresh counts without waiting for an FS event,
  // and without the renderer needing to refetch the whole repo list (which
  // would tear down dropdowns/popovers).
  ipcMain.handle('invalidateGitStatus', async () => {
    invalidateAll();
    await recomputeAllWatchedRepos();
  });

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

  registerTerminalIpc();
  registerSettingsIpc({ onLayoutChange: buildMenu });
  registerSystemIpc({ onConceptionPicked: updateWindowTitle });

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

  ipcMain.handle(
    'setStatus',
    async (_, path: string, newStatus: string, opts?: { summary?: string }) => {
      const result = await transitionStatus(path, newStatus, opts);
      // Touch the dirty marker so a follow-up `condash projects index` is
      // surfaced. Best-effort: if the conception path isn't set we just
      // skip it — the in-memory list rebuild still happens via the watcher.
      const { conceptionPath } = await readSettings();
      if (conceptionPath) {
        await touchDirtyMarker(conceptionPath, 'projects').catch((err) => {
          console.error('[setStatus] touchDirtyMarker failed', err);
        });
        // On close (done-edge: prev !== done, new === done), surface any
        // leftover-branch warnings so the GUI can toast them — silently
        // swallowing the miss let the same broken cleanup ship twice in
        // April. Keep the call best-effort so a failed probe never blocks
        // the close itself.
        if (result.timelineAppended && /^- .* — Closed/.test(result.timelineAppended)) {
          const branch = await readBranchFromReadme(path);
          if (branch) {
            try {
              const state = await checkBranchState(conceptionPath, branch);
              const lingeringWorktrees = state.repos.filter((r) => r.worktreeExists);
              const lingeringBranches = state.repos.filter((r) => r.localBranchExists);
              if (lingeringWorktrees.length > 0 || lingeringBranches.length > 0) {
                result.branchWarning = buildBranchWarning(
                  branch,
                  lingeringWorktrees,
                  lingeringBranches,
                );
              }
            } catch {
              // Best-effort probe — never block the close on its own failure.
            }
          }
        }
      }
      return result;
    },
  );

  ipcMain.handle(
    'createProject',
    async (_, input: ProjectCreateInput): Promise<ProjectCreateResult> => {
      const { conceptionPath } = await readSettings();
      if (!conceptionPath) throw new Error('No conception path set');
      const result = await createProjectCore(conceptionPath, {
        kind: input.kind,
        slug: input.slug,
        title: input.title,
        // Apps stays empty for the GUI quick-create form; users fill it in
        // by editing the README or via the popup.
        apps: [],
        branch: null,
        base: null,
        severity: input.severity ?? null,
        severityImpact: input.severityImpact ?? null,
        environment: input.environment ?? null,
      });
      // The renderer asked for status `now | review | later | backlog`, but
      // createProjectCore always renders `Status: now`. If the user picked
      // anything else, flip it now via the same transitionStatus primitive
      // — that keeps the status-write path single-source.
      if (input.status !== 'now') {
        await transitionStatus(result.readme, input.status);
      }
      return {
        slug: result.slug,
        path: result.path,
        relPath: result.relPath,
        readme: result.readme,
      };
    },
  );

  ipcMain.handle('note.read', (_, path: string) => readNote(path));

  ipcMain.handle('note.write', (_, path: string, expectedContent: string, newContent: string) =>
    writeNote(path, expectedContent, newContent),
  );

  ipcMain.handle('project.createNote', async (_, projectPath: string, slug: string) => {
    return createProjectNote(projectPath, slug);
  });
}

if (!IS_CLI)
  app.whenReady().then(async () => {
    registerIpc();
    registerNoteAssetProtocol();
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

    // Auto-update is disabled. The dashboard is installed/upgraded
    // out-of-band (apt / dpkg / make install) so the in-app updater would
    // race against the system package manager; left here as a no-op so
    // electron-updater stays a tracked dependency without firing on launch.
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
    void disposeRepoWatchers();
  });
}
