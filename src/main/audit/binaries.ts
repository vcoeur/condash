/**
 * `binaries` audit check — files over the LFS review threshold that are
 * not tracked by git-lfs. Informational; usually downstream of `lfs`.
 */

import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import { pathExists } from '../fs-helpers';
import {
  type AuditIssue,
  BIN_EXTS,
  LARGE_BIN_KB,
  collectFilesByExt,
  listInScopeFiles,
  listLfsFiles,
} from './shared';

export async function checkBinaries(conceptionPath: string): Promise<AuditIssue[]> {
  const issues: AuditIssue[] = [];
  const projectsDir = join(conceptionPath, 'projects');
  if (!(await pathExists(projectsDir))) return issues;
  const tracked = (await listLfsFiles(conceptionPath)) ?? new Set<string>();
  const inScope = await listInScopeFiles(conceptionPath);
  const matches = await collectFilesByExt(projectsDir, BIN_EXTS);
  for (const abs of matches) {
    const rel = relative(conceptionPath, abs);
    if (!inScope.has(rel)) continue;
    if (tracked.has(rel)) continue;
    let sizeKb = 0;
    try {
      const stat = await fs.stat(abs);
      sizeKb = stat.size / 1024;
    } catch {
      continue;
    }
    if (sizeKb <= LARGE_BIN_KB) continue;
    issues.push({
      check: 'binaries',
      severity: 'info',
      file: rel,
      line: null,
      message: `${rel} is ${sizeKb.toFixed(0)} kB (> ${LARGE_BIN_KB} kB review threshold, not in git-lfs)`,
      fix: {
        action: 'consider_lfs_or_remove',
        autoFix: false,
        path: rel,
        sizeKb: Math.round(sizeKb),
      },
    });
  }
  return issues;
}
