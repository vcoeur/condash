import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { toPosix } from '../shared/path';

/**
 * Find the most recently modified file under `dir` (top-level only). Returns
 * null when the directory is missing or empty. Used by the screenshot-paste
 * shortcut: pick the freshest screenshot in the configured directory and
 * type its path into the active terminal.
 */
export async function latestScreenshot(dir: string): Promise<string | null> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let best: { path: string; mtime: number } | null = null;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(dir, entry.name);
    let stat;
    try {
      stat = await fs.stat(path);
    } catch {
      continue;
    }
    if (!best || stat.mtimeMs > best.mtime) {
      best = { path, mtime: stat.mtimeMs };
    }
  }
  return best ? toPosix(best.path) : null;
}
