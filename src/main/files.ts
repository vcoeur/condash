import { promises as fs, type Dirent } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProjectFileEntry } from '../shared/types';
import { toPosix } from '../shared/path';

/**
 * List files inside a project directory (the directory containing `readmePath`).
 * Walks the top level and one nested level (e.g. `notes/`). Hidden entries and
 * deeper subtrees are skipped — projects in this tree are documentation-only
 * and rarely have deeper structure.
 */
export async function listProjectFiles(readmePath: string): Promise<ProjectFileEntry[]> {
  const root = dirname(readmePath);
  const out: ProjectFileEntry[] = [];

  let top: Dirent[];
  try {
    top = (await fs.readdir(root, { withFileTypes: true })) as Dirent[];
  } catch {
    return out;
  }

  for (const entry of top) {
    if (entry.name.startsWith('.')) continue;
    const absolute = join(root, entry.name);
    if (entry.isFile()) {
      out.push({ path: toPosix(absolute), relPath: entry.name, name: entry.name });
      continue;
    }
    if (!entry.isDirectory()) continue;
    let nested: Dirent[];
    try {
      nested = (await fs.readdir(absolute, { withFileTypes: true })) as Dirent[];
    } catch {
      continue;
    }
    for (const child of nested) {
      if (child.name.startsWith('.')) continue;
      if (!child.isFile()) continue;
      out.push({
        path: toPosix(join(absolute, child.name)),
        relPath: `${entry.name}/${child.name}`,
        name: child.name,
      });
    }
  }

  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}
