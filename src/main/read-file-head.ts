import { promises as fs } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

/**
 * Read up to `maxBytes` bytes from the start of a file as UTF-8.
 *
 * The three pane-tree readers (resources, skills, knowledge) all need the
 * head of every markdown file to extract title + summary via `parseHead`.
 * Each had its own copy of the open / read / try-finally close dance —
 * extracted here so a future file-handle leak fix only needs to land
 * once. Best-effort: any error (ENOENT, EACCES, …) returns `null`; the
 * caller falls back to the directory name.
 *
 * Decoded through `StringDecoder` so a byte cut that splits a multi-byte
 * UTF-8 sequence drops the trailing partial character instead of emitting
 * a U+FFFD replacement char into derived titles/summaries.
 */
export async function readFileHead(path: string, maxBytes = 8192): Promise<string | null> {
  try {
    const handle = await fs.open(path);
    try {
      const { buffer, bytesRead } = await handle.read({
        buffer: Buffer.alloc(maxBytes),
        position: 0,
      });
      return new StringDecoder('utf8').write(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
