import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Write `content` to `path` atomically: write to a `.<ts>.<pid>.<seq>.tmp`
 * sibling file (dot-prefix so chokidar's `IGNORED` regex skips the temp
 * file's add event; `<seq>` so two same-millisecond writes in one directory
 * never share a tmp name), fsync the file, rename onto the target, then
 * fsync the parent directory. The data fsync is required: an unsynced rename can leave a
 * zero-length file on power-loss, which condash would surface as
 * "Status field missing" / corrupted index the next parse. The parent-dir
 * fsync is required for the rename itself to be durable on POSIX (without
 * it, the directory entry pointing at the new inode may not survive a
 * crash even though the file's data did).
 *
 * macOS note: `fsync` on the dir fd is enough for the rename durability
 * claim this function makes. `F_FULLFSYNC` is stronger but unnecessary
 * here — and Node doesn't expose it cleanly anyway.
 *
 * Three near-identical copies of this used to live in `mutate.ts`,
 * `index-tree.ts`, and the CLI's `knowledge.ts`. The CLI copy had drifted to
 * a visible (non-dot-prefix) tmp filename that fired spurious chokidar events
 * — consolidating here also fixes that drift.
 */
/** Monotonic per-process sequence folded into the tmp filename. `Date.now()`
 * + pid alone collide when two writes land in the same millisecond in the
 * same directory (the write queue serialises per *path*, not per dir) —
 * one writer's rename would then ship the other's bytes. */
let tmpSeq = 0;

export async function atomicWrite(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  tmpSeq = (tmpSeq + 1) % Number.MAX_SAFE_INTEGER;
  const tmp = join(dir, `.${Date.now()}.${process.pid}.${tmpSeq}.tmp`);
  try {
    const fh = await fs.open(tmp, 'w');
    try {
      await fh.writeFile(content, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, path);
  } catch (err) {
    // Don't leave the orphaned tmp behind when the write / sync / rename
    // fails — chokidar ignores it (dot-prefix) but the user would see it.
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
  // Fsync the parent directory so the rename survives a crash. Open / sync /
  // close are wrapped so a failure to open the dir (e.g. read-only fs in
  // tests, Windows where directories can't be opened for syncing) is
  // surfaced without leaking the file descriptor.
  let dirFh: fs.FileHandle | null = null;
  try {
    dirFh = await fs.open(dir, 'r');
    await dirFh.sync();
  } catch {
    // Best-effort: durability is degraded on platforms that refuse to open
    // a directory for sync (notably Windows), but the file write itself
    // completed before this block — the data is safe modulo crash recovery.
  } finally {
    if (dirFh) await dirFh.close();
  }
}
