import { promises as fs } from 'node:fs';

/**
 * Read up to `maxBytes` bytes from the start of a file as UTF-8.
 *
 * The three pane-tree readers (resources, skills, knowledge) all need the
 * head of every markdown file to extract title + summary via `parseHead`.
 * Each had its own copy of the open / read / try-finally close dance —
 * extracted here so a future file-handle leak fix only needs to land
 * once. Best-effort: any error (ENOENT, EACCES, …) returns `null`; the
 * caller falls back to the directory name.
 */
export async function readFileHead(path: string, maxBytes = 8192): Promise<string | null> {
  try {
    const handle = await fs.open(path);
    try {
      const { buffer, bytesRead } = await handle.read({
        buffer: Buffer.alloc(maxBytes),
        position: 0,
      });
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
