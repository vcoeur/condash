import { describe, expect, it } from 'vitest';
import { extractRegion, replaceRegion } from './templates';

describe('extractRegion', () => {
  it('returns body between heading and next H2, exclusive', () => {
    const content = [
      '# CLAUDE.md — conception',
      '',
      'Intro paragraph.',
      '',
      '## General',
      '',
      'Body line one.',
      'Body line two.',
      '',
      '## Specifics',
      'user-owned text',
    ].join('\n');
    const region = extractRegion(content, 'General');
    expect(region).toBe('\nBody line one.\nBody line two.');
  });

  it('returns null when the heading is missing', () => {
    const content = ['# Heading', '', '## Specifics', 'only'].join('\n');
    expect(extractRegion(content, 'General')).toBeNull();
  });

  it('returns null when the heading appears more than once (ambiguous)', () => {
    const content = [
      '# Heading',
      '',
      '## General',
      'first body',
      '',
      '## General',
      'second body',
    ].join('\n');
    expect(extractRegion(content, 'General')).toBeNull();
  });

  it('returns empty string when the heading has no body before the next H2', () => {
    const content = ['## General', '## Specifics', 'after'].join('\n');
    expect(extractRegion(content, 'General')).toBe('');
  });

  it('extends to EOF when there is no following H2', () => {
    const content = ['# Heading', '', '## General', '', 'Tail body.'].join('\n');
    expect(extractRegion(content, 'General')).toBe('\nTail body.');
  });

  it('does not match H3 or deeper headings of the same name', () => {
    const content = [
      '# Heading',
      '',
      '### General',
      'h3 body, must not match',
      '',
      '## Specifics',
    ].join('\n');
    expect(extractRegion(content, 'General')).toBeNull();
  });

  it('treats H2 boundary detection as H2-only — H3 stays inside the body', () => {
    const content = [
      '## General',
      'top body',
      '',
      '### Sub-heading',
      'sub body',
      '',
      '## Specifics',
      'specifics body',
    ].join('\n');
    expect(extractRegion(content, 'General')).toBe('top body\n\n### Sub-heading\nsub body');
  });

  it('rejects a heading line carrying inline content after the title', () => {
    const content = ['## General with extras', 'body', '', '## Specifics'].join('\n');
    expect(extractRegion(content, 'General')).toBeNull();
  });

  it('escapes regex metacharacters in the heading text', () => {
    const content = ['## foo.bar', 'body', '', '## Specifics'].join('\n');
    expect(extractRegion(content, 'foo.bar')).toBe('body');
    expect(extractRegion(content, 'fooXbar')).toBeNull();
  });

  it('matches the whole heading text only — substring lookups must fail', () => {
    const content = ['## Generalized', 'body', '', '## Specifics'].join('\n');
    expect(extractRegion(content, 'General')).toBeNull();
  });

  it('is case-sensitive on the heading text', () => {
    const content = ['## general', 'body', '', '## Specifics'].join('\n');
    expect(extractRegion(content, 'General')).toBeNull();
  });
});

describe('replaceRegion', () => {
  it('replaces the body while keeping the heading line and surrounding text', () => {
    const content = [
      '# CLAUDE.md — conception',
      '',
      '## General',
      'old body',
      '',
      '## Specifics',
      'user content',
    ].join('\n');
    const result = replaceRegion(content, 'General', 'new\nmultiline\nbody');
    expect(result).toBe(
      [
        '# CLAUDE.md — conception',
        '',
        '## General',
        'new',
        'multiline',
        'body',
        '',
        '## Specifics',
        'user content',
      ].join('\n'),
    );
  });

  it('preserves text outside the region byte-for-byte', () => {
    const after = '## Specifics\n\nuser-owned text\nwith trailing newline\n';
    const content = '# Top\n\n## General\nold body\n\n' + after;
    const result = replaceRegion(content, 'General', 'NEW');
    expect(result.endsWith('\n\n' + after)).toBe(true);
    expect(result.startsWith('# Top\n\n## General\n')).toBe(true);
  });

  it('appends a single trailing newline when the region runs to EOF', () => {
    const content = ['# Top', '', '## General', 'old body'].join('\n');
    const result = replaceRegion(content, 'General', 'NEW');
    expect(result).toBe('# Top\n\n## General\nNEW\n');
  });

  it('throws when the heading is missing', () => {
    expect(() => replaceRegion('## Specifics\nbody', 'General', 'X')).toThrow(
      /Region General not found/,
    );
  });

  it('throws when the heading is ambiguous', () => {
    const content = ['## General', 'a', '', '## General', 'b'].join('\n');
    expect(() => replaceRegion(content, 'General', 'X')).toThrow(/Region General not found/);
  });
});

describe('extract + replace round-trip', () => {
  it('extract→replace with the same body yields byte-identical output', () => {
    const content = [
      '# CLAUDE.md — conception',
      '',
      'intro paragraph',
      '',
      '## General',
      '',
      'inner body',
      'lines',
      '',
      '## Specifics',
      'specifics body',
    ].join('\n');
    const region = extractRegion(content, 'General')!;
    expect(replaceRegion(content, 'General', region)).toBe(content);
  });

  it('round-trips when the region runs to EOF', () => {
    const content = '# Top\n\n## General\nbody one\nbody two\n';
    const region = extractRegion(content, 'General')!;
    expect(replaceRegion(content, 'General', region)).toBe(content);
  });
});

/**
 * Gitignore-style parsing: heading prefix is `#` (single hash) and the
 * "next heading" regex must match only fixed sibling names — every gitignore
 * comment line starts with `#` and would otherwise be misread as a heading.
 */
describe('extractRegion — gitignore-style', () => {
  const opts = { mark: '#', siblings: ['Specifics'] };

  it('extracts the body between # General and # Specifics, ignoring intermediate `#` comments', () => {
    const content = [
      '# General',
      '# Shipped by condash.',
      '',
      '# Sentinels.',
      'projects/.index-dirty',
      '',
      '# OS cruft.',
      '.DS_Store',
      '',
      '# Specifics',
      '# User-owned patterns below.',
    ].join('\n');
    expect(extractRegion(content, 'General', opts)).toBe(
      [
        '# Shipped by condash.',
        '',
        '# Sentinels.',
        'projects/.index-dirty',
        '',
        '# OS cruft.',
        '.DS_Store',
      ].join('\n'),
    );
  });

  it('extracts the Specifics body to EOF', () => {
    const content = ['# General', 'standard', '', '# Specifics', 'custom-a', 'custom-b'].join('\n');
    expect(extractRegion(content, 'Specifics', opts)).toBe('custom-a\ncustom-b');
  });

  it('returns null when # General is missing', () => {
    const content = ['# Specifics', 'only'].join('\n');
    expect(extractRegion(content, 'General', opts)).toBeNull();
  });

  it('returns null when # General appears twice', () => {
    const content = ['# General', 'a', '', '# General', 'b', '', '# Specifics'].join('\n');
    expect(extractRegion(content, 'General', opts)).toBeNull();
  });

  it('does not treat an arbitrary `# Some comment` as a sibling heading', () => {
    const content = [
      '# General',
      'standard',
      '# Sentinels — not a section header, still part of General',
      'projects/.index-dirty',
      '',
      '# Specifics',
      'custom',
    ].join('\n');
    expect(extractRegion(content, 'General', opts)).toBe(
      [
        'standard',
        '# Sentinels — not a section header, still part of General',
        'projects/.index-dirty',
      ].join('\n'),
    );
  });

  it('matches the whole heading text only — # Generals (extra char) must fail', () => {
    const content = ['# Generals', 'body', '', '# Specifics'].join('\n');
    expect(extractRegion(content, 'General', opts)).toBeNull();
  });

  it('is case-sensitive — `# general` does not match `General`', () => {
    const content = ['# general', 'body', '', '# Specifics'].join('\n');
    expect(extractRegion(content, 'General', opts)).toBeNull();
  });

  it('rejects a heading carrying extra inline text', () => {
    const content = ['# General — shipped section', 'body', '', '# Specifics'].join('\n');
    expect(extractRegion(content, 'General', opts)).toBeNull();
  });
});

describe('replaceRegion — gitignore-style', () => {
  const opts = { mark: '#', siblings: ['Specifics'] };

  it('replaces the General body while preserving Specifics untouched', () => {
    const content = [
      '# General',
      '# old shipped comment',
      'old-pattern',
      '',
      '# Specifics',
      'user-pattern',
    ].join('\n');
    const result = replaceRegion(content, 'General', '# new shipped\nnew-pattern', opts);
    expect(result).toBe(
      ['# General', '# new shipped', 'new-pattern', '', '# Specifics', 'user-pattern'].join('\n'),
    );
  });

  it('throws when the heading is missing', () => {
    expect(() => replaceRegion('# Specifics\nx', 'General', 'X', opts)).toThrow(
      /Region General not found/,
    );
  });
});

describe('extract + replace round-trip — gitignore-style', () => {
  const opts = { mark: '#', siblings: ['Specifics'] };

  it('round-trips a realistic two-section gitignore', () => {
    const content = [
      '# General',
      '# Shipped by condash.',
      '',
      'projects/**/local/',
      '.condash/*',
      '!.condash/settings.json.example',
      '',
      '# Specifics',
      '# Per-conception patterns below.',
      '.env',
      '**/notes/factures/',
      '',
    ].join('\n');
    const body = extractRegion(content, 'General', opts)!;
    expect(replaceRegion(content, 'General', body, opts)).toBe(content);
  });
});
