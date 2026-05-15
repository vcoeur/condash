/**
 * `worktrees` audit check — items declaring `**Branch**` but missing the
 * matching on-disk worktree at `<worktrees_path>/<branch>/`. Only items
 * whose Status is not `done` are checked.
 */

import { join, relative } from 'node:path';
import { findProjectReadmes } from '../walk';
import { readHeader } from '../header-io';
import { pathExists } from '../fs-helpers';
import { branchToDir } from '../worktree/shared';
import { type AuditIssue, readConfig } from './shared';

export async function checkWorktrees(conceptionPath: string): Promise<AuditIssue[]> {
  const issues: AuditIssue[] = [];
  const config = await readConfig(conceptionPath);
  const worktreesPath =
    typeof config.worktrees_path === 'string'
      ? config.worktrees_path
      : join(process.env.HOME ?? '', 'src', 'worktrees');
  const readmes = await findProjectReadmes(conceptionPath);
  for (const readme of readmes) {
    const header = await readHeader(readme).catch(() => null);
    if (!header) continue;
    if (header.status === 'done') continue;
    if (!header.branch) continue;
    const wt = join(worktreesPath, branchToDir(header.branch));
    if (await pathExists(wt)) continue;
    issues.push({
      check: 'worktrees',
      severity: 'info',
      file: relative(conceptionPath, readme),
      line: null,
      message: `Item declares Branch '${header.branch}' but no worktree at ${wt}`,
      fix: { action: 'offer_worktree_setup', autoFix: true, branch: header.branch },
    });
  }
  return issues;
}
