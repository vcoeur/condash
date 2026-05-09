import { promises as fs, type Dirent } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProjectFileEntry } from '../shared/types';
import { toPosix } from '../shared/path';

/**
 * List files inside a project directory (the directory containing `readmePath`).
 * Walks the entire subtree, files only, skipping dotfiles and dot-directories.
 * The renderer rebuilds the directory hierarchy from `relPath`, so a directory
 * whose contents live two or more levels down (e.g. `local/candidates/*`) was
 * previously invisible — recursive descent is what surfaces it.
 */
export async function listProjectFiles(readmePath: string): Promise<ProjectFileEntry[]> {
  const root = dirname(readmePath);
  const out: ProjectFileEntry[] = [];
  await walk(root, '', out);
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

async function walk(absDir: string, relDir: string, out: ProjectFileEntry[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = (await fs.readdir(absDir, { withFileTypes: true })) as Dirent[];
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const absolute = join(absDir, entry.name);
    const relative = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isFile()) {
      out.push({ path: toPosix(absolute), relPath: relative, name: entry.name });
      continue;
    }
    if (entry.isDirectory()) {
      await walk(absolute, relative, out);
    }
  }
}
