import { promises as fs } from 'node:fs';

/**
 * Cheap exists check — true iff `fs.access` succeeds (file or dir present).
 * Five byte-identical local copies used to live across `cli/commands/projects.ts`,
 * `main/audit.ts`, `main/conception-init.ts`, `main/repos.ts`, and
 * `main/worktree-ops.ts`; consolidated here.
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}
