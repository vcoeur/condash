import { describe, expect, it } from 'vitest';
import { resolvePath } from './md-link-router';

describe('resolvePath', () => {
  const doc = '/conception/knowledge/topics/note.md';

  it('resolves a sibling relative href against the document directory', () => {
    expect(resolvePath(doc, 'other.md')).toBe('/conception/knowledge/topics/other.md');
  });

  it('resolves ./ and nested relative segments', () => {
    expect(resolvePath(doc, './other.md')).toBe('/conception/knowledge/topics/other.md');
    expect(resolvePath(doc, 'sub/deep.md')).toBe('/conception/knowledge/topics/sub/deep.md');
  });

  it('resolves ../ traversal', () => {
    expect(resolvePath(doc, '../index.md')).toBe('/conception/knowledge/index.md');
    expect(resolvePath(doc, '../../projects/x.md')).toBe('/conception/projects/x.md');
  });

  it('clamps traversal past the filesystem root instead of underflowing', () => {
    expect(resolvePath('/a.md', '../../../etc/passwd')).toBe('/etc/passwd');
    expect(resolvePath(doc, '../../../../../../etc/passwd')).toBe('/etc/passwd');
  });

  it('keeps absolute hrefs absolute and normalises them', () => {
    expect(resolvePath(doc, '/x/./y/../z.md')).toBe('/x/z.md');
  });

  it('strips the hash and query portions', () => {
    expect(resolvePath(doc, 'other.md#section')).toBe('/conception/knowledge/topics/other.md');
    expect(resolvePath(doc, 'other.md?raw=1')).toBe('/conception/knowledge/topics/other.md');
    expect(resolvePath(doc, 'other.md?raw=1#x')).toBe('/conception/knowledge/topics/other.md');
  });

  it('collapses duplicate slashes and . segments', () => {
    expect(resolvePath(doc, 'a//b/./c.md')).toBe('/conception/knowledge/topics/a/b/c.md');
  });
});
