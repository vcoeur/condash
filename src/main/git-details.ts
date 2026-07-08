// Detailed dirty-status lookup for the Code-pane popover.
//
// `getDirtyCount` (in `git-status-cache.ts`) returns the badge number; this
// module returns the full breakdown shown when the user clicks that badge:
// every porcelain-v1 file enriched with its `git diff --numstat HEAD` row,
// so the renderer can show "what / where / how much" on a single line per
// file (status code, path, +N -N counts, scaled +/- bar).
//
// Also folds in the unpushed-commit list (`git log @{u}..HEAD`) so the
// popover can render a separate section for commits queued for push, in
// the same round-trip as the dirty-file list.

import type { UnpushedCommit, UpstreamStatus } from '../shared/types';
import {
  getUpstreamStatus,
  isZeroByteUntracked,
  statusPathPrefix,
  stripStatusPrefix,
} from './git-status-cache';

const FILE_LIMIT = 20;
const UNPUSHED_LIMIT = 20;

export interface DirtyFile {
  /** Two-character porcelain status (e.g. ` M`, `??`, `D `). Whitespace
   * preserved so the renderer can pad / colour by index/worktree column. */
  code: string;
  /** Path relative to the queried directory — the worktree root normally,
   * the subtree when `scopeToSubtree` is set (git reports root-relative
   * paths even from a subtree cwd; the subtree prefix is stripped here).
   * Rename arrows (`old -> new`) are collapsed to the new path. */
  path: string;
  /** Lines added (per `git diff --numstat HEAD`). Null when the file is
   *  untracked, binary, or numstat has no row for it (fresh repo, etc.). */
  added: number | null;
  /** Lines deleted. Same null semantics as `added`. */
  deleted: number | null;
  /** True when numstat reports this path as binary (`- - <path>`). */
  binary: boolean;
}

export interface DirtyDetails {
  files: DirtyFile[];
  /** Aggregate `+` count across the returned files. Untracked and binary
   *  files contribute 0. The renderer renders the footer line off these. */
  totalAdded: number;
  /** Aggregate `-` count across the returned files. */
  totalDeleted: number;
  /** True when the file list was truncated to `FILE_LIMIT`. */
  truncated: boolean;
  /** Total number of dirty files before truncation. */
  totalCount: number;
  /** Upstream summary; null when the branch has no tracking ref. */
  upstream: UpstreamStatus | null;
  /** Unpushed commits, newest first, capped at `UNPUSHED_LIMIT`. */
  unpushedCommits: UnpushedCommit[];
  /** True when the unpushed-commit list was truncated. */
  unpushedTruncated: boolean;
}

interface DirtyDetailsOptions {
  /** Mirror `getDirtyCount`'s scopeToSubtree: when true, both `git status`
   * and `git diff --numstat` are restricted to `.` so a submodule entry
   * that shares its .git with the parent doesn't bleed parent-repo paths. */
  scopeToSubtree?: boolean;
}

interface ParsedPorcelain {
  code: string;
  path: string;
}

/** Parse one porcelain-v1 line into status code + root-relative path
 *  (renames collapsed to the new path). Pure; exported for unit tests. */
export function parsePorcelain(line: string): ParsedPorcelain {
  const code = line.slice(0, 2);
  let rest = line.slice(3);
  // Renames look like `R  old -> new`; collapse to the new path.
  const arrow = rest.indexOf(' -> ');
  if (arrow !== -1) rest = rest.slice(arrow + 4);
  return { code, path: rest };
}

interface NumstatRow {
  added: number | null;
  deleted: number | null;
  binary: boolean;
}

/** Parse `git diff --numstat` output into a path-keyed map. Binary files
 *  (`-\t-\t<path>`) carry null counts. Pure; exported for unit tests. */
export function parseNumstat(out: string): Map<string, NumstatRow> {
  const map = new Map<string, NumstatRow>();
  for (const line of out.split('\n')) {
    if (!line) continue;
    // numstat columns are tab-separated: "<added>\t<deleted>\t<path>".
    // Binary files report "-\t-\t<path>".
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [aRaw, dRaw, ...pathParts] = parts;
    const path = pathParts.join('\t');
    const binary = aRaw === '-' && dRaw === '-';
    const added = binary ? null : Number.parseInt(aRaw, 10);
    const deleted = binary ? null : Number.parseInt(dRaw, 10);
    map.set(path, {
      added: Number.isFinite(added) ? (added as number) : null,
      deleted: Number.isFinite(deleted) ? (deleted as number) : null,
      binary,
    });
  }
  return map;
}

export async function getDirtyDetails(
  path: string,
  opts: DirtyDetailsOptions = {},
): Promise<DirtyDetails | null> {
  try {
    // Lazy so importing this module (reachable on the pre-window boot path via
    // `ipc/repos`) doesn't pull simple-git's graph before first paint — it loads
    // only on this post-window "inspect dirty" popover read.
    const { simpleGit } = await import('simple-git');
    const git = simpleGit({ baseDir: path });
    const statusArgs = ['status', '--porcelain=v1'];
    // `--no-renames` keeps numstat paths aligned with porcelain (which we
    // also collapse to the new path on rename) so the join below is by
    // exact-string match.
    const numstatArgs = ['diff', '--numstat', '--no-renames', 'HEAD'];
    if (opts.scopeToSubtree) {
      statusArgs.push('--', '.');
      numstatArgs.push('--', '.');
    }

    // git reports paths relative to the repo root even from a subtree cwd;
    // strip the subtree prefix so `DirtyFile.path` is relative to the
    // queried directory and the porcelain ↔ numstat join keys agree.
    const prefix = await statusPathPrefix(git, opts.scopeToSubtree === true);

    const statusOut = await git.raw(statusArgs);
    const porcelain: ParsedPorcelain[] = [];
    for (const line of statusOut.split('\n')) {
      if (line.length === 0) continue;
      if (await isZeroByteUntracked(line, path, prefix)) continue;
      const parsed = parsePorcelain(line);
      porcelain.push({ code: parsed.code, path: stripStatusPrefix(parsed.path, prefix) });
    }

    // `git diff --numstat HEAD` is empty / errors when HEAD is missing
    // (fresh repo) or no tracked file changed; fall through with an empty
    // map so untracked-only states still show. Numstat paths are
    // root-relative too — re-key through the same prefix strip.
    let numstat = new Map<string, NumstatRow>();
    try {
      const numstatOut = await git.raw(numstatArgs);
      for (const [rootRel, row] of parseNumstat(numstatOut)) {
        numstat.set(stripStatusPrefix(rootRel, prefix), row);
      }
    } catch {
      numstat = new Map();
    }

    const totalCount = porcelain.length;
    const truncated = totalCount > FILE_LIMIT;
    const slice = truncated ? porcelain.slice(0, FILE_LIMIT) : porcelain;

    const files: DirtyFile[] = slice.map((p) => {
      const row = numstat.get(p.path);
      return {
        code: p.code,
        path: p.path,
        added: row?.added ?? null,
        deleted: row?.deleted ?? null,
        binary: row?.binary ?? false,
      };
    });

    let totalAdded = 0;
    let totalDeleted = 0;
    for (const f of files) {
      if (f.added) totalAdded += f.added;
      if (f.deleted) totalDeleted += f.deleted;
    }

    // Upstream + unpushed-commit list. The lookup runs against the
    // worktree root regardless of `scopeToSubtree` — git's @{u} resolves
    // against HEAD, not a subtree path. We only fetch the commit list
    // when the upstream is set and we're actually ahead, so a synced
    // branch costs only the cached `getUpstreamStatus` lookup.
    const upstream = await getUpstreamStatus(path);
    let unpushedCommits: UnpushedCommit[] = [];
    let unpushedTruncated = false;
    if (upstream && upstream.ahead > 0) {
      try {
        const out = await git.raw([
          'log',
          `--max-count=${UNPUSHED_LIMIT + 1}`,
          '--pretty=%h%x09%s',
          '@{u}..HEAD',
        ]);
        const lines = out.split('\n').filter((l) => l.length > 0);
        unpushedTruncated = lines.length > UNPUSHED_LIMIT;
        const slice = unpushedTruncated ? lines.slice(0, UNPUSHED_LIMIT) : lines;
        unpushedCommits = slice.map((line) => {
          const tab = line.indexOf('\t');
          if (tab === -1) return { sha: line, subject: '' };
          return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
        });
      } catch {
        unpushedCommits = [];
      }
    }

    return {
      files,
      totalAdded,
      totalDeleted,
      truncated,
      totalCount,
      upstream,
      unpushedCommits,
      unpushedTruncated,
    };
  } catch {
    return null;
  }
}
