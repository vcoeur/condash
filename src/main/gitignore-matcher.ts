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
 * Hardcoded floor — always ignored regardless of what the repo's gitignore
 * says. Tested against the repo-root-relative POSIX path.
 *
 * `.condash` is the load-bearing addition over the old `WORKTREE_IGNORED`
 * list: it is condash's own per-conception state dir (session logs flush every
 * few seconds), so the direct self-trigger fix must not depend on the
 * conception's `.gitignore` actually listing it. The other five entries carry
 * over the pre-gitignore behaviour as a backstop for repos whose gitignore is
 * missing or wrong.
 *
 * Deliberately NOT "ignore every dot-directory": tracked dot-dirs are real
 * (`.github/`, `.agents/`, `.vscode/`) and blanket-ignoring them would drop
 * genuine git-status changes. Untracked agent-state dirs (`.venv`, `.opencode`,
 * `.claude`, `__pycache__`, …) are already gitignored in practice, so the
 * gitignore matcher covers them without over-reaching here.
 */
const HARDCODED_FLOOR: readonly RegExp[] = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.condash(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)dist[^/]*(\/|$)/,
  /(^|\/)build[^/]*(\/|$)/,
  /(^|\/)target(\/|$)/,
];

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
      // Floor first: cheap regex, and correct even when gitignore is silent.
      for (const floor of HARDCODED_FLOOR) if (floor.test(rel)) return true;
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
  const sources = [join(root, '.gitignore'), join(root, '.git', 'info', 'exclude')];
  if (globalExcludesFile) sources.push(globalExcludesFile);
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
