import { describe, expect, it } from 'vitest';
import { extractRegion, replaceRegion } from './templates';

describe('extractRegion', () => {
  it('returns content between markers, exclusive of marker lines', () => {
    const content = [
      '<!-- condash:general:begin -->',
      '# Heading',
      '',
      'Body text.',
      '<!-- condash:general:end -->',
      '',
      '## Specific',
      'user content',
    ].join('\n');
    const region = extractRegion(content, 'condash:general');
    expect(region).toBe('# Heading\n\nBody text.');
  });

  it('returns null when begin marker is missing', () => {
    const content = ['# Heading', '<!-- condash:general:end -->'].join('\n');
    expect(extractRegion(content, 'condash:general')).toBeNull();
  });

  it('returns null when end marker is missing', () => {
    const content = ['<!-- condash:general:begin -->', '# Heading'].join('\n');
    expect(extractRegion(content, 'condash:general')).toBeNull();
  });

  it('returns null when end precedes begin', () => {
    const content = [
      '<!-- condash:general:end -->',
      'middle',
      '<!-- condash:general:begin -->',
    ].join('\n');
    expect(extractRegion(content, 'condash:general')).toBeNull();
  });

  it('returns empty string when markers are adjacent', () => {
    const content = ['<!-- condash:general:begin -->', '<!-- condash:general:end -->'].join('\n');
    expect(extractRegion(content, 'condash:general')).toBe('');
  });

  it('tolerates internal whitespace around the region name', () => {
    const content = [
      '<!--   condash:general:begin   -->',
      'X',
      '<!--   condash:general:end   -->',
    ].join('\n');
    expect(extractRegion(content, 'condash:general')).toBe('X');
  });

  it('rejects markers that share a line with other content', () => {
    const content = [
      'leading <!-- condash:general:begin -->',
      'X',
      '<!-- condash:general:end -->',
    ].join('\n');
    expect(extractRegion(content, 'condash:general')).toBeNull();
  });

  it('escapes regex metacharacters in the region name', () => {
    const content = [
      '<!-- condash:foo.bar:begin -->',
      'inside',
      '<!-- condash:foo.bar:end -->',
    ].join('\n');
    // The literal "condash:foo.bar" should match; "condash:fooXbar" must not.
    expect(extractRegion(content, 'condash:foo.bar')).toBe('inside');
    expect(extractRegion(content, 'condash:fooXbar')).toBeNull();
  });

  it('does not match a different region', () => {
    const content = [
      '<!-- condash:specific:begin -->',
      'inside',
      '<!-- condash:specific:end -->',
    ].join('\n');
    expect(extractRegion(content, 'condash:general')).toBeNull();
  });
});

describe('replaceRegion', () => {
  it('replaces region content while keeping marker lines verbatim', () => {
    const content = [
      'before',
      '<!-- condash:general:begin -->',
      'old content',
      '<!-- condash:general:end -->',
      'after',
    ].join('\n');
    const result = replaceRegion(content, 'condash:general', 'new\nmultiline\ncontent');
    expect(result).toBe(
      [
        'before',
        '<!-- condash:general:begin -->',
        'new',
        'multiline',
        'content',
        '<!-- condash:general:end -->',
        'after',
      ].join('\n'),
    );
  });

  it('preserves text outside the markers byte-for-byte', () => {
    const before = '## Specific to this conception\n\nuser-owned text\nwith trailing newline\n';
    const content =
      '<!-- condash:general:begin -->\nold\n<!-- condash:general:end -->\n\n' + before;
    const result = replaceRegion(content, 'condash:general', 'NEW');
    expect(result.endsWith('\n\n' + before)).toBe(true);
  });

  it('throws when markers are missing', () => {
    expect(() => replaceRegion('no markers here', 'condash:general', 'X')).toThrow(
      /Region condash:general not found/,
    );
  });
});

describe('extract + replace round-trip', () => {
  it('extract→replace with same content yields byte-identical output', () => {
    const content = [
      'top',
      '<!-- condash:general:begin -->',
      'inner',
      'lines',
      '<!-- condash:general:end -->',
      'bottom',
    ].join('\n');
    const region = extractRegion(content, 'condash:general')!;
    expect(replaceRegion(content, 'condash:general', region)).toBe(content);
  });
});
