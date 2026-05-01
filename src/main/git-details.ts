// Detailed dirty-status lookup for the Code-tab popover.
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

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import type { UnpushedCommit, UpstreamStatus } from '../shared/types';
import { getUpstreamStatus } from './git-status-cache';

const FILE_LIMIT = 20;
const UNPUSHED_LIMIT = 20;

export interface DirtyFile {
  /** Two-character porcelain status (e.g. ` M`, `??`, `D `). Whitespace
   * preserved so the renderer can pad / colour by index/worktree column. */
  code: string;
  /** Path relative to the worktree root. Rename arrows (`old -> new`) are
   * collapsed to the new path. */
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

/** Same zero-byte filter as the count path — sandbox runtime artifacts
 *  (empty placeholder files in untracked state) don't surface as dirty
 *  on the badge, so they shouldn't surface in the popover either. */
async function isZeroByteUntracked(line: string, cwd: string): Promise<boolean> {
  if (!line.startsWith('?? ')) return false;
  const rel = line.slice(3).trim();
  if (!rel) return false;
  try {
    const stat = await fs.stat(join(cwd, rel));
    return stat.isFile() && stat.size === 0;
  } catch {
    return false;
  }
}

interface ParsedPorcelain {
  code: string;
  path: string;
}

function parsePorcelain(line: string): ParsedPorcelain {
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

function parseNumstat(out: string): Map<string, NumstatRow> {
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

    const statusOut = await git.raw(statusArgs);
    const porcelain: ParsedPorcelain[] = [];
    for (const line of statusOut.split('\n')) {
      if (line.length === 0) continue;
      if (await isZeroByteUntracked(line, path)) continue;
      porcelain.push(parsePorcelain(line));
    }

    // `git diff --numstat HEAD` is empty / errors when HEAD is missing
    // (fresh repo) or no tracked file changed; fall through with an empty
    // map so untracked-only states still show.
    let numstat = new Map<string, NumstatRow>();
    try {
      const numstatOut = await git.raw(numstatArgs);
      numstat = parseNumstat(numstatOut);
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
