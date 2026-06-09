import { app, dialog, ipcMain, shell } from 'electron';
import { promises as fs } from 'node:fs';
import { basename, parse } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toPosix } from '../../shared/path';
import {
  prependRecent,
  readSettings,
  removeRecent,
  settingsPath,
  updateSettings,
} from '../settings';
import { resolveConceptionConfigPath } from '../effective-config';
import { detectConceptionState, initConception } from '../conception-init';
import { requirePathUnder, requirePathUnderWorkspace } from '../path-bounds';
import { setWatchedConception } from '../watcher';
import { disposeRepoWatchers } from '../repo-watchers';
import { readHelpDoc } from '../help';
import { requireMainWindowSender, requireNonEmptyString } from './utils';

/**
 * Bound a renderer-supplied path for `openPath` / `showInFolder`: it must
 * resolve under one of the workspace roots (active conception +
 * `workspace_path` + `worktrees_path` + configured repo paths), with one
 * exact-file exemption — the per-machine `settings.json`, which the Settings
 * modal's "open externally" affordance targets and which lives under
 * Electron's userData dir, outside every workspace root. Returns the
 * realpath.
 */
async function requireOpenablePath(target: string): Promise<string> {
  try {
    const [real, settingsReal] = await Promise.all([
      fs.realpath(target),
      fs.realpath(settingsPath()),
    ]);
    if (real === settingsReal) return real;
  } catch {
    // settings.json may not exist yet, or the target may not resolve —
    // either way fall through to the workspace bound, which throws the
    // uniform error for unresolvable paths.
  }
  return requirePathUnderWorkspace(target);
}

/**
 * Wire OS-level / shell-out / app-info handlers — anything whose body just
 * plumbs to Electron, the OS shell, or app metadata. Conception path
 * mutation lives here too because the picker dialog and the openExternal
 * filter are both shell-side concerns.
 *
 * `onConceptionPicked` is invoked after the user picks a new conception
 * folder so main entry can refresh the window title.
 */
export function registerSystemIpc(opts: {
  onConceptionPicked: (path: string) => void;
  onRecentsChange?: () => void;
}): void {
  const fireRecentsChange = (): void => {
    opts.onRecentsChange?.();
  };
  // openInEditor accepts an arbitrary path on purpose — this is the user's
  // "open this file in $EDITOR" affordance and the renderer hands it
  // whatever the user picked (resources file, sibling note, log line, …).
  // No workspace bound: a compromised renderer could already exfiltrate
  // anything the renderer-side store holds, and this handler only delegates
  // to `shell.openPath` (no shell expansion, no command injection vector).
  // Trust boundary documented here so a future audit doesn't re-flag it.
  ipcMain.handle('openInEditor', async (event, path: string) => {
    requireMainWindowSender(event);
    requireNonEmptyString('openInEditor', path);
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  });

  ipcMain.handle('getConceptionPath', async (event) => {
    requireMainWindowSender(event);
    const { lastConceptionPath: conceptionPath } = await readSettings();
    return conceptionPath ? toPosix(conceptionPath) : null;
  });

  /**
   * Path to the conception's editable config file. Prefers `condash.json`
   * (canonical) and falls back to `configuration.json` for legacy trees.
   * Returns the canonical path even when neither file exists, so a first
   * save creates `condash.json`.
   */
  ipcMain.handle('getConceptionConfigPath', async (event) => {
    requireMainWindowSender(event);
    const { lastConceptionPath: conceptionPath } = await readSettings();
    if (!conceptionPath) return null;
    return toPosix(await resolveConceptionConfigPath(conceptionPath));
  });

  ipcMain.handle('pdfToFileUrl', async (event, path: string) => {
    requireMainWindowSender(event);
    requireNonEmptyString('pdfToFileUrl', path);
    // Bound the file:// URL to the conception subtree — without this, a
    // compromised renderer can synthesise a webview src for any file on disk
    // (e.g. ~/.ssh/id_rsa) by passing an absolute path. `requirePathUnder`
    // is the one realpath-bound primitive (path-bounds.ts): both sides are
    // realpathed so symlink traversal is defeated, and the returned canonical
    // path is what the URL is built from.
    const { lastConceptionPath: conceptionPath } = await readSettings();
    if (!conceptionPath) {
      throw new Error('pdfToFileUrl: no conception path is set');
    }
    const real = await requirePathUnder(path, conceptionPath);
    return {
      url: pathToFileURL(real).href,
      filename: basename(real),
    };
  });

  ipcMain.handle('detectConceptionState', (event, path: string) => {
    requireMainWindowSender(event);
    requireNonEmptyString('detectConceptionState', path);
    return detectConceptionState(path);
  });

  ipcMain.handle('initConception', async (event, path: string) => {
    requireMainWindowSender(event);
    requireNonEmptyString('initConception', path);
    const created = await initConception(path);
    return { created };
  });

  async function switchConception(picked: string): Promise<void> {
    await updateSettings((cur) => ({
      ...cur,
      lastConceptionPath: picked,
      recentConceptionPaths: prependRecent(cur.recentConceptionPaths, picked),
    }));
    // Tear down repo watchers from the previous conception before re-pointing
    // them; otherwise stale `repo-events` carry paths the renderer no longer
    // tracks until the next listRepos reconciles.
    await disposeRepoWatchers();
    await setWatchedConception(picked);
    opts.onConceptionPicked(picked);
    fireRecentsChange();
  }

  ipcMain.handle('pickConceptionPath', async (event) => {
    requireMainWindowSender(event);
    const result = await dialog.showOpenDialog({
      title: 'Choose conception directory',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const picked = toPosix(result.filePaths[0]);
    await switchConception(picked);
    return picked;
  });

  /**
   * Switch the active conception to one of the recents (e.g. driven by the
   * File → Open Recent menu). Same effect as `pickConceptionPath`'s success
   * branch — promotes the picked path to the head of recents, swaps the
   * watchers, broadcasts. Returns the path so the renderer can re-render
   * against the new conception without a second `getConceptionPath` round-trip.
   */
  ipcMain.handle('openConception', async (event, path: string) => {
    requireMainWindowSender(event);
    requireNonEmptyString('openConception', path);
    // `lastConceptionPath` is the trust root every bounded handler measures
    // against, so this handler must not accept an arbitrary directory from
    // the renderer (a compromised renderer pointing it at `/` would unbound
    // every "bounded" read/write). Realpath the candidate, refuse filesystem
    // roots outright, and require the same conception markers the detector
    // uses everywhere else: a `projects/` tree or one of the three recognised
    // config files. Recents and the picker flow both pass — they reference
    // directories that carry the markers.
    let real: string;
    try {
      real = await fs.realpath(path);
    } catch {
      throw new Error('openConception: path does not resolve');
    }
    if (parse(real).root === real) {
      throw new Error('openConception: refusing a filesystem root');
    }
    const state = await detectConceptionState(real);
    if (!state.pathExists || (!state.hasProjects && !state.hasConfiguration)) {
      throw new Error('openConception: path does not look like a conception');
    }
    const picked = toPosix(real);
    await switchConception(picked);
    return picked;
  });

  ipcMain.handle('getRecentConceptionPaths', async (event) => {
    requireMainWindowSender(event);
    const { recentConceptionPaths } = await readSettings();
    return recentConceptionPaths;
  });

  ipcMain.handle('clearRecentConceptionPaths', async (event) => {
    requireMainWindowSender(event);
    await updateSettings((cur) => ({ ...cur, recentConceptionPaths: [] }));
    fireRecentsChange();
  });

  ipcMain.handle('removeRecentConceptionPath', async (event, path: string) => {
    requireMainWindowSender(event);
    requireNonEmptyString('removeRecentConceptionPath', path);
    await updateSettings((cur) => ({
      ...cur,
      recentConceptionPaths: removeRecent(cur.recentConceptionPaths, path),
    }));
    fireRecentsChange();
  });

  ipcMain.handle('openConceptionDirectory', async (event) => {
    requireMainWindowSender(event);
    const { lastConceptionPath: conceptionPath } = await readSettings();
    if (!conceptionPath) return;
    const error = await shell.openPath(conceptionPath);
    if (error) throw new Error(error);
  });

  ipcMain.handle('openExternal', async (event, target: string) => {
    requireMainWindowSender(event);
    requireNonEmptyString('openExternal', target);
    // shell.openExternal already filters non-http/https on most platforms but
    // we additionally clamp to safe schemes here so a hostile pty can't pop a
    // file:// or jar: handler. Local paths must go through `openPath`.
    if (!/^(https?|mailto):/i.test(target)) {
      throw new Error('openExternal: only http(s)/mailto schemes are allowed');
    }
    await shell.openExternal(target);
  });

  ipcMain.handle('openPath', async (event, target: string) => {
    requireMainWindowSender(event);
    requireNonEmptyString('openPath', target);
    // Reject anything that looks like a URL — the renderer should call
    // openExternal for those.
    if (/^[a-z][a-z0-9+\-.]*:/i.test(target)) {
      throw new Error('openPath: target must be a path, not a URL');
    }
    // Bound to the workspace roots (+ the settings.json exemption) — the
    // legit callers pass the conception config, the global settings.json,
    // and deliverable files (project tree or a configured worktree). Only
    // openInEditor stays an unbounded shell-out, documented in path-bounds.
    const real = await requireOpenablePath(target);
    const error = await shell.openPath(real);
    if (error) throw new Error(error);
  });

  // Reveal a file/dir in the OS file manager, selected in its parent folder.
  // Delegates to Electron's shell (no shell expansion, no command-injection
  // vector) but is still bounded to the workspace roots: the legit callers
  // (tree panes, Logs cards, viewer headers) all pass paths inside the
  // conception or a configured worktree.
  ipcMain.handle('showInFolder', async (event, target: string) => {
    requireMainWindowSender(event);
    requireNonEmptyString('showInFolder', target);
    const real = await requireOpenablePath(target);
    shell.showItemInFolder(real);
  });

  ipcMain.handle('quitApp', (event) => {
    requireMainWindowSender(event);
    app.quit();
  });

  ipcMain.handle('getAppInfo', (event) => {
    requireMainWindowSender(event);
    return {
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
    };
  });

  ipcMain.handle('readHelpDoc', (event, name: string) => {
    requireMainWindowSender(event);
    return readHelpDoc(name);
  });
}
