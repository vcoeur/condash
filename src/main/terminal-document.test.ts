import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveTerminalDocument } from './terminal-document';

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('resolveTerminalDocument', () => {
  it('resolves relative and absolute documents, with traversal bounded by the native viewer root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-document-'));
    fixtures.push(root);
    const cwd = join(root, 'notes');
    await mkdir(cwd);
    const guide = join(root, 'guide.md');
    await writeFile(guide, '# Guide');
    await expect(resolveTerminalDocument('../guide.md', cwd, root)).resolves.toBe(guide);
    await expect(resolveTerminalDocument(guide, cwd, root)).resolves.toBe(guide);
    await expect(resolveTerminalDocument('file://' + guide, cwd, root)).resolves.toBe(guide);
    await expect(
      resolveTerminalDocument('https://example.com/guide.md', cwd, root),
    ).rejects.toThrow('Not a local');
    await expect(resolveTerminalDocument('missing.md', cwd, root)).rejects.toThrow(
      'does not resolve',
    );
    await mkdir(join(cwd, 'directory.mdx'));
    await expect(resolveTerminalDocument('directory.mdx', cwd, root)).rejects.toThrow(
      'must resolve',
    );
  });

  it('rejects lexical escapes, symlink escapes and links with a disguised target extension', async () => {
    const outer = await mkdtemp(join(tmpdir(), 'terminal-document-'));
    fixtures.push(outer);
    const root = join(outer, 'conception');
    await mkdir(root);
    await writeFile(join(outer, 'outside.md'), '# Outside');
    await writeFile(join(root, 'other.txt'), 'not a document');
    await symlink(join(outer, 'outside.md'), join(root, 'escape.md'));
    await symlink(join(root, 'other.txt'), join(root, 'disguised.md'));
    await expect(resolveTerminalDocument('../outside.md', root, root)).rejects.toThrow('outside');
    await expect(resolveTerminalDocument('escape.md', root, root)).rejects.toThrow('outside');
    await expect(resolveTerminalDocument('disguised.md', root, root)).rejects.toThrow(
      'must resolve',
    );
  });
});
