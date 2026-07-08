// Builds a per-repo "should chokidar ignore this path?" predicate from the
// repo's gitignore rules, for the Code-pane repo watchers (`repo-watchers.ts`).
//
// Why gitignore drives the ignore set: the worktree watcher's only job is to
// trigger `git status --porcelain` recomputes. An event on a gitignored path
// can never change that output, so watching it is pure waste — spurious git
// child processes and a bloated inotify watch set (`.venv/`, `__pycache__/`,
// and, worst, condash's own `.condash/` state dir writing every few seconds,
// which self-triggered a perpetual recompute loop). Ignoring everything git
// ignores collapses both problems to zero.
//
// The predicate is used as chokidar's `ignored` *function*, so it must also
// stop chokidar DESCENDING into an ignored directory (that is what shrinks the
// watch set, not just the event volume). chokidar tests each entry during its
// recursive scan with `entry.stats` available, so a dir-only gitignore pattern
// (`foo/`) is matched by additionally probing the path with a trailing slash
// when the node is a directory (see `ignores`).
//
// This module is fs-light and electron-free so the matching logic unit-tests
// from rule text alone (`buildGitignoreMatcher`), without a real repo or git.
import ignore from 'ignore';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toPosix } from '../shared/path';

/**
 * Always-ignored floor — matched regardless of what the repo's gitignore says,
 * and regardless of whether the node is a file or a directory. Tested against
 * the repo-root-relative POSIX path.
 *
 * `.condash` is the load-bearing entry: it is condash's own per-conception
 * state dir (session logs flush every few seconds), so the self-trigger fix
 * must not depend on the conception's `.gitignore` actually listing it. `.git`
 * and `node_modules` are the other invariant "never a real file" dirs. All
 * three are directories in every practical case.
 *
 * Deliberately NOT "ignore every dot-directory": tracked dot-dirs are real
 * (`.github/`, `.agents/`, `.vscode/`) and blanket-ignoring them would drop
 * genuine git-status changes. Untracked agent-state dirs (`.venv`, `.opencode`,
 * `.claude`, `__pycache__`, …) are already gitignored in practice, so the
 * gitignore matcher covers them without over-reaching here.
 */
const ALWAYS_FLOOR: readonly RegExp[] = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.condash(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
];

/**
 * Build/output directory floor — a backstop for repos whose gitignore is
 * missing or wrong. Unlike {@link ALWAYS_FLOOR} these are ignored ONLY when the
 * matching segment is a *directory* (see `ignores`): a FILE named `dist`,
 * `build.rs`, or `target` is ordinary source and must stay watched (W1).
 *
 * `dist`/`build` match the word plus any separator-suffixed variant
 * (`dist-electron`, `dist-cli`, `build-out`) but NOT a longer word that merely
 * begins with those letters (`distribution`, `distance.py`, `builder.ts`,
 * `building.md`) — those are real source names the old `dist[^/]*` / `build[^/]*`
 * prefix wrongly suppressed, including the whole `src/distribution/` tree (W1).
 * `target` is an exact segment. A build dir with an unusual name is covered by
 * the repo's own gitignore; the floor only needs the common conventions.
 */
function isBuildFloorSegment(segment: string): boolean {
  return segment === 'target' || /^(?:dist|build)(?:$|[^a-zA-Z0-9])/.test(segment);
}

/** A path→ignored predicate scoped to one watch root. */
export interface GitignoreMatcher {
  /**
   * Whether `absPath` should be ignored by the repo watcher — both "don't
   * emit an event for it" and "don't descend into it" when it is a directory.
   *
   * @param absPath absolute path chokidar is deciding on.
   * @param isDirectory whether the node is a directory (from `entry.stats`);
   *   `undefined` when chokidar hasn't stat'd yet — treated as "maybe a dir"
   *   so a dir-only pattern can still block descent into an unclassified node.
   * @returns true to ignore.
   */
  ignores(absPath: string, isDirectory?: boolean): boolean;
}

/**
 * Repo-root-relative POSIX path, or `null` when `pathPosix` is the root itself
 * or lies outside it. The `ignore` package rejects absolute / `./` / empty
 * paths, so callers must map to a clean relative path first.
 */
function toRepoRelative(rootPosix: string, pathPosix: string): string | null {
  if (pathPosix === rootPosix) return null;
  const prefix = rootPosix.endsWith('/') ? rootPosix : `${rootPosix}/`;
  if (!pathPosix.startsWith(prefix)) return null;
  return pathPosix.slice(prefix.length);
}

/**
 * Build a {@link GitignoreMatcher} for `root` from the given gitignore rule
 * text (the concatenation of every rule source — see {@link readRuleText}).
 * Pure: no fs, no git, so it unit-tests directly.
 *
 * @param root absolute watch-root path.
 * @param ruleText newline-joined gitignore rules (`.gitignore` bodies, etc.).
 */
export function buildGitignoreMatcher(root: string, ruleText: string): GitignoreMatcher {
  const rootPosix = toPosix(root);
  const ig = ignore().add(ruleText);
  return {
    ignores(absPath, isDirectory) {
      const rel = toRepoRelative(rootPosix, toPosix(absPath));
      // Root itself or anything outside the root — never our concern.
      if (rel === null || rel === '') return false;
      // Always-floor first: cheap regex, correct even when gitignore is silent.
      for (const floor of ALWAYS_FLOOR) if (floor.test(rel)) return true;
      // Build-dir floor (dir-only): a matching segment is ignored only when it
      // is a directory. A NON-FINAL match is a directory by definition (it has
      // children after it → blocks descent); a FINAL match is a directory only
      // when isDirectory === true. A FILE named `dist`/`build.rs`/`target` stays
      // watched, and with no stats (isDirectory === undefined) a final-only
      // match stays watched too — the conservative choice (W1).
      const segments = rel.split('/');
      for (let i = 0; i < segments.length; i++) {
        if (!isBuildFloorSegment(segments[i])) continue;
        if (i < segments.length - 1 || isDirectory === true) return true;
      }
      if (ig.ignores(rel)) return true;
      // A dir-only pattern (`foo/`) matches `foo/` and `foo/child` but not the
      // bare `foo` node — so to block descent we must probe the trailing-slash
      // form when the node is (or might be) a directory.
      if (isDirectory !== false && ig.ignores(`${rel}/`)) return true;
      return false;
    },
  };
}

/**
 * Read and concatenate the gitignore rule sources for `root`:
 *   - `<root>/.gitignore` — the repo's own tracked ignores.
 *   - `<root>/.git/info/exclude` — repo-local, untracked. Lives under the
 *     ignored `.git/`, so the watcher never sees edits to it; its rules change
 *     rarely, and that staleness (until the next full re-arm) is acceptable.
 *   - the user's global excludes file, pre-resolved by the caller.
 *
 * Nested `<subdir>/.gitignore` files are intentionally skipped: correctly
 * prefixing their patterns to root-relative form is error-prone, and the
 * common perf offenders (`.venv`, `node_modules`, `__pycache__`, build dirs)
 * live in the root `.gitignore` or the hardcoded floor anyway.
 *
 * @param root absolute watch-root path.
 * @param globalExcludesFile resolved path to the user's global excludes file,
 *   or `null` when unset/absent.
 * @returns concatenated rule text (empty string when nothing is readable).
 */
export function readRuleText(root: string, globalExcludesFile: string | null): string {
  // Concatenate in ASCENDING git precedence, because the `ignore` package is
  // last-match-wins: the source that gets the final word must be the one git
  // ranks highest. Git precedence (low → high) is global excludes →
  // `.git/info/exclude` → the repo's `.gitignore`. Concatenating the other way
  // (the old order) inverted it, so e.g. a global `*.log` beat a repo
  // `!server.log` and the matcher ignored a file git tracks and watches (W2).
  const sources: string[] = [];
  if (globalExcludesFile) sources.push(globalExcludesFile);
  sources.push(join(root, '.git', 'info', 'exclude'));
  sources.push(join(root, '.gitignore'));
  const parts: string[] = [];
  for (const source of sources) {
    try {
      parts.push(readFileSync(source, 'utf8'));
    } catch {
      // Absent / unreadable source — expected for most repos. Skip it.
    }
  }
  return parts.join('\n');
}
