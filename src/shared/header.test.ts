import { describe, expect, it } from 'vitest';
import { iterUnfencedLines, parseHeader, validateHeader } from './header';

describe('parseHeader — bold-prose (legacy)', () => {
  it('extracts every standard field', () => {
    const raw = [
      '# Hello',
      '',
      '**Date**: 2026-05-08',
      '**Kind**: project',
      '**Status**: now',
      '**Apps**: `app-a`, `app-b`',
      '**Branch**: `feat-x`',
      '**Base**: `main`',
      '',
      '## Goal',
    ].join('\n');
    const h = parseHeader(raw);
    expect(h.title).toBe('Hello');
    expect(h.date).toBe('2026-05-08');
    expect(h.kind).toBe('project');
    expect(h.status).toBe('now');
    expect(h.apps).toEqual(['app-a', 'app-b']);
    expect(h.branch).toBe('feat-x');
    expect(h.base).toBe('main');
  });

  it('preserves unrecognised meta as extra (severity, environment, verified)', () => {
    const raw = [
      '# Incident',
      '',
      '**Date**: 2026-05-01',
      '**Kind**: incident',
      '**Status**: now',
      '**Apps**: `frontend`',
      '**Environment**: PROD',
      '**Severity**: high — checkout broken',
      '',
      '## Description',
    ].join('\n');
    const h = parseHeader(raw);
    expect(h.extra.environment).toBe('PROD');
    expect(h.extra.severity).toBe('high — checkout broken');
  });
});

describe('parseHeader — YAML frontmatter', () => {
  it('extracts every standard field from a sequence-style apps list', () => {
    const raw = [
      '---',
      'date: 2026-05-08',
      'kind: project',
      'status: now',
      'apps:',
      '  - app-a',
      '  - app-b',
      'branch: feat-x',
      'base: main',
      '---',
      '',
      '# Hello',
      '',
      '## Goal',
    ].join('\n');
    const h = parseHeader(raw);
    expect(h.title).toBe('Hello');
    expect(h.date).toBe('2026-05-08');
    expect(h.kind).toBe('project');
    expect(h.status).toBe('now');
    expect(h.apps).toEqual(['app-a', 'app-b']);
    expect(h.branch).toBe('feat-x');
    expect(h.base).toBe('main');
  });

  it('accepts flow-style apps array', () => {
    const raw = ['---', 'apps: [a, b, c]', '---', '', '# T'].join('\n');
    expect(parseHeader(raw).apps).toEqual(['a', 'b', 'c']);
  });

  it('accepts apps as comma-separated string fallback', () => {
    const raw = ['---', 'apps: "a, b, c"', '---', '', '# T'].join('\n');
    expect(parseHeader(raw).apps).toEqual(['a', 'b', 'c']);
  });

  it('lower-cases status + kind', () => {
    const raw = ['---', 'status: NOW', 'kind: Project', '---', '', '# T'].join('\n');
    const h = parseHeader(raw);
    expect(h.status).toBe('now');
    expect(h.kind).toBe('project');
  });

  it('treats malformed YAML as missing fields rather than throwing', () => {
    const raw = ['---', 'this is: : : not yaml', '  - bad indent', '---', '', '# T'].join('\n');
    expect(() => parseHeader(raw)).not.toThrow();
    const h = parseHeader(raw);
    expect(h.title).toBe('T');
    expect(h.status).toBeNull();
  });

  it('composes severity + severity_impact into extra.severity for legacy consumers', () => {
    const raw = [
      '---',
      'kind: incident',
      'severity: high',
      'severity_impact: checkout broken',
      '---',
      '',
      '# Inc',
    ].join('\n');
    const h = parseHeader(raw);
    expect(h.extra.severity).toBe('high — checkout broken');
    expect(h.extra.severity_impact).toBe('checkout broken');
  });

  it('handles CRLF line endings', () => {
    const raw = ['---', 'date: 2026-05-08', 'status: now', '---', '', '# T'].join('\r\n');
    const h = parseHeader(raw);
    expect(h.date).toBe('2026-05-08');
    expect(h.status).toBe('now');
    expect(h.title).toBe('T');
  });

  it('falls through to bold-prose path when there is no frontmatter', () => {
    const raw = ['# Title', '', '**Status**: now', '', '## Goal'].join('\n');
    expect(parseHeader(raw).status).toBe('now');
  });

  it('tolerates trailing spaces on the --- delimiter lines', () => {
    // Shared rule with mutate-status / rewrite-headers: a `--- ` line is
    // still a frontmatter fence, so all three dispatchers agree.
    const raw = ['--- ', 'date: 2026-05-08', 'status: now', '---  ', '', '# T'].join('\n');
    const h = parseHeader(raw);
    expect(h.date).toBe('2026-05-08');
    expect(h.status).toBe('now');
    expect(h.title).toBe('T');
  });
});

describe('iterUnfencedLines — fence-marker matching', () => {
  const yielded = (lines: string[]): string[] => [...iterUnfencedLines(lines)].map((x) => x.line);

  it('treats a ``` line inside a ~~~ fence as content, not a toggle', () => {
    const lines = ['before', '~~~markdown', '```bash', 'echo hi', '```', '~~~', 'after'];
    expect(yielded(lines)).toEqual(['before', 'after']);
  });

  it('only closes a backtick fence on a run at least as long as the opener', () => {
    const lines = ['````', '```', 'still fenced', '````', 'after'];
    expect(yielded(lines)).toEqual(['after']);
  });

  it('still handles plain matched fences', () => {
    const lines = ['a', '```', 'fenced', '```', 'b'];
    expect(yielded(lines)).toEqual(['a', 'b']);
  });
});

describe('validateHeader (unchanged behaviour across both shapes)', () => {
  const folder = '/tmp/projects/2026-05/2026-05-08-foo/README.md';

  it('flags an unknown status as an error in YAML form', () => {
    const raw = [
      '---',
      'date: 2026-05-08',
      'status: doing',
      'kind: project',
      '---',
      '',
      '# T',
    ].join('\n');
    const v = validateHeader(parseHeader(raw), folder);
    expect(v.errors.some((e) => e.field === 'status')).toBe(true);
  });

  it('flags an unknown status as an error in bold-prose form', () => {
    const raw = [
      '# T',
      '',
      '**Date**: 2026-05-08',
      '**Status**: doing',
      '**Kind**: project',
      '**Apps**: `x`',
      '',
      '## Goal',
    ].join('\n');
    const v = validateHeader(parseHeader(raw), folder);
    expect(v.errors.some((e) => e.field === 'status')).toBe(true);
  });
});

describe('parseHeader — parent field', () => {
  it('reads parent from YAML frontmatter and keeps it out of extra', () => {
    const raw = [
      '---',
      'date: 2026-07-20',
      'kind: project',
      'status: now',
      'apps:',
      '  - condash',
      'parent: 2026-07-15-checkout-revamp',
      '---',
      '',
      '# Cart',
      '',
      '## Goal',
    ].join('\n');
    const h = parseHeader(raw);
    expect(h.parent).toBe('2026-07-15-checkout-revamp');
    expect(h.extra.parent).toBeUndefined();
  });

  it('reads parent from a bold-prose header, bare or backticked', () => {
    const bare = parseHeader(
      [
        '# Cart',
        '',
        '**Status**: now',
        '**Parent**: 2026-07-15-checkout-revamp',
        '',
        '## Goal',
      ].join('\n'),
    );
    expect(bare.parent).toBe('2026-07-15-checkout-revamp');
    expect(bare.extra.parent).toBeUndefined();
    const ticked = parseHeader(
      [
        '# Cart',
        '',
        '**Status**: now',
        '**Parent**: `2026-07-15-checkout-revamp`',
        '',
        '## Goal',
      ].join('\n'),
    );
    expect(ticked.parent).toBe('2026-07-15-checkout-revamp');
  });

  it('defaults parent to null when absent', () => {
    expect(parseHeader(['---', 'status: now', '---', '', '# X'].join('\n')).parent).toBeNull();
  });
});

describe('validateHeader — parent self-reference', () => {
  it('errors when parent points at the item itself', () => {
    const folder = '/tmp/projects/2026-07/2026-07-15-plan/README.md';
    const raw = [
      '---',
      'date: 2026-07-15',
      'kind: project',
      'status: now',
      'apps:',
      '  - condash',
      'parent: 2026-07-15-plan',
      '---',
      '',
      '# Plan',
    ].join('\n');
    const v = validateHeader(parseHeader(raw), folder);
    expect(v.errors.some((e) => e.field === 'parent')).toBe(true);
  });

  it('accepts a parent pointing at a different item', () => {
    const folder = '/tmp/projects/2026-07/2026-07-20-cart/README.md';
    const raw = [
      '---',
      'date: 2026-07-20',
      'kind: project',
      'status: now',
      'apps:',
      '  - condash',
      'parent: 2026-07-15-plan',
      '---',
      '',
      '# Cart',
    ].join('\n');
    const v = validateHeader(parseHeader(raw), folder);
    expect(v.errors.some((e) => e.field === 'parent')).toBe(false);
  });
});
