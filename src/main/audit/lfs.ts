/**
 * `lfs` audit check — coverage of binary files under `projects/`.
 *
 * Flags `*.pdf|*.png|*.jpg|*.jpeg` files in scope of the conception's git
 * working tree that are not tracked by git-lfs.
 */

import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import { toPosix } from '../../shared/path';
import { pathExists } from '../fs-helpers';
import {
  type AuditIssue,
  BIN_EXTS,
  collectFilesByExt,
  listInScopeFiles,
  listLfsFiles,
} from './shared';

export async function checkLfs(conceptionPath: string): Promise<AuditIssue[]> {
  const issues: AuditIssue[] = [];
  const projectsDir = join(conceptionPath, 'projects');
  if (!(await pathExists(projectsDir))) return issues;
  const tracked = await listLfsFiles(conceptionPath);
  if (tracked === null) {
    return [
      {
        check: 'lfs',
        severity: 'info',
        file: null,
        line: null,
        message: 'git-lfs not available; skipping LFS check',
        fix: { action: 'install_git_lfs', autoFix: false },
      },
    ];
  }
  const inScope = await listInScopeFiles(conceptionPath);
  const matches = await collectFilesByExt(projectsDir, BIN_EXTS);
  for (const abs of matches) {
    // POSIX-normalise: `git ls-files` / `git lfs ls-files` emit forward
    // slashes, while `relative()` yields backslashes on Windows — without
    // this the set lookups silently never match there.
    const rel = toPosix(relative(conceptionPath, abs));
    if (!inScope.has(rel)) continue;
    if (tracked.has(rel)) continue;
    let sizeKb = 0;
    try {
      const stat = await fs.stat(abs);
      sizeKb = stat.size / 1024;
    } catch {
      continue;
    }
    issues.push({
      check: 'lfs',
      severity: 'warn',
      file: rel,
      line: null,
      message: `${rel} (${sizeKb.toFixed(0)} kB) is not tracked by git-lfs`,
      fix: { action: 'lfs_track_path', autoFix: true, path: rel, sizeKb: Math.round(sizeKb) },
    });
  }
  return issues;
}
