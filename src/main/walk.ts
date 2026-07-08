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

  // Probe every month's items — and each item's README existence — concurrently.
  // The old serial await-in-loop paid one round-trip per project dir (~700 at
  // boot on a large tree, ~330-390 ms — review finding S1). Output order is
  // preserved: months are sorted, items within a month are sorted, and
  // Promise.all keeps array order, so the flattened result matches the old walk.
  const perMonth = await Promise.all(
    months.map(async (month) => {
      const monthDir = join(projectsRoot, month);
      const items = await readSubdirs(monthDir);
      const readmes = await Promise.all(
        items.map(async (item) => {
          const readme = join(monthDir, item, 'README.md');
          return (await exists(readme)) ? readme : null;
        }),
      );
      return readmes.filter((readme): readme is string => readme !== null);
    }),
  );
  return perMonth.flat();
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
