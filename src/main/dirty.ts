import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/**
 * Mark a tree's `.index-dirty` sentinel — the signal the dashboard reads to
 * know that `condash <tree> index` should run. Touched by `/projects create`
 * / close / status update and by `/knowledge update`. Cleared by
 * `condash <tree> index`. Returns `true` once the marker exists (created or
 * touched).
 *
 * Two near-identical copies used to live in `cli/commands/projects.ts` and
 * `cli/commands/misc.ts` — consolidated here.
 */
export async function touchDirtyMarker(
  conceptionPath: string,
  tree: 'projects' | 'knowledge',
): Promise<boolean> {
  const path = join(conceptionPath, tree, '.index-dirty');
  try {
    await fs.utimes(path, new Date(), new Date());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.writeFile(path, '', 'utf8');
    } else throw err;
  }
  return true;
}
