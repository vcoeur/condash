import { describe, expect, it } from 'vitest';
import type { ProjectFileEntry } from '@shared/types';
import { buildFileTree, defaultExpanded, isLocalScratch, type FileTreeNode } from './data';

function entry(relPath: string, kind: 'file' | 'dir'): ProjectFileEntry {
  const name = relPath.split('/').pop()!;
  return { relPath, name, kind, path: `/proj/${relPath}` };
}

function names(nodes: FileTreeNode[]): string[] {
  return nodes.map((n) => n.name);
}

describe('buildFileTree', () => {
  it('excludes the top-level README.md', () => {
    const tree = buildFileTree([entry('README.md', 'file'), entry('extra.md', 'file')]);
    expect(names(tree)).toEqual(['extra.md']);
  });

  it('keeps a nested README.md (only the top-level one is special)', () => {
    const tree = buildFileTree([entry('notes', 'dir'), entry('notes/README.md', 'file')]);
    expect(names(tree[0].children)).toEqual(['README.md']);
  });

  it('nests files under their dir entries, including empty dirs', () => {
    const tree = buildFileTree([
      entry('notes', 'dir'),
      entry('notes/01-design.md', 'file'),
      entry('scripts', 'dir'),
    ]);
    expect(names(tree)).toEqual(['notes', 'scripts']);
    expect(names(tree[0].children)).toEqual(['01-design.md']);
    expect(tree[1].children).toEqual([]);
  });

  it('builds deep nesting with dir entries at every level', () => {
    const tree = buildFileTree([
      entry('local', 'dir'),
      entry('local/candidates', 'dir'),
      entry('local/candidates/a.png', 'file'),
    ]);
    const local = tree[0];
    expect(local.name).toBe('local');
    expect(names(local.children)).toEqual(['candidates']);
    expect(names(local.children[0].children)).toEqual(['a.png']);
  });

  it('synthesizes a missing parent dir node instead of dropping the file', () => {
    const tree = buildFileTree([entry('notes/01.md', 'file')]);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ name: 'notes', kind: 'dir', path: '/proj/notes' });
    expect(names(tree[0].children)).toEqual(['01.md']);
  });

  it('sorts dirs before files, alphabetical within each group', () => {
    const tree = buildFileTree([
      entry('zebra.md', 'file'),
      entry('notes', 'dir'),
      entry('alpha.md', 'file'),
      entry('assets', 'dir'),
    ]);
    expect(names(tree)).toEqual(['assets', 'notes', 'alpha.md', 'zebra.md']);
  });

  it('sorts local/ last among top-level dirs but before files', () => {
    const tree = buildFileTree([
      entry('local', 'dir'),
      entry('assets', 'dir'),
      entry('notes', 'dir'),
      entry('todo.md', 'file'),
    ]);
    expect(names(tree)).toEqual(['assets', 'notes', 'local', 'todo.md']);
  });

  it('does not treat a nested dir named local specially', () => {
    const tree = buildFileTree([
      entry('notes', 'dir'),
      entry('notes/local', 'dir'),
      entry('notes/archive', 'dir'),
    ]);
    expect(names(tree[0].children)).toEqual(['archive', 'local']);
  });
});

describe('defaultExpanded', () => {
  const dir = (name: string, relPath = name): FileTreeNode => ({
    name,
    relPath,
    path: `/proj/${relPath}`,
    kind: 'dir',
    children: [],
  });

  it('expands top-level dirs', () => {
    expect(defaultExpanded(dir('notes'), 0)).toBe(true);
  });

  it('collapses local/ by default', () => {
    expect(defaultExpanded(dir('local'), 0)).toBe(false);
  });

  it('collapses nested dirs by default', () => {
    expect(defaultExpanded(dir('candidates', 'local/candidates'), 1)).toBe(false);
  });
});

describe('isLocalScratch', () => {
  it('matches the local dir and its contents, not lookalikes', () => {
    expect(isLocalScratch({ relPath: 'local', kind: 'dir' })).toBe(true);
    expect(isLocalScratch({ relPath: 'local/a.png', kind: 'file' })).toBe(true);
    expect(isLocalScratch({ relPath: 'localize.md', kind: 'file' })).toBe(false);
    expect(isLocalScratch({ relPath: 'notes/local', kind: 'dir' })).toBe(false);
  });

  it('does not dim a top-level file that happens to be named local', () => {
    expect(isLocalScratch({ relPath: 'local', kind: 'file' })).toBe(false);
  });
});
