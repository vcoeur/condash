import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Write `content` to `path` atomically: write to a `.<ts>.<pid>.tmp` sibling
 * file (dot-prefix so chokidar's `IGNORED` regex skips the temp file's add
 * event), fsync, then rename. The fsync is required: an unsynced rename can
 * leave a zero-length file on power-loss, which condash would surface as
 * "Status field missing" / corrupted index the next parse.
 *
 * Three near-identical copies of this used to live in `mutate.ts`,
 * `index-tree.ts`, and the CLI's `knowledge.ts`. The CLI copy had drifted to
 * a visible (non-dot-prefix) tmp filename that fired spurious chokidar events
 * — consolidating here also fixes that drift.
 */
export async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = join(dirname(path), `.${Date.now()}.${process.pid}.tmp`);
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(content, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, path);
}
