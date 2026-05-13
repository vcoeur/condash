import chokidar, { type FSWatcher } from 'chokidar';
import { BrowserWindow } from 'electron';
import { join } from 'node:path';
import { toPosix } from '../shared/path';
import type { TreeEvent } from '../shared/types';
import { migrateLegacyConfig } from './condash-dir-migrate';
import { resolveConceptionPaths } from './conception-paths';

const DEBOUNCE_MS = 250;

const NODE_MODULES_RE = /[/\\]node_modules[/\\]/;
const DIST_RE = /[/\\]dist[/\\]/;
const TARGET_RE = /[/\\]target[/\\]/;
const DOTFILE_SEGMENT_RE = /(^|[/\\])\.[^/\\]+/;

interface RootSet {
  resources: string;
  skills: string;
}

let current: {
  path: string;
  watcher: FSWatcher;
  roots: RootSet;
} | null = null;
let timer: NodeJS.Timeout | null = null;
let pending: TreeEvent[] = [];
let pendingUnknown = false;

export async function setWatchedConception(conceptionPath: string | null): Promise<void> {
  if (current?.path === conceptionPath) return;

  if (current) {
    await current.watcher.close().catch(() => undefined);
    current = null;
  }
  // Cancel any in-flight debounce so a stale event from the old
  // conception's chokidar emit doesn't fire `tree-events` against the
  // new tree's renderer.
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  pending = [];
  pendingUnknown = false;
  // Reset the refresh-serialisation chain — pass-5 added the per-event
  // promise chain to serialise rebuilds within a conception, but the
  // module-level state needs to reset across conceptions or a queued
  // rebuild from the old tree could fire after we've swapped.
  refreshChain = Promise.resolve();
  if (!conceptionPath) return;

  // One-shot migration of legacy `condash.json` / `configuration.json` →
  // `.condash/settings.json`. Idempotent and silent when there's nothing
  // to do. Runs before the watcher attaches so the renderer's first
  // config read sees the post-migration state.
  await migrateLegacyConfig(conceptionPath).catch((err) => {
    process.stderr.write(`condash: migrateLegacyConfig failed: ${err}\n`);
  });

  const { resources, skills } = await resolveConceptionPaths(conceptionPath);
  const roots: RootSet = {
    resources: toPosix(join(conceptionPath, resources)),
    skills: toPosix(join(conceptionPath, skills)),
  };

  // The dotfile-segment pattern excludes paths like `.git/…` from the watch
  // set. `skills_path` defaults to `.claude/skills`, which would normally
  // be filtered out — bypass the rule for paths under the configured
  // skills/resources roots so a `.claude/skills/foo.md` change still fires.
  // The same bypass covers `<conception>/.claude/CLAUDE.md`, which is
  // surfaced in the Skills pane as a synthetic root entry.
  const claudeDot = toPosix(join(conceptionPath, '.claude', 'CLAUDE.md'));
  const ignored = (path: string): boolean => {
    if (NODE_MODULES_RE.test(path) || DIST_RE.test(path) || TARGET_RE.test(path)) return true;
    if (!DOTFILE_SEGMENT_RE.test(path)) return false;
    const posix = toPosix(path);
    if (posix === roots.resources || posix.startsWith(`${roots.resources}/`)) return false;
    if (posix === roots.skills || posix.startsWith(`${roots.skills}/`)) return false;
    if (posix === claudeDot) return false;
    return true;
  };

  const watcher = chokidar.watch(
    [
      join(conceptionPath, 'projects'),
      join(conceptionPath, 'knowledge'),
      join(conceptionPath, resources),
      join(conceptionPath, skills),
      join(conceptionPath, 'condash.json'),
      join(conceptionPath, 'configuration.json'),
      // Conception-level CLAUDE.md (root and `.claude/`). Surfaced as
      // synthetic skill entries so the Skills pane can open them — they
      // need to repaint the pane on edit, hence the explicit watches.
      join(conceptionPath, 'CLAUDE.md'),
      join(conceptionPath, '.claude', 'CLAUDE.md'),
    ],
    {
      ignored,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    },
  );

  watcher.on('all', (eventName, path) => onWatchEvent(conceptionPath, eventName, path, roots));
  watcher.on('error', (err) => {
    console.error('[watcher]', err);
  });

  current = { path: conceptionPath, watcher, roots };
}

/**
 * Tear down the current watcher and rebuild it. Called after a
 * `condash.json` (or legacy `configuration.json`) edit might have changed
 * `resources_path` or `skills_path`, so the new roots are observed and
 * the old ones aren't.
 */
export async function refreshWatchedConception(): Promise<void> {
  if (!current) return;
  const path = current.path;
  await current.watcher.close().catch(() => undefined);
  current = null;
  pending = [];
  pendingUnknown = false;
  await setWatchedConception(path);
}

type ChokidarEvent = 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir';

// Promise chain so two rapid condash.json edits queue their
// rebuilds instead of racing — the second close() can otherwise land
// while the first refresh is still reassigning `current`, leaking a
// chokidar handle or losing a config event entirely.
let refreshChain: Promise<void> = Promise.resolve();

function onWatchEvent(conception: string, eventName: string, path: string, roots: RootSet): void {
  const event = classify(conception, eventName as ChokidarEvent, path, roots);
  if (event.kind === 'unknown') pendingUnknown = true;
  else pending.push(event);
  // A condash.json edit may have changed `resources_path` /
  // `skills_path`. Rebuild the watcher so the new roots are observed
  // and the old ones aren't. Serialise via refreshChain so concurrent
  // edits don't race the close+rebuild — the in-flight `tree-events`
  // batch still flushes through `schedule()` for the renderer.
  if (event.kind === 'config') {
    refreshChain = refreshChain
      .then(() => refreshWatchedConception())
      .catch((err) => {
        console.error('[watcher] refreshWatchedConception failed', err);
      });
  }
  schedule();
}

function classify(
  conception: string,
  eventName: ChokidarEvent,
  path: string,
  roots: RootSet,
): TreeEvent {
  const op = chokidarToOp(eventName);
  if (!op) return { kind: 'unknown' };

  // Chokidar can emit native or POSIX separators depending on platform and
  // base-path shape. Compare on a POSIX-normalised view so prefix/suffix
  // checks work the same on macOS, Linux, and Windows.
  const conceptionP = toPosix(conception);
  const pathP = toPosix(path);

  // Config files at the conception root. Both filenames participate so
  // an in-flight rename / hand-edit of either is reflected.
  const condashJson = toPosix(join(conception, 'condash.json'));
  const configJson = toPosix(join(conception, 'configuration.json'));
  if (pathP === condashJson || pathP === configJson) {
    return { kind: 'config', path };
  }

  // Conception-level CLAUDE.md surfaces in the Skills pane as a
  // synthetic entry — route changes through the `skills` event so
  // the pane refetches and the synthetic entry repaints.
  const claudeRoot = toPosix(join(conception, 'CLAUDE.md'));
  const claudeDot = toPosix(join(conception, '.claude', 'CLAUDE.md'));
  if (pathP === claudeRoot || pathP === claudeDot) {
    return { kind: 'skills', op, path };
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

  // Resources: every file under the configured resources root.
  if (pathP === roots.resources || pathP.startsWith(`${roots.resources}/`)) {
    return { kind: 'resources', op, path };
  }

  // Skills: every `.md` file under the configured skills root.
  if (
    (pathP === roots.skills || pathP.startsWith(`${roots.skills}/`)) &&
    (pathP.toLowerCase().endsWith('.md') || op === 'unlink')
  ) {
    return { kind: 'skills', op, path };
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
