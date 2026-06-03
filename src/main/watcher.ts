import chokidar, { type FSWatcher } from 'chokidar';
import { BrowserWindow } from 'electron';
import { join } from 'node:path';
import { toPosix } from '../shared/path';
import type { TreeEvent } from '../shared/types';
import { migrateLegacyConfig } from './condash-dir-migrate';
import { resolveConceptionPaths } from './conception-paths';
import { applyIndexFsEvent, clearSearchIndex, rebuildSearchIndex } from './search/index-cache';

const DEBOUNCE_MS = 250;

const NODE_MODULES_RE = /[/\\]node_modules[/\\]/;
const DIST_RE = /[/\\]dist[/\\]/;
const TARGET_RE = /[/\\]target[/\\]/;
const DOTFILE_SEGMENT_RE = /(^|[/\\])\.[^/\\]+/;

interface RootSet {
  resources: string;
  skills: string;
}

/** Constant paths computed once per conception. `classify` referenced these
 * by re-running `join + toPosix` on every chokidar event before — pre-
 * compute them and close over the bundle so the hot path is just string
 * compares. */
interface WatchPaths {
  conceptionP: string;
  condashJson: string;
  configJson: string;
  agentsRoot: string;
  claudeRoot: string;
  claudeDot: string;
  projectsPrefix: string;
  knowledgePrefix: string;
}

function buildWatchPaths(conception: string): WatchPaths {
  const conceptionP = toPosix(conception);
  return {
    conceptionP,
    condashJson: toPosix(join(conception, 'condash.json')),
    configJson: toPosix(join(conception, 'configuration.json')),
    agentsRoot: toPosix(join(conception, 'AGENTS.md')),
    claudeRoot: toPosix(join(conception, 'CLAUDE.md')),
    claudeDot: toPosix(join(conception, '.claude', 'CLAUDE.md')),
    projectsPrefix: `${conceptionP}/projects/`,
    knowledgePrefix: `${conceptionP}/knowledge/`,
  };
}

let current: {
  path: string;
  watcher: FSWatcher;
  roots: RootSet;
  paths: WatchPaths;
} | null = null;
let timer: NodeJS.Timeout | null = null;
let pending: TreeEvent[] = [];
let pendingUnknown = false;

export async function setWatchedConception(conceptionPath: string | null): Promise<void> {
  if (current?.path === conceptionPath) return;

  // Conception is changing — drop the in-memory search index; it's rebuilt
  // below for the new conception (or left empty when clearing).
  clearSearchIndex();

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

  const { resources, skills } = resolveConceptionPaths();
  const roots: RootSet = {
    resources: toPosix(join(conceptionPath, resources)),
    skills: toPosix(join(conceptionPath, skills)),
  };

  // The dotfile-segment pattern excludes paths like `.git/…` from the watch
  // set. The skills root lives under `.agents/skills/` (agedum source),
  // which would normally be filtered out — bypass the rule for paths under
  // the skills/resources roots so a `.agents/skills/foo.md` change still
  // fires. The same bypass covers `<conception>/AGENTS.md` and the legacy
  // `.claude/CLAUDE.md`, surfaced in the Skills pane as the pinned callout.
  const agentsRoot = toPosix(join(conceptionPath, 'AGENTS.md'));
  const claudeDot = toPosix(join(conceptionPath, '.claude', 'CLAUDE.md'));
  const ignored = (path: string): boolean => {
    if (NODE_MODULES_RE.test(path) || DIST_RE.test(path) || TARGET_RE.test(path)) return true;
    if (!DOTFILE_SEGMENT_RE.test(path)) return false;
    // toPosix is only needed for the dotfile bypass checks below; the three
    // regexes above filter out the vast majority of paths, so we avoid the
    // string-replacement cost on every chokidar event for those.
    const posix = toPosix(path);
    if (posix === roots.resources || posix.startsWith(`${roots.resources}/`)) return false;
    if (posix === roots.skills || posix.startsWith(`${roots.skills}/`)) return false;
    if (posix === agentsRoot) return false;
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
      // Conception-level AGENTS.md is the pinned Skills-pane callout
      // post-reframe; legacy CLAUDE.md (root and `.claude/`) still
      // surfaces for back-compat. Repaint the pane on edit, hence the
      // explicit watches.
      join(conceptionPath, 'AGENTS.md'),
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

  const paths = buildWatchPaths(conceptionPath);
  watcher.on('all', (eventName, path) => onWatchEvent(eventName, path, roots, paths));
  watcher.on('error', (err) => {
    console.error('[watcher]', err);
  });

  current = { path: conceptionPath, watcher, roots, paths };

  // Build the in-memory search index for the markdown sources. Fire-and-forget
  // so it never blocks boot; queries fall back to the on-disk scan until it
  // resolves, and the watcher keeps it fresh thereafter.
  void rebuildSearchIndex(conceptionPath).catch((err) => {
    console.error('[watcher] rebuildSearchIndex failed', err);
  });
}

/**
 * Tear down the current watcher and rebuild it. Called after a
 * `condash.json` (or legacy `configuration.json`) edit might have changed
 * `skills_path`, so the new root is observed and the old one isn't.
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

function onWatchEvent(eventName: string, path: string, roots: RootSet, paths: WatchPaths): void {
  // Keep the in-memory search index incrementally fresh. Independent of the
  // renderer `classify` below: it covers project notes too (which classify maps
  // to `unknown`), and only touches indexed markdown files.
  if (current) {
    void applyIndexFsEvent(current.path, eventName, path).catch((err) => {
      console.error('[watcher] applyIndexFsEvent failed', err);
    });
  }

  const event = classify(eventName as ChokidarEvent, path, roots, paths);
  if (event.kind === 'unknown') pendingUnknown = true;
  else pending.push(event);
  // A condash.json edit may have changed `skills_path`. Rebuild the
  // watcher so the new root is observed and the old one isn't.
  // Serialise via refreshChain so concurrent edits don't race the
  // close+rebuild — the in-flight `tree-events` batch still flushes
  // through `schedule()` for the renderer.
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
  eventName: ChokidarEvent,
  path: string,
  roots: RootSet,
  paths: WatchPaths,
): TreeEvent {
  const op = chokidarToOp(eventName);
  if (!op) return { kind: 'unknown' };

  // Chokidar can emit native or POSIX separators depending on platform and
  // base-path shape. Compare on a POSIX-normalised view so prefix/suffix
  // checks work the same on macOS, Linux, and Windows.
  const pathP = toPosix(path);

  // Config files at the conception root. Both filenames participate so
  // an in-flight rename / hand-edit of either is reflected.
  if (pathP === paths.condashJson || pathP === paths.configJson) {
    return { kind: 'config', path };
  }

  // Conception-level AGENTS.md (canonical) and legacy CLAUDE.md surface
  // in the Skills pane as the pinned callout — route changes through the
  // `skills` event so the pane refetches and the pinned entry repaints.
  if (pathP === paths.agentsRoot || pathP === paths.claudeRoot || pathP === paths.claudeDot) {
    return { kind: 'skills', op, path };
  }

  // Project README: <conception>/projects/<month>/<slug>/README.md
  if (pathP.startsWith(paths.projectsPrefix) && pathP.endsWith('/README.md')) {
    const tail = pathP.slice(paths.projectsPrefix.length, -'/README.md'.length);
    if (tail.split('/').length === 2) {
      return { kind: 'project', op, path };
    }
    return { kind: 'unknown' };
  }

  // Knowledge: any `.md` under <conception>/knowledge/.
  if (pathP.startsWith(paths.knowledgePrefix) && pathP.toLowerCase().endsWith('.md')) {
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
