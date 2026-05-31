/**
 * `stale-index` audit check — flags `index.md` files under `projects/` and
 * `knowledge/` whose content has drifted from the tree (a status tag changed, a
 * bullet needs adding or dropping). The sibling `index` check covers structure —
 * missing files, dangling links, orphan bodies; this one covers *freshness*, and
 * it covers `projects/` too (the `index` check is knowledge-only).
 *
 * It reuses the regen engine in dry-run mode, which writes nothing and leaves the
 * `.index-dirty` marker untouched: any index the regen reports under `created` or
 * `updated` is stale. The autofix runs the matching `condash <tree> index` — the
 * very write the dry-run previewed. Surfaced in the default audit set so `/tidy`
 * and routine sweeps catch drift before a manual regen bundles it with unrelated
 * work.
 */

import { knowledgeStrategy } from '../index-knowledge';
import { projectsStrategy } from '../index-projects';
import { regenerateIndex, type IndexStrategy } from '../index-tree';
import type { AuditIssue } from './shared';

/** Trees to probe, paired with the `/tidy` autofix action that regenerates each. */
const TREES: { strategy: IndexStrategy; fixAction: string }[] = [
  { strategy: projectsStrategy, fixAction: 'run_projects_index' },
  { strategy: knowledgeStrategy, fixAction: 'run_knowledge_index' },
];

/**
 * Flag every `index.md` the regen engine would rewrite. Pure read-only: each
 * tree is regenerated in dry-run mode and only the reported `created`/`updated`
 * paths are turned into issues.
 */
export async function checkStaleIndex(conceptionPath: string): Promise<AuditIssue[]> {
  const issues: AuditIssue[] = [];
  for (const { strategy, fixAction } of TREES) {
    const report = await regenerateIndex(conceptionPath, strategy, { dryRun: true });
    const stalePaths = [...report.created, ...report.updated.map((row) => row.indexPath)];
    for (const indexPath of stalePaths) {
      issues.push({
        check: 'stale-index',
        severity: 'warn',
        file: indexPath,
        line: null,
        message: `index.md is stale (regen would rewrite it) — run condash ${strategy.treeName} index`,
        fix: { action: fixAction, autoFix: true },
      });
    }
  }
  return issues;
}
