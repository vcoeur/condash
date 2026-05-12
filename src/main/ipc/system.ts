import { app, dialog, ipcMain, shell } from 'electron';
import { promises as fs } from 'node:fs';
import { basename, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toPosix } from '../../shared/path';
import { prependRecent, readSettings, removeRecent, updateSettings } from '../settings';
import { resolveConceptionConfigPath } from '../effective-config';
import { detectConceptionState, initConception } from '../conception-init';
import { setWatchedConception } from '../watcher';
import { disposeRepoWatchers } from '../repo-watchers';
import { readHelpDoc } from '../help';

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
  ipcMain.handle('openInEditor', async (_, path: string) => {
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  });

  ipcMain.handle('getConceptionPath', async () => {
    const { lastConceptionPath: conceptionPath } = await readSettings();
    return conceptionPath ? toPosix(conceptionPath) : null;
  });

  /**
   * Path to the conception's editable config file. Prefers `condash.json`
   * (canonical) and falls back to `configuration.json` for legacy trees.
   * Returns the canonical path even when neither file exists, so a first
   * save creates `condash.json`.
   */
  ipcMain.handle('getConceptionConfigPath', async () => {
    const { lastConceptionPath: conceptionPath } = await readSettings();
    if (!conceptionPath) return null;
    return toPosix(await resolveConceptionConfigPath(conceptionPath));
  });

  ipcMain.handle('pdfToFileUrl', async (_, path: string) => {
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error('pdfToFileUrl: path must be a non-empty string');
    }
    // Bound the file:// URL to the conception subtree — without this, a
    // compromised renderer can synthesise a webview src for any file on disk
    // (e.g. ~/.ssh/id_rsa) by passing an absolute path. Resolve via realpath
    // to defeat symlink traversal. Both paths are realpathed together (in
    // parallel) so the window between resolving the request and resolving
    // the conception is as narrow as Promise.all allows — a symlink flip
    // mid-call is still possible in theory but the realpath result we
    // compare against is captured atomically per call.
    const { lastConceptionPath: conceptionPath } = await readSettings();
    if (!conceptionPath) {
      throw new Error('pdfToFileUrl: no conception path is set');
    }
    let real: string;
    let conceptionReal: string;
    try {
      [real, conceptionReal] = await Promise.all([fs.realpath(path), fs.realpath(conceptionPath)]);
    } catch {
      throw new Error('pdfToFileUrl: path does not resolve');
    }
    const child = real.endsWith(sep) ? real : real + sep;
    const parent = conceptionReal.endsWith(sep) ? conceptionReal : conceptionReal + sep;
    if (!(child === parent || child.startsWith(parent))) {
      throw new Error('pdfToFileUrl: path is outside the conception tree');
    }
    return {
      url: pathToFileURL(real).href,
      filename: basename(real),
    };
  });

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
    return picked;
  });

  /**
   * Switch the active conception to one of the recents (e.g. driven by the
   * File → Open Recent menu). Same effect as `pickConceptionPath`'s success
   * branch — promotes the picked path to the head of recents, swaps the
   * watchers, broadcasts. Returns the path so the renderer can re-render
   * against the new conception without a second `getConceptionPath` round-trip.
   */
  ipcMain.handle('openConception', async (_, path: string) => {
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error('openConception: path must be a non-empty string');
    }
    const picked = toPosix(path);
    await updateSettings((cur) => ({
      ...cur,
      lastConceptionPath: picked,
      recentConceptionPaths: prependRecent(cur.recentConceptionPaths, picked),
    }));
    await disposeRepoWatchers();
    await setWatchedConception(picked);
    opts.onConceptionPicked(picked);
    fireRecentsChange();
    return picked;
  });

  ipcMain.handle('getRecentConceptionPaths', async () => {
    const { recentConceptionPaths } = await readSettings();
    return recentConceptionPaths;
  });

  ipcMain.handle('clearRecentConceptionPaths', async () => {
    await updateSettings((cur) => ({ ...cur, recentConceptionPaths: [] }));
    fireRecentsChange();
  });

  ipcMain.handle('removeRecentConceptionPath', async (_, path: string) => {
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error('removeRecentConceptionPath: path must be a non-empty string');
    }
    await updateSettings((cur) => ({
      ...cur,
      recentConceptionPaths: removeRecent(cur.recentConceptionPaths, path),
    }));
    fireRecentsChange();
  });

  ipcMain.handle('openConceptionDirectory', async () => {
    const { lastConceptionPath: conceptionPath } = await readSettings();
    if (!conceptionPath) return;
    const error = await shell.openPath(conceptionPath);
    if (error) throw new Error(error);
  });

  ipcMain.handle('openExternal', async (_, target: string) => {
    if (typeof target !== 'string' || target.length === 0) {
      throw new Error('openExternal: target must be a non-empty string');
    }
    // shell.openExternal already filters non-http/https on most platforms but
    // we additionally clamp to safe schemes here so a hostile pty can't pop a
    // file:// or jar: handler. Local paths must go through `openPath`.
    if (!/^(https?|mailto):/i.test(target)) {
      throw new Error('openExternal: only http(s)/mailto schemes are allowed');
    }
    await shell.openExternal(target);
  });

  ipcMain.handle('openPath', async (_, target: string) => {
    if (typeof target !== 'string' || target.length === 0) {
      throw new Error('openPath: target must be a non-empty string');
    }
    // Reject anything that looks like a URL — the renderer should call
    // openExternal for those.
    if (/^[a-z][a-z0-9+\-.]*:/i.test(target)) {
      throw new Error('openPath: target must be a path, not a URL');
    }
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
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

  ipcMain.handle('readHelpDoc', (_, name: string) => readHelpDoc(name));
}
