import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve condash's per-user data directory.
 *
 * In the Electron main process this is `app.getPath('userData')`. We can't
 * `import { app } from 'electron'` from a CLI bundle (no Electron runtime),
 * so detect the runtime via `process.versions.electron`: if present, the
 * Electron `app` is loaded lazily; otherwise we mirror Electron's defaults
 * by hand. Both paths produce the same string for a given `condash` install,
 * which is the load-bearing invariant — the CLI must point at the same
 * settings.json the Electron app reads.
 */
export function userDataDir(): string {
  // Feature-test instead of checking `process.versions.electron` — that flag
  // is set even when the Electron binary runs in plain-Node mode via
  // ELECTRON_RUN_AS_NODE=1 (the path condash's bash wrapper takes for
  // `condash <subcommand>` calls). In that mode `require('electron')`
  // returns the path to the binary as a *string*, not the API object, so
  // we have to probe the shape before reaching `.app.getPath()`.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const candidate: unknown = require('electron');
    if (
      candidate !== null &&
      typeof candidate === 'object' &&
      'app' in candidate &&
      typeof (candidate as { app?: { getPath?: unknown } }).app?.getPath === 'function'
    ) {
      return (candidate as { app: { getPath(name: string): string } }).app.getPath('userData');
    }
  } catch {
    // require('electron') fails outside the Electron runtime — fall through.
  }
  return defaultUserDataDir('condash');
}

function defaultUserDataDir(productName: string): string {
  const home = homedir();
  switch (process.platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', productName);
    case 'win32':
      return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), productName);
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), productName);
  }
}
