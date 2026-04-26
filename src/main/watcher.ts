import chokidar, { type FSWatcher } from 'chokidar';
import { BrowserWindow } from 'electron';
import { join } from 'node:path';

const DEBOUNCE_MS = 250;

const IGNORED = [
  /(^|[/\\])\.[^/\\]+/,
  /[/\\]node_modules[/\\]/,
  /[/\\]dist[/\\]/,
  /[/\\]target[/\\]/,
];

let current: { path: string; watcher: FSWatcher } | null = null;
let timer: NodeJS.Timeout | null = null;

export async function setWatchedConception(conceptionPath: string | null): Promise<void> {
  if (current?.path === conceptionPath) return;

  if (current) {
    await current.watcher.close().catch(() => undefined);
    current = null;
  }
  if (!conceptionPath) return;

  const watcher = chokidar.watch(
    [join(conceptionPath, 'projects'), join(conceptionPath, 'knowledge')],
    {
      ignored: IGNORED,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    },
  );

  watcher.on('all', notify);
  watcher.on('error', (err) => {
    console.error('[watcher]', err);
  });

  current = { path: conceptionPath, watcher };
}

function notify(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('tree-changed');
    }
  }, DEBOUNCE_MS);
}
