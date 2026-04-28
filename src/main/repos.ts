import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { RepoEntry } from '../shared/types';
import { getDirtyCount } from './git-status-cache';
import { listWorktrees } from './worktrees';
import { walkRepos, type ConfigShape, type RepoLookup } from './config-walk';

interface FlatRepo extends RepoLookup {
  kind: 'primary' | 'secondary';
}

async function readConfig(conceptionPath: string): Promise<ConfigShape> {
  const path = join(conceptionPath, 'configuration.json');
  try {
    const raw = await fs.readFile(path, 'utf8');
    return JSON.parse(raw) as ConfigShape;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function listRepos(conceptionPath: string): Promise<RepoEntry[]> {
  const config = await readConfig(conceptionPath);

  const flat: FlatRepo[] = [];
  walkRepos(config, (entry, kind) => {
    flat.push({ ...entry, kind });
  });

  return Promise.all(
    flat.map(async (entry) => {
      const exists = await pathExists(entry.cwd);
      const hasForceStop = !!entry.forceStop;
      if (!exists) {
        return {
          name: entry.display,
          path: entry.cwd,
          kind: entry.kind,
          parent: entry.parent,
          dirty: null,
          missing: true,
          hasForceStop,
        } satisfies RepoEntry;
      }
      // Worktrees only meaningful for primary checkouts (top-level repos).
      const worktreesPromise =
        entry.kind === 'primary' && !entry.parent
          ? listWorktrees(entry.cwd).catch(() => [])
          : Promise.resolve([]);
      const [dirty, worktrees] = await Promise.all([getDirtyCount(entry.cwd), worktreesPromise]);
      return {
        name: entry.display,
        path: entry.cwd,
        kind: entry.kind,
        parent: entry.parent,
        dirty,
        missing: false,
        hasForceStop,
        worktrees: worktrees.length > 0 ? worktrees : undefined,
      } satisfies RepoEntry;
    }),
  );
}
