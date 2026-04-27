import { promises as fs } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { simpleGit } from 'simple-git';
import type { RepoEntry } from '../shared/types';
import { listWorktrees } from './worktrees';

/**
 * Each repository entry in configuration.json is either a bare string (the
 * directory name) or an object `{ name, run?, force_stop?, submodules? }`.
 * Submodules use the same shape recursively.
 */
type RawRepo =
  | string
  | {
      name: string;
      run?: string;
      force_stop?: string;
      submodules?: RawRepo[];
    };

interface ConfigShape {
  workspace_path?: string;
  repositories?: {
    primary?: RawRepo[];
    secondary?: RawRepo[];
  };
}

interface FlatRepo {
  name: string;
  kind: 'primary' | 'secondary';
  parent?: string;
  run?: string;
  forceStop?: string;
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

function flatten(
  entries: RawRepo[],
  kind: 'primary' | 'secondary',
  parent: string | undefined,
  out: FlatRepo[],
): void {
  for (const entry of entries) {
    if (typeof entry === 'string') {
      out.push({ name: entry, kind, parent });
      continue;
    }
    out.push({
      name: entry.name,
      kind,
      parent,
      run: entry.run,
      forceStop: entry.force_stop,
    });
    if (entry.submodules?.length) {
      flatten(entry.submodules, kind, entry.name, out);
    }
  }
}

function resolveRepoPath(workspaceDir: string | undefined, flat: FlatRepo): string {
  if (isAbsolute(flat.name)) return flat.name;
  const baseSegments: string[] = [];
  if (workspaceDir) baseSegments.push(workspaceDir);
  if (flat.parent) baseSegments.push(flat.parent);
  baseSegments.push(flat.name);
  return baseSegments.length === 1 ? baseSegments[0] : join(...baseSegments);
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
  const workspace = config.workspace_path;

  const flat: FlatRepo[] = [];
  if (config.repositories?.primary)
    flatten(config.repositories.primary, 'primary', undefined, flat);
  if (config.repositories?.secondary) {
    flatten(config.repositories.secondary, 'secondary', undefined, flat);
  }

  return Promise.all(
    flat.map(async (entry) => {
      const path = resolveRepoPath(workspace, entry);
      const exists = await pathExists(path);
      const display = entry.parent ? `${entry.parent}/${entry.name}` : entry.name;
      const hasForceStop = !!entry.forceStop;
      if (!exists) {
        return {
          name: display,
          path,
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
          ? listWorktrees(path).catch(() => [])
          : Promise.resolve([]);
      try {
        const git = simpleGit({ baseDir: path });
        const [status, worktrees] = await Promise.all([git.status(), worktreesPromise]);
        return {
          name: display,
          path,
          kind: entry.kind,
          parent: entry.parent,
          dirty: status.files.length,
          missing: false,
          hasForceStop,
          worktrees: worktrees.length > 0 ? worktrees : undefined,
        } satisfies RepoEntry;
      } catch {
        const worktrees = await worktreesPromise;
        return {
          name: display,
          path,
          kind: entry.kind,
          parent: entry.parent,
          dirty: null,
          missing: false,
          hasForceStop,
          worktrees: worktrees.length > 0 ? worktrees : undefined,
        } satisfies RepoEntry;
      }
    }),
  );
}
