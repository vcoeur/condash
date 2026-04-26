import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/**
 * Glob equivalent: <conceptionPath>/projects/*\/*\/README.md
 *
 * Pure-Node implementation — no fast-glob dep. The shape is fixed to the
 * conception convention (year-month / date-slug / README.md) so we can
 * skip a full walker and just do two readdir calls.
 */
export async function findProjectReadmes(conceptionPath: string): Promise<string[]> {
  const projectsRoot = join(conceptionPath, 'projects');
  const months = await readSubdirs(projectsRoot);

  const results: string[] = [];
  for (const month of months) {
    const items = await readSubdirs(join(projectsRoot, month));
    for (const item of items) {
      const readme = join(projectsRoot, month, item, 'README.md');
      if (await exists(readme)) results.push(readme);
    }
  }
  return results;
}

async function readSubdirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}
