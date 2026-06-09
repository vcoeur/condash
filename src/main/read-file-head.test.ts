import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileHead } from './read-file-head';

describe('readFileHead', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'readhead-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reads the head of a small file in full', async () => {
    const path = join(dir, 'small.md');
    await fs.writeFile(path, '# Title\n\nBody.\n', 'utf8');
    expect(await readFileHead(path)).toBe('# Title\n\nBody.\n');
  });

  it('returns null for a missing file', async () => {
    expect(await readFileHead(join(dir, 'gone.md'))).toBeNull();
  });

  it('drops a trailing partial multi-byte char instead of emitting U+FFFD', async () => {
    // 8190 ASCII bytes + a 3-byte CJK char: the 8192-byte cut lands two
    // bytes into the multi-byte sequence.
    const path = join(dir, 'multibyte.md');
    await fs.writeFile(path, 'a'.repeat(8190) + '日本語', 'utf8');
    const head = await readFileHead(path, 8192);
    expect(head).not.toBeNull();
    expect(head).not.toContain('�');
    expect(head!.endsWith('a')).toBe(true);
    expect(head!.length).toBe(8190);
  });

  it('keeps a multi-byte char that fits exactly at the boundary', async () => {
    // 8189 ASCII bytes + 3-byte char = exactly 8192 bytes — nothing split.
    const path = join(dir, 'exact.md');
    await fs.writeFile(path, 'a'.repeat(8189) + '日', 'utf8');
    const head = await readFileHead(path, 8192);
    expect(head!.endsWith('日')).toBe(true);
    expect(head).not.toContain('�');
  });
});
