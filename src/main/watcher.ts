import chokidar, { type FSWatcher } from 'chokidar';
import { BrowserWindow } from 'electron';
import { join } from 'node:path';
import { toPosix } from '../shared/path';
import { EVENT_CHANNELS } from '../shared/ipc-channels';
import { safeSend } from './safe-send';
import type { TreeEvent } from '../shared/types';
import { migrateLegacyConfig } from './condash-dir-migrate';
import { partitionSettingsScopes, scopeMigrationDidWork } from './scope-partition-migrate';
import { resolveConceptionPaths } from './conception-paths';
import { applyIndexFsEvent, clearSearchIndex, rebuildSearchIndex } from './search/index-cache';
import { clearReadmeCache, invalidateReadmeCache } from './parse-cache';
import {
  buildWatchPaths,
  classify,
  type ChokidarEvent,
  type RootSet,
  type WatchPaths,
} from './watch-classify';

const DEBOUNCE_MS = 250;

const NODE_MODULES_RE = /[/\\]node_modules[/\\]/;
const DIST_RE = /[/\\]dist[/\\]/;
const TARGET_RE = /[/\\]target[/\\]/;
const DOTFILE_SEGMENT_RE = /(^|[/\\])\.[^/\\]+/;

let current: {
  path: string;
  watcher: FSWatcher;
  roots: RootSet;
  paths: WatchPaths;
} | null = null;
let timer: NodeJS.Timeout | null = null;
let pending: TreeEvent[] = [];
let pendingUnknown = false;

export async function setWatchedConception(
  conceptionPath: string | null,
  opts: { deferIndexBuild?: boolean } = {},
): Promise<void> {
  if (current?.path === conceptionPath) return;

  // Conception is changing — drop the in-memory search index; it's rebuilt
  // below for the new conception (or left empty when clearing). Drop the
  // README parse memo too so the new tree never serves a stale entry.
  clearSearchIndex();
  clearReadmeCache();

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

  // Partition settings into the post-revamp layout: each key in exactly one
  // file (personal → settings.json, this-tree → .condash/settings.json).
  // Idempotent; writes nothing once both files are already partitioned.
  await partitionSettingsScopes(conceptionPath)
    .then((result) => {
      if (scopeMigrationDidWork(result)) {
        const parts: string[] = [];
        if (result.movedToGlobal.length) parts.push(`→global: ${result.movedToGlobal.join(', ')}`);
        if (result.movedToConception.length)
          parts.push(`→conception: ${result.movedToConception.join(', ')}`);
        if (result.merged.length)
          parts.push(`merged: ${result.merged.map((merge) => merge.key).join(', ')}`);
        if (result.dropped.length)
          parts.push(`dropped: ${result.dropped.map((drop) => drop.key).join(', ')}`);
        process.stderr.write(`condash: settings scope migration (${parts.join('; ')})\n`);
      }
    })
    .catch((err) => {
      process.stderr.write(`condash: partitionSettingsScopes failed: ${err}\n`);
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
  // fires. The same bypass covers `<conception>/AGENTS.md`, the legacy
  // `.claude/CLAUDE.md` (both surfaced in the Skills pane as the pinned
  // callout), and the canonical per-conception config at
  // `.condash/settings.json` — that single file only, never the rest of
  // `.condash/` (its `logs/` would flood events).
  const agentsRoot = toPosix(join(conceptionPath, 'AGENTS.md'));
  const claudeDot = toPosix(join(conceptionPath, '.claude', 'CLAUDE.md'));
  const condashSettings = toPosix(join(conceptionPath, '.condash', 'settings.json'));
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
    if (posix === condashSettings) return false;
    return true;
  };

  const watcher = chokidar.watch(
    [
      join(conceptionPath, 'projects'),
      join(conceptionPath, 'knowledge'),
      join(conceptionPath, resources),
      join(conceptionPath, skills),
      // Canonical per-conception config plus the two legacy names. The
      // canonical file only — never the whole `.condash/` dir (logs flood).
      join(conceptionPath, '.condash', 'settings.json'),
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
  //
  // On the boot call (`deferIndexBuild`) this rebuild — a full-tree re-read of
  // ~700 files — is skipped here and kicked by index.ts after `ready-to-show` +
  // an idle tick instead (S8), so it never competes with the renderer's first
  // listProjects/listRepos and the chokidar install for the cold page cache.
  // Search stays correct in the gap: index-cache returns null while unbuilt and
  // search/index.ts falls back to an on-disk scan. Conception switches / config
  // refreshes leave `deferIndexBuild` unset and rebuild immediately.
  if (!opts.deferIndexBuild) {
    void rebuildSearchIndex(conceptionPath).catch((err) => {
      console.error('[watcher] rebuildSearchIndex failed', err);
    });
  }
}

/**
 * Tear down the current watcher and rebuild it. Called after a
 * `.condash/settings.json` (or legacy `condash.json` / `configuration.json`)
 * edit might have changed `skills_path`, so the new root is observed and the
 * old one isn't.
 */
async function refreshWatchedConception(): Promise<void> {
  if (!current) return;
  const path = current.path;
  await current.watcher.close().catch(() => undefined);
  current = null;
  pending = [];
  pendingUnknown = false;
  await setWatchedConception(path);
}

// Promise chain so two rapid condash.json edits queue their
// rebuilds instead of racing — the second close() can otherwise land
// while the first refresh is still reassigning `current`, leaking a
// chokidar handle or losing a config event entirely.
let refreshChain: Promise<void> = Promise.resolve();

function onWatchEvent(eventName: string, path: string, roots: RootSet, paths: WatchPaths): void {
  // Keep the in-memory search index incrementally fresh. Independent of the
  // renderer `classify` below and broader: it indexes project notes too (which
  // classify routes to a scoped project-card patch), and only touches indexed
  // markdown files.
  if (current) {
    void applyIndexFsEvent(current.path, eventName, path).catch((err) => {
      console.error('[watcher] applyIndexFsEvent failed', err);
    });
  }

  // Drop the README parse memo for a file that changed or was removed so the
  // next listProjects/getProject re-parses it (R2). Keyed by path, so this is a
  // cheap no-op for the (vast majority of) non-README events.
  if (eventName === 'change' || eventName === 'unlink') {
    invalidateReadmeCache(path);
  }

  const event = classify(eventName as ChokidarEvent, path, roots, paths);
  if (event.kind === 'ignore') {
    // Recognised as store-irrelevant (index regen etc.). The search index +
    // parse-cache above already handled any real content change; nothing to
    // notify the renderer about, and crucially NOT an `unknown` fan-out.
  } else if (event.kind === 'unknown') {
    pendingUnknown = true;
  } else {
    pending.push(event);
  }
  // A config edit may have changed `skills_path`. Rebuild the
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
      safeSend(win.webContents, EVENT_CHANNELS.treeEvents, events);
    }
  }, DEBOUNCE_MS);
}
