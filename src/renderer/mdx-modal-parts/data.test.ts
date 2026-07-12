import { describe, expect, it } from 'vitest';
import { parsePlanMdx } from '../../shared/plan-blocks/parse-mdx';
import type { QuestionFormData } from '../../shared/plan-blocks/schemas';
import {
  annotatedLines,
  applyAnswers,
  buildFileTree,
  computeSplitRows,
  computeUnifiedRows,
  findQuestionFormSpan,
  kitNodesToHtml,
  parseLineRange,
  scopeCss,
  serializeLiteral,
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

describe('question-form answers', () => {
  const doc = (form: string): string =>
    ['---', 'kind: plan', '---', '', '### Open Questions', '', form, ''].join('\n');

  const FORM =
    '<QuestionForm id="oq" questions={[' +
    '{ id: "q1", title: "Pick one", mode: "single", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }, ' +
    '{ id: "q2", title: "Pick many", mode: "multi", options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }] }, ' +
    '{ id: "q3", title: "Say", mode: "freeform" }' +
    ']} submitLabel="Go" />';

  const questions = () => {
    const block = parsePlanMdx(doc(FORM)).blocks.find((b) => b.type === 'question-form');
    return (block!.data as unknown as QuestionFormData).questions;
  };

  it('writes single/multi/freeform answers back and re-parses them', () => {
    const next = applyAnswers(doc(FORM), 'oq', questions(), 'Go', {
      q1: 'b',
      q2: ['x', 'y'],
      q3: 'hello',
    });
    // Everything before the block is byte-identical.
    expect(next.startsWith('---\nkind: plan\n---\n\n### Open Questions')).toBe(true);
    const parsed = parsePlanMdx(next);
    expect(parsed.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const qs = (
      parsed.blocks.find((b) => b.type === 'question-form')!.data as unknown as QuestionFormData
    ).questions;
    expect(qs[0].answer).toBe('b');
    expect(qs[1].answer).toEqual(['x', 'y']);
    expect(qs[2].answer).toBe('hello');
  });

  it('is idempotent and clears an answer for an empty value', () => {
    const once = applyAnswers(doc(FORM), 'oq', questions(), 'Go', { q1: 'a' });
    expect(applyAnswers(once, 'oq', questions(), 'Go', { q1: 'a' })).toBe(once);
    const cleared = applyAnswers(once, 'oq', questions(), 'Go', { q1: '' });
    const qs = (
      parsePlanMdx(cleared).blocks.find((b) => b.type === 'question-form')!
        .data as unknown as QuestionFormData
    ).questions;
    expect(qs[0].answer).toBeUndefined();
  });

  it('leaves the source unchanged for an unknown block id', () => {
    const source = doc(FORM);
    expect(applyAnswers(source, 'nope', questions(), 'Go', { q1: 'a' })).toBe(source);
  });

  it('serializeLiteral emits parser-compatible identifier-keyed literals', () => {
    expect(serializeLiteral({ id: 'a', n: 2, ok: true })).toBe('{ id: "a", n: 2, ok: true }');
    expect(serializeLiteral(['x', 'y'])).toBe('["x", "y"]');
  });

  it('findQuestionFormSpan ignores a /> inside a string attribute value', () => {
    const tricky =
      '<QuestionForm id="oq" questions={[{ id: "q", title: "a /> b", mode: "freeform" }]} />';
    const span = findQuestionFormSpan(tricky, 'oq');
    expect(span).not.toBeNull();
    expect(tricky.slice(span!.start, span!.end)).toBe(tricky);
  });
});
