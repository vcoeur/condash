/**
 * Local (no-LLM) derivation of a terminal tab's provenance — which app it
 * belongs to, which worktree/branch its cwd sits in, and the conception
 * projects that declare that branch. Cheap filesystem + config reads only; the
 * result is attached to the tab's `TabSummary` and fed (as plain names) to the
 * subtitle writer. Reuses the same registry / worktree / projects parsing the
 * rest of the main process uses so the mapping never drifts.
 */

import { relative } from 'node:path';
import type { TabInfo } from '../../shared/types';
import { findRepoEntry } from '../config-walk';
import { getEffectiveConceptionConfig } from '../effective-config';
import { findProjectReadmes } from '../walk';
import { readHeader } from '../header-io';
import { branchToDir, defaultWorktreesPath } from '../worktree/shared';

/** A tab's derived provenance. Every field is optional — each resolves
 *  independently and is omitted when it can't be determined. */
export interface TabProvenance {
  /** App `#handle` (no leading `#`) the tab's repo maps to. */
  app?: string;
  /** Worktree/branch directory name when the cwd is under `worktrees_path`. */
  worktree?: string;
  /** Conception projects whose README `branch:` matches `worktree`. */
  projects?: { slug: string; title: string }[];
}

/** True when `cwd` is `worktreesPath` itself or nested beneath it. */
function isUnder(worktreesPath: string, cwd: string): string | null {
  const rel = relative(worktreesPath, cwd);
  if (rel === '' || rel.startsWith('..') || rel.startsWith('/')) return null;
  return rel;
}

/**
 * Derive provenance for one tab. Never throws — a config/tree read failure
 * degrades to an empty result rather than breaking summarization.
 *
 * - `app`: `tab.repo` resolved to its canonical `#handle` via the repo registry
 *   (`findRepoEntry`); undefined when the tab carries no repo or it resolves to
 *   none.
 * - `worktree`: the first path segment under `worktrees_path` when `tab.cwd`
 *   sits in `<worktrees_path>/<branch>/<repo>/...`; undefined otherwise.
 * - `projects`: when a worktree is known, every project README whose `branch:`
 *   maps (via `branchToDir`) to that worktree segment, as `{slug, title}`.
 *
 * @param conceptionPath The active conception root.
 * @param tab The roster entry (sid, cwd, repo?, cmd?).
 * @returns The derived provenance; an empty object when nothing resolves.
 */
export async function deriveProvenance(
  conceptionPath: string,
  tab: TabInfo,
): Promise<TabProvenance> {
  const out: TabProvenance = {};
  let config;
  try {
    config = await getEffectiveConceptionConfig(conceptionPath);
  } catch {
    return out;
  }

  if (tab.repo) {
    const entry = findRepoEntry(config, tab.repo);
    if (entry?.handle) out.app = entry.handle;
  }

  const worktreesPath = config.worktrees_path ?? defaultWorktreesPath();
  const rel = tab.cwd ? isUnder(worktreesPath, tab.cwd) : null;
  if (!rel) return out;
  const worktree = rel.split('/')[0];
  if (!worktree) return out;
  out.worktree = worktree;

  try {
    const readmes = await findProjectReadmes(conceptionPath);
    const projects: { slug: string; title: string }[] = [];
    for (const readme of readmes) {
      const header = await readHeader(readme).catch(() => null);
      if (!header?.branch) continue;
      if (branchToDir(header.branch) !== worktree) continue;
      const slug =
        readme
          .replace(/\/README\.md$/, '')
          .split('/')
          .pop() ?? '';
      projects.push({ slug, title: header.title ?? slug });
    }
    if (projects.length > 0) out.projects = projects;
  } catch {
    // Tree read failed — keep app/worktree, drop projects.
  }
  return out;
}
