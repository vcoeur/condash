import { app, dialog, ipcMain, shell } from 'electron';
import { promises as fs } from 'node:fs';
import { basename, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toPosix } from '../../shared/path';
import { readSettings, updateSettings } from '../settings';
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
export function registerSystemIpc(opts: { onConceptionPicked: (path: string) => void }): void {
  ipcMain.handle('openInEditor', async (_, path: string) => {
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  });

  ipcMain.handle('getConceptionPath', async () => {
    const { conceptionPath } = await readSettings();
    return conceptionPath ? toPosix(conceptionPath) : null;
  });

  ipcMain.handle('pdf.toFileUrl', async (_, path: string) => {
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error('pdf.toFileUrl: path must be a non-empty string');
    }
    // Bound the file:// URL to the conception subtree — without this, a
    // compromised renderer can synthesise a webview src for any file on disk
    // (e.g. ~/.ssh/id_rsa) by passing an absolute path. Resolve via realpath
    // to defeat symlink traversal. Both paths are realpathed together (in
    // parallel) so the window between resolving the request and resolving
    // the conception is as narrow as Promise.all allows — a symlink flip
    // mid-call is still possible in theory but the realpath result we
    // compare against is captured atomically per call.
    const { conceptionPath } = await readSettings();
    if (!conceptionPath) {
      throw new Error('pdf.toFileUrl: no conception path is set');
    }
    let real: string;
    let conceptionReal: string;
    try {
      [real, conceptionReal] = await Promise.all([fs.realpath(path), fs.realpath(conceptionPath)]);
    } catch {
      throw new Error('pdf.toFileUrl: path does not resolve');
    }
    const child = real.endsWith(sep) ? real : real + sep;
    const parent = conceptionReal.endsWith(sep) ? conceptionReal : conceptionReal + sep;
    if (!(child === parent || child.startsWith(parent))) {
      throw new Error('pdf.toFileUrl: path is outside the conception tree');
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
    await updateSettings((cur) => ({ ...cur, conceptionPath: picked }));
    // Tear down repo watchers from the previous conception before re-pointing
    // them; otherwise stale `repo-events` carry paths the renderer no longer
    // tracks until the next listRepos reconciles.
    await disposeRepoWatchers();
    await setWatchedConception(picked);
    opts.onConceptionPicked(picked);
    return picked;
  });

  ipcMain.handle('openConceptionDirectory', async () => {
    const { conceptionPath } = await readSettings();
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

  ipcMain.handle('help.readDoc', (_, name: string) => readHelpDoc(name));
}
