import chokidar, { type FSWatcher } from 'chokidar';
import { BrowserWindow } from 'electron';
import { join } from 'node:path';
import { toPosix } from '../shared/path';
import type { TreeEvent } from '../shared/types';

const DEBOUNCE_MS = 250;

const IGNORED = [
  /(^|[/\\])\.[^/\\]+/,
  /[/\\]node_modules[/\\]/,
  /[/\\]dist[/\\]/,
  /[/\\]target[/\\]/,
];

let current: { path: string; watcher: FSWatcher } | null = null;
let timer: NodeJS.Timeout | null = null;
let pending: TreeEvent[] = [];
let pendingUnknown = false;

export async function setWatchedConception(conceptionPath: string | null): Promise<void> {
  if (current?.path === conceptionPath) return;

  if (current) {
    await current.watcher.close().catch(() => undefined);
    current = null;
  }
  pending = [];
  pendingUnknown = false;
  if (!conceptionPath) return;

  const watcher = chokidar.watch(
    [
      join(conceptionPath, 'projects'),
      join(conceptionPath, 'knowledge'),
      join(conceptionPath, 'configuration.json'),
      join(conceptionPath, 'configuration.yml'),
    ],
    {
      ignored: IGNORED,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    },
  );

  watcher.on('all', (eventName, path) => onWatchEvent(conceptionPath, eventName, path));
  watcher.on('error', (err) => {
    console.error('[watcher]', err);
  });

  current = { path: conceptionPath, watcher };
}

type ChokidarEvent = 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir';

function onWatchEvent(conception: string, eventName: string, path: string): void {
  const event = classify(conception, eventName as ChokidarEvent, path);
  if (event.kind === 'unknown') pendingUnknown = true;
  else pending.push(event);
  schedule();
}

function classify(conception: string, eventName: ChokidarEvent, path: string): TreeEvent {
  const op = chokidarToOp(eventName);
  if (!op) return { kind: 'unknown' };

  // Chokidar can emit native or POSIX separators depending on platform and
  // base-path shape. Compare on a POSIX-normalised view so prefix/suffix
  // checks work the same on macOS, Linux, and Windows.
  const conceptionP = toPosix(conception);
  const pathP = toPosix(path);

  // Config files at the conception root.
  const configJson = toPosix(join(conception, 'configuration.json'));
  const configYml = toPosix(join(conception, 'configuration.yml'));
  if (pathP === configJson || pathP === configYml) {
    return { kind: 'config', path };
  }

  // Project README: <conception>/projects/<month>/<slug>/README.md
  const projectsPrefix = `${conceptionP}/projects/`;
  if (pathP.startsWith(projectsPrefix) && pathP.endsWith('/README.md')) {
    const tail = pathP.slice(projectsPrefix.length, -'/README.md'.length);
    if (tail.split('/').length === 2) {
      return { kind: 'project', op, path };
    }
    return { kind: 'unknown' };
  }

  // Knowledge: any `.md` under <conception>/knowledge/.
  const knowledgePrefix = `${conceptionP}/knowledge/`;
  if (pathP.startsWith(knowledgePrefix) && pathP.toLowerCase().endsWith('.md')) {
    return { kind: 'knowledge', op, path };
  }

  return { kind: 'unknown' };
}

function chokidarToOp(eventName: ChokidarEvent): 'add' | 'change' | 'unlink' | null {
  if (eventName === 'add') return 'add';
  if (eventName === 'change') return 'change';
  if (eventName === 'unlink') return 'unlink';
  return null;
}

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const events = pendingUnknown ? [{ kind: 'unknown' } as TreeEvent] : pending;
    pending = [];
    pendingUnknown = false;
    if (events.length === 0) return;
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send('tree-events', events);
    }
  }, DEBOUNCE_MS);
}
