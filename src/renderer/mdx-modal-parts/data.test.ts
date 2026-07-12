import { describe, expect, it } from 'vitest';
import {
  annotatedLines,
  buildFileTree,
  computeSplitRows,
  computeUnifiedRows,
  kitNodesToHtml,
  parseLineRange,
  scopeCss,
  tryParseJson,
} from './data';

describe('parseLineRange / annotatedLines', () => {
  it('parses single lines and ranges', () => {
    expect(parseLineRange('12')).toEqual({ start: 12, end: 12 });
    expect(parseLineRange('12-18')).toEqual({ start: 12, end: 18 });
    expect(parseLineRange('18 - 12')).toEqual({ start: 12, end: 18 });
    expect(parseLineRange('nope')).toBeNull();
  });

  it('collects covered lines per side (default after)', () => {
    const annotations = [
      { lines: '2-3', note: 'a' },
      { lines: '5', note: 'b', side: 'before' as const },
    ];
    expect([...annotatedLines(annotations, 'after')]).toEqual([2, 3]);
    expect([...annotatedLines(annotations, 'before')]).toEqual([5]);
  });
});

describe('diff rows', () => {
  const changes = [
    { value: 'a\n' },
    { value: 'b\n', removed: true },
    { value: 'B\nB2\n', added: true },
    { value: 'c\n' },
  ];

  it('pairs removed/added runs side by side in split view', () => {
    const rows = computeSplitRows(changes);
    expect(rows).toHaveLength(4);
    expect(rows[0].left?.text).toBe('a');
    expect(rows[0].right?.text).toBe('a');
    expect(rows[1]).toEqual({
      left: { num: 2, text: 'b', kind: 'removed' },
      right: { num: 2, text: 'B', kind: 'added' },
    });
    expect(rows[2].left).toBeUndefined();
    expect(rows[2].right?.text).toBe('B2');
    expect(rows[3].left?.num).toBe(3);
    expect(rows[3].right?.num).toBe(4);
  });

  it('flattens to unified rows with per-side numbering', () => {
    const rows = computeUnifiedRows(changes);
    expect(rows.map((r) => r.kind)).toEqual(['context', 'removed', 'added', 'added', 'context']);
    expect(rows[1].numBefore).toBe(2);
    expect(rows[1].numAfter).toBeUndefined();
    expect(rows[4]).toMatchObject({ numBefore: 3, numAfter: 4 });
  });
});

describe('buildFileTree', () => {
  it('folds slash paths into nested nodes and keeps entry metadata', () => {
    const tree = buildFileTree([
      { path: 'src/a.ts', change: 'modified' },
      { path: 'src/deep/b.ts', change: 'added' },
      { path: 'README.md' },
    ]);
    expect(tree.map((n) => n.name)).toEqual(['src', 'README.md']);
    expect(tree[0].children.map((n) => n.name)).toEqual(['a.ts', 'deep']);
    expect(tree[0].children[0].entry?.change).toBe('modified');
    expect(tree[0].children[1].children[0].path).toBe('src/deep/b.ts');
  });
});

describe('kitNodesToHtml', () => {
  it('maps known kit elements and escapes text', () => {
    const html = kitNodesToHtml([
      {
        el: 'Row',
        props: {},
        children: [
          { el: 'Title', props: { text: 'A <b>' }, children: [] },
          { el: 'Btn', props: { label: 'Save', primary: true }, children: [] },
          { el: 'Weird', props: { text: 'x' }, children: [] },
        ],
      },
    ]);
    expect(html).toContain('<h3>A &lt;b&gt;</h3>');
    expect(html).toContain('<button class="primary">Save</button>');
    expect(html).toContain('wf-box');
  });
});

describe('scopeCss', () => {
  it('prefixes selectors, recurses into @media, drops other at-rules', () => {
    const scoped = scopeCss(
      '.a, .b { color: var(--wf-ink); } @media (min-width: 10px) { .c { gap: 2px; } } @import url(x); @font-face { font-family: X; }',
      '#scope',
    );
    expect(scoped).toContain('#scope .a, #scope .b { color: var(--wf-ink); }');
    expect(scoped).toContain('@media (min-width: 10px) { #scope .c { gap: 2px; } }');
    expect(scoped).not.toContain('@import');
    expect(scoped).not.toContain('font-family');
  });
});

describe('tryParseJson', () => {
  it('returns value or error', () => {
    expect(tryParseJson('{"a":1}')).toEqual({ value: { a: 1 } });
    expect(tryParseJson('nope').error).toBeTruthy();
  });
});
