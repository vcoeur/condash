import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResourceNode } from '../shared/types';
import { categorise, mimeFor, readResourcesTree } from './resources';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'condash-resources-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function setupTree(): void {
  mkdirSync(join(tmp, 'resources'));
  mkdirSync(join(tmp, 'resources', 'sub'));
  writeFileSync(
    join(tmp, 'resources', 'README.md'),
    '# Resources\n\nFirst paragraph that becomes the summary.\n',
  );
  writeFileSync(join(tmp, 'resources', 'photo.png'), 'fake-png');
  writeFileSync(join(tmp, 'resources', 'spec.pdf'), '%PDF-1.4 fake');
  writeFileSync(join(tmp, 'resources', 'notes.txt'), 'plain text');
  writeFileSync(join(tmp, 'resources', '.hidden.md'), '# hidden');
  writeFileSync(join(tmp, 'resources', 'sub', 'inner.md'), '# Inner');
}

describe('readResourcesTree', () => {
  it('returns null when the directory is missing', async () => {
    const tree = await readResourcesTree(tmp);
    expect(tree).toBeNull();
  });

  it('walks every file regardless of extension and skips dot-files', async () => {
    setupTree();
    const tree = (await readResourcesTree(tmp))!;
    expect(tree.kind).toBe('directory');
    const childNames = (tree.children ?? []).map((c) => c.name).sort();
    expect(childNames).toEqual(['README.md', 'notes.txt', 'photo.png', 'spec.pdf', 'sub']);
  });

  it('tags categories and mime types', async () => {
    setupTree();
    const tree = (await readResourcesTree(tmp))!;
    const byName = new Map((tree.children ?? []).map((c) => [c.name, c]));
    expect(byName.get('README.md')?.category).toBe('markdown');
    expect(byName.get('README.md')?.mime).toBe('text/markdown');
    expect(byName.get('spec.pdf')?.category).toBe('pdf');
    expect(byName.get('photo.png')?.category).toBe('image');
    expect(byName.get('notes.txt')?.category).toBe('text');
  });

  it('parses title + summary for markdown only', async () => {
    setupTree();
    const tree = (await readResourcesTree(tmp))!;
    const readme = (tree.children ?? []).find((c) => c.name === 'README.md');
    expect(readme?.title).toBe('Resources');
    expect(readme?.summary).toContain('First paragraph');
    const png = (tree.children ?? []).find((c) => c.name === 'photo.png');
    expect(png?.summary).toBeUndefined();
    expect(png?.title).toBe('photo.png');
  });

  it('recurses into subdirectories', async () => {
    setupTree();
    const tree = (await readResourcesTree(tmp))!;
    const sub = (tree.children ?? []).find((c) => c.name === 'sub');
    expect(sub?.kind).toBe('directory');
    expect(sub?.children?.[0]?.name).toBe('inner.md');
  });

  it('does not infinite-loop on a symlink that points back at an ancestor', async () => {
    mkdirSync(join(tmp, 'resources'));
    mkdirSync(join(tmp, 'resources', 'a'));
    writeFileSync(join(tmp, 'resources', 'a', 'note.md'), '# a');
    symlinkSync(join(tmp, 'resources'), join(tmp, 'resources', 'a', 'loop'));
    const tree = (await readResourcesTree(tmp))!;
    expect(tree.kind).toBe('directory');
    // The symlink's children get cut off when we hit the ancestor again.
    const a = (tree.children ?? []).find((c) => c.name === 'a');
    const loop = a?.children?.find((c: ResourceNode) => c.name === 'loop');
    expect(loop?.kind).toBe('directory');
    expect(loop?.children).toEqual([]);
  });
});

describe('categorise / mimeFor', () => {
  it('routes common extensions correctly', () => {
    expect(categorise('readme.md')).toBe('markdown');
    expect(categorise('doc.pdf')).toBe('pdf');
    expect(categorise('a.json')).toBe('text');
    expect(categorise('img.PNG')).toBe('image');
    expect(categorise('clip.mp4')).toBe('video');
    expect(categorise('archive.zip')).toBe('archive');
    expect(categorise('thing.bin')).toBe('binary');
    expect(categorise('mystery.xyzzy')).toBe('other');
  });

  it('returns mime for known extensions and undefined otherwise', () => {
    expect(mimeFor('a.md')).toBe('text/markdown');
    expect(mimeFor('a.png')).toBe('image/png');
    expect(mimeFor('a.xyzzy')).toBeUndefined();
  });
});
