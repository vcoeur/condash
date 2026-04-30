// Detailed dirty-status lookup for the Code-tab popover.
//
// `getDirtyCount` (in `git-status-cache.ts`) returns the badge number; this
// module returns the full breakdown shown when the user clicks that badge:
// every porcelain-v1 line parsed into `{code, path}`, plus a `git diff --stat`
// snippet so the user can see roughly *how big* each tracked change is
// without leaving the dashboard.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';

const DIFFSTAT_LINE_LIMIT = 20;

export interface DirtyFile {
  /** Two-character porcelain status (e.g. ` M`, `??`, `R `). Whitespace
   * preserved so the renderer can pad / colour by index/worktree column. */
  code: string;
  /** Path relative to the worktree root. Rename arrows (`old -> new`) are
   * collapsed to the new path. */
  path: string;
}

export interface DirtyDetails {
  files: DirtyFile[];
  /** Truncated `git diff --stat HEAD` output. Empty when there are no
   * tracked changes (only untracked files), which the renderer can
   * detect to skip the diffstat block entirely. */
  diffstat: string;
  /** True when the diffstat had to be truncated to fit DIFFSTAT_LINE_LIMIT
   * lines. Renderer surfaces a "+N more" hint. */
  diffstatTruncated: boolean;
}

interface DirtyDetailsOptions {
  /** Mirror `getDirtyCount`'s scopeToSubtree: when true, both `git status`
   * and `git diff --stat` are restricted to `.` so a submodule entry that
   * shares its .git with the parent doesn't bleed parent-repo paths. */
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

function parseFile(line: string): DirtyFile {
  const code = line.slice(0, 2);
  let rest = line.slice(3);
  // Renames look like `R  old -> new`; collapse to the new path.
  const arrow = rest.indexOf(' -> ');
  if (arrow !== -1) rest = rest.slice(arrow + 4);
  return { code, path: rest };
}

export async function getDirtyDetails(
  path: string,
  opts: DirtyDetailsOptions = {},
): Promise<DirtyDetails | null> {
  try {
    const git = simpleGit({ baseDir: path });
    const statusArgs = ['status', '--porcelain=v1'];
    const diffArgs = ['diff', '--stat', 'HEAD'];
    if (opts.scopeToSubtree) {
      statusArgs.push('--', '.');
      diffArgs.push('--', '.');
    }

    const statusOut = await git.raw(statusArgs);
    const files: DirtyFile[] = [];
    for (const line of statusOut.split('\n')) {
      if (line.length === 0) continue;
      if (await isZeroByteUntracked(line, path)) continue;
      files.push(parseFile(line));
    }

    let diffstat = '';
    let diffstatTruncated = false;
    // `git diff --stat HEAD` is meaningless when HEAD doesn't exist (fresh
    // repo) or when nothing tracked has changed; swallow the error / empty
    // output, the renderer just hides the block.
    try {
      const diffOut = await git.raw(diffArgs);
      const lines = diffOut.split('\n').filter((l) => l.length > 0);
      if (lines.length > DIFFSTAT_LINE_LIMIT) {
        diffstat = lines.slice(0, DIFFSTAT_LINE_LIMIT).join('\n');
        diffstatTruncated = true;
      } else {
        diffstat = lines.join('\n');
      }
    } catch {
      diffstat = '';
    }

    return { files, diffstat, diffstatTruncated };
  } catch {
    return null;
  }
}
