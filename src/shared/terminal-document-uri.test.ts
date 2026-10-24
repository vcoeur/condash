import { describe, expect, it } from 'vitest';
import { terminalDocumentPath } from './terminal-document-uri';

describe('terminalDocumentPath', () => {
  it.each([
    ['notes/guide.md', 'notes/guide.md'],
    ['../decision.mdx#questions', '../decision.mdx'],
    ['/workspace/a%20b.MD', '/workspace/a b.MD'],
    ['file:///workspace/decision.mdx', '/workspace/decision.mdx'],
    ['file://localhost/workspace/guide.md', '/workspace/guide.md'],
    ['file:///C:/conception/resources/guide.md', '/C:/conception/resources/guide.md'],
    ['file://localhost/C:/conception/decision%20form.mdx', '/C:/conception/decision form.mdx'],
  ])('decodes local document %s', (uri, pathname) => {
    expect(terminalDocumentPath(uri)).toBe(pathname);
  });

  it.each([
    '',
    'https://example.com/guide.md',
    'mailto:guide.md',
    'javascript:guide.md',
    'file://remote/workspace/guide.md',
    'file://remote/C:/conception/guide.md',
    'file:///C:/conception/guide%5cmd.md',
    'file:///C:/conception/guide%00.md',
    '//remote/guide.md',
    'guide.pdf',
    'guide.md?command=run',
    'guide%xx.md',
    'guide%00.md',
    'guide%0a.md',
    'guide\\note.md',
    'file:///workspace/guide.md?query',
    'a'.repeat(8193) + '.md',
  ])('rejects unsupported or malformed target %s', (uri) => {
    expect(terminalDocumentPath(uri)).toBeNull();
  });
});
