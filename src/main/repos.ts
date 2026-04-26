import { promises as fs } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { simpleGit } from 'simple-git';
import type { RepoEntry } from '../shared/types';

interface ConfigShape {
  workspace_path?: string;
  repositories?: {
    primary?: string[];
    secondary?: string[];
  };
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

function resolveRepoPath(workspaceDir: string | undefined, name: string): string {
  if (isAbsolute(name)) return name;
  if (workspaceDir) return join(workspaceDir, name);
  return name;
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

  const all: { kind: 'primary' | 'secondary'; name: string }[] = [];
  for (const name of config.repositories?.primary ?? []) all.push({ kind: 'primary', name });
  for (const name of config.repositories?.secondary ?? []) all.push({ kind: 'secondary', name });

  const repos = await Promise.all(
    all.map(async ({ kind, name }) => {
      const path = resolveRepoPath(workspace, name);
      const exists = await pathExists(path);
      if (!exists) return { name, path, kind, dirty: null, missing: true } satisfies RepoEntry;

      try {
        const git = simpleGit({ baseDir: path });
        const status = await git.status();
        const dirty = status.files.length;
        return { name, path, kind, dirty, missing: false } satisfies RepoEntry;
      } catch {
        return { name, path, kind, dirty: null, missing: false } satisfies RepoEntry;
      }
    }),
  );

  return repos;
}
