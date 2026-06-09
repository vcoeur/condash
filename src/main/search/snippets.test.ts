import { describe, expect, it } from 'vitest';
import { parseQuery } from './query';
import { buildRegions } from './regions';
import { buildSnippets } from './snippets';

function snippetsFor(raw: string, query: string) {
  return buildSnippets(raw, parseQuery(query), buildRegions(raw, 'knowledge'));
}

describe('buildSnippets', () => {
  it('adds ellipses on both sides for a mid-document hit', () => {
    const raw = `${'a'.repeat(100)} needle ${'b'.repeat(100)}`;
    const [snippet] = snippetsFor(raw, 'needle');
    expect(snippet.text.startsWith('…')).toBe(true);
    expect(snippet.text.endsWith('…')).toBe(true);
    const match = snippet.matches[0];
    expect(snippet.text.slice(match.start, match.start + match.length)).toBe('needle');
  });

  it('omits the leading ellipsis when the window starts at the file start', () => {
    const raw = `needle ${'b'.repeat(200)}`;
    const [snippet] = snippetsFor(raw, 'needle');
    expect(snippet.text.startsWith('…')).toBe(false);
    expect(snippet.text.endsWith('…')).toBe(true);
  });

  it('omits the trailing ellipsis when the window reaches the file end', () => {
    const raw = `${'a'.repeat(200)} needle`;
    const [snippet] = snippetsFor(raw, 'needle');
    expect(snippet.text.startsWith('…')).toBe(true);
    expect(snippet.text.endsWith('…')).toBe(false);
  });

  it('collapses overlapping windows into one snippet carrying both matches', () => {
    const raw = 'needle one two needle';
    const snippets = snippetsFor(raw, 'needle');
    expect(snippets).toHaveLength(1);
    expect(snippets[0].matches).toHaveLength(2);
  });

  it('caps the output at three snippets', () => {
    const raw = Array.from({ length: 5 }, () => `needle ${'x'.repeat(150)}`).join(' ');
    expect(snippetsFor(raw, 'needle')).toHaveLength(3);
  });

  it('surfaces higher-ranked regions first', () => {
    const raw = `body needle here ${'x'.repeat(200)}\n# needle title\n`;
    const snippets = snippetsFor(raw, 'needle');
    expect(snippets[0].region).toBe('h1');
  });

  it('keeps highlight offsets aligned when content contains U+0130', () => {
    const raw = `${'İ'.repeat(3)} prefix needle suffix`;
    const [snippet] = snippetsFor(raw, 'needle');
    const match = snippet.matches[0];
    expect(snippet.text.slice(match.start, match.start + match.length)).toBe('needle');
  });
});
