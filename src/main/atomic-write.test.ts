import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atomicWrite } from './atomic-write';

describe('atomicWrite', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'atomicwrite-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes the content and leaves no tmp file behind', async () => {
    const target = join(dir, 'a.md');
    await atomicWrite(target, 'hello\n');
    expect(await fs.readFile(target, 'utf8')).toBe('hello\n');
    const leftovers = (await fs.readdir(dir)).filter((n) => n.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('same-millisecond concurrent writes to two files in one dir do not corrupt each other', async () => {
    // Freeze Date.now so the timestamp component of the tmp name collides —
    // only the per-process sequence keeps the tmp paths distinct. The
    // per-file write queue serialises per *path*, not per directory, so
    // these genuinely run concurrently.
    vi.spyOn(Date, 'now').mockReturnValue(1234567890);
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      writes.push(atomicWrite(join(dir, `file-${i}.md`), `content ${i}\n`));
    }
    await Promise.all(writes);
    for (let i = 0; i < 10; i++) {
      expect(await fs.readFile(join(dir, `file-${i}.md`), 'utf8')).toBe(`content ${i}\n`);
    }
    const leftovers = (await fs.readdir(dir)).filter((n) => n.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('unlinks the tmp file when the rename fails', async () => {
    // Renaming a file onto an existing non-empty directory fails — the tmp
    // sibling must be cleaned up rather than left orphaned.
    const targetDir = join(dir, 'occupied');
    await fs.mkdir(targetDir);
    await fs.writeFile(join(targetDir, 'keep.txt'), 'x', 'utf8');
    await expect(atomicWrite(targetDir, 'doomed')).rejects.toThrow();
    const leftovers = (await fs.readdir(dir)).filter((n) => n.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});
