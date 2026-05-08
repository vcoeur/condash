import { describe, expect, it } from 'vitest';
import { rewriteHeaderToYaml } from './rewrite-headers';
import { parseHeader } from '../shared/header';

describe('rewriteHeaderToYaml', () => {
  it('rewrites a standard bold-prose project header', () => {
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
      '',
      'Body.',
      '',
    ].join('\n');
    const r = rewriteHeaderToYaml(raw);
    expect(r.changed).toBe(true);
    expect(r.reason).toBe('rewritten');
    expect(r.newContent).toBeDefined();
    const out = r.newContent!;
    expect(out.startsWith('---\n')).toBe(true);
    expect(out).toContain('date: 2026-05-08');
    expect(out).toContain('kind: project');
    expect(out).toContain('status: now');
    expect(out).toContain('apps:\n  - app-a\n  - app-b');
    expect(out).toContain('branch: feat-x');
    expect(out).toContain('base: main');
    expect(out).toContain('# Hello');
    expect(out).toContain('## Goal');
    expect(out).toContain('Body.');
  });

  it('round-trips through parseHeader without losing fields', () => {
    const raw = [
      '# Inc',
      '',
      '**Date**: 2026-05-01',
      '**Kind**: incident',
      '**Status**: now',
      '**Apps**: `frontend`',
      '**Environment**: PROD',
      '**Severity**: high — checkout broken',
      '',
      '## Description',
      '',
    ].join('\n');
    const r = rewriteHeaderToYaml(raw);
    expect(r.changed).toBe(true);
    const parsed = parseHeader(r.newContent!);
    expect(parsed.title).toBe('Inc');
    expect(parsed.date).toBe('2026-05-01');
    expect(parsed.kind).toBe('incident');
    expect(parsed.status).toBe('now');
    expect(parsed.apps).toEqual(['frontend']);
    expect(parsed.extra.environment).toBe('PROD');
    expect(parsed.extra.severity).toBe('high — checkout broken');
  });

  it('is a no-op when the file already has YAML frontmatter', () => {
    const raw = ['---', 'status: now', '---', '', '# T', '', '## Goal'].join('\n');
    const r = rewriteHeaderToYaml(raw);
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('already-yaml');
    expect(r.newContent).toBeUndefined();
  });

  it('is idempotent — a rewritten file is recognised as already-yaml', () => {
    const raw = [
      '# T',
      '',
      '**Date**: 2026-05-08',
      '**Kind**: project',
      '**Status**: now',
      '**Apps**: `x`',
      '',
      '## Goal',
    ].join('\n');
    const first = rewriteHeaderToYaml(raw);
    expect(first.changed).toBe(true);
    const second = rewriteHeaderToYaml(first.newContent!);
    expect(second.changed).toBe(false);
    expect(second.reason).toBe('already-yaml');
  });

  it('refuses to rewrite when there is unexpected content between meta and first ##', () => {
    const raw = [
      '# T',
      '',
      '**Date**: 2026-05-08',
      '**Status**: now',
      '',
      'A stray paragraph that is neither meta nor a ## heading.',
      '',
      '## Goal',
    ].join('\n');
    const r = rewriteHeaderToYaml(raw);
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('unexpected-content');
  });

  it('returns no-h1 when the file has no H1 line', () => {
    const raw = ['Some prose here.', '', '## Goal'].join('\n');
    const r = rewriteHeaderToYaml(raw);
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('no-h1');
  });

  it('preserves CRLF line endings', () => {
    const raw = [
      '# T',
      '',
      '**Date**: 2026-05-08',
      '**Status**: now',
      '**Kind**: project',
      '**Apps**: `x`',
      '',
      '## Goal',
      '',
    ].join('\r\n');
    const r = rewriteHeaderToYaml(raw);
    expect(r.changed).toBe(true);
    expect(r.newContent).toContain('\r\n');
    expect(r.newContent).not.toMatch(/[^\r]\n/);
  });
});
