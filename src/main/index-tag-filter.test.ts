import { describe, expect, it } from 'vitest';
import { isLowQualityTag, filterTags } from './index-tag-filter';

describe('isLowQualityTag', () => {
  it('rejects tags shorter than 3 characters', () => {
    expect(isLowQualityTag('a')).toBe(true);
    expect(isLowQualityTag('ab')).toBe(true);
    expect(isLowQualityTag('ci')).toBe(true);
    expect(isLowQualityTag('abc')).toBe(false);
  });

  it('rejects tags longer than 40 characters', () => {
    expect(isLowQualityTag('a'.repeat(40))).toBe(false);
    expect(isLowQualityTag('a'.repeat(41))).toBe(true);
  });

  it('rejects pure-numeric tags', () => {
    expect(isLowQualityTag('42')).toBe(true);
    expect(isLowQualityTag('2026')).toBe(true);
    expect(isLowQualityTag('v2')).toBe(true); // length 2 → also rejected by length rule
    expect(isLowQualityTag('2026q1')).toBe(false); // mixed alphanumeric is fine
  });

  it('rejects ISO-date-shaped tags', () => {
    expect(isLowQualityTag('2026-04')).toBe(true);
    expect(isLowQualityTag('2026-04-17')).toBe(true);
    expect(isLowQualityTag('2026-4-17')).toBe(false); // not ISO; treat as content
    expect(isLowQualityTag('q1-2026')).toBe(false);
  });

  it('rejects UUID-shaped tags (with and without dashes)', () => {
    expect(isLowQualityTag('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe(true);
    expect(isLowQualityTag('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')).toBe(true);
    expect(isLowQualityTag('aaaaaaaabbbbccccddddeeeeeeeeeeee')).toBe(true);
    expect(isLowQualityTag('not-a-uuid-just-words')).toBe(false);
  });

  it('rejects English stop-words and common content-free verbs', () => {
    for (const w of [
      'the',
      'and',
      'for',
      'with',
      'this',
      'that',
      'observation',
      'develop',
      'configure',
      'summary',
      'overview',
    ]) {
      expect(isLowQualityTag(w)).toBe(true);
    }
  });

  it('passes through legit hyphenated content tags', () => {
    for (const w of [
      'sandbox-testing',
      'caddy-access-log',
      'port-range-11111',
      'condash',
      'playwright',
      'electron-builder',
      'pii-stripping',
    ]) {
      expect(isLowQualityTag(w)).toBe(false);
    }
  });

  it('rejects leading/trailing-hyphen and flag-shaped tags', () => {
    for (const w of [
      'data-',
      '-light',
      '-dark',
      '-test',
      '--user-data-dir',
      '--ignore-files',
      '--exclude-dir',
      '--run',
      '--headed',
      '--export-type',
    ]) {
      expect(isLowQualityTag(w)).toBe(true);
    }
  });

  it('rejects dated-slug tags (ISO date plus a suffix)', () => {
    for (const w of [
      '2026-0405a',
      '2026-07-22-nodum-phase0-investigations',
      '2026-05-13-condash-terminal-logs',
    ]) {
      expect(isLowQualityTag(w)).toBe(true);
    }
  });

  it('rejects numeric ranges, numeric-prefixed words, hex literals and measurements', () => {
    for (const w of ['65-89', '53-63', '4-test', '3-test', '0x00', '66ms', '3.5gb']) {
      expect(isLowQualityTag(w)).toBe(true);
    }
  });

  it('rejects path fragments from inline path code spans', () => {
    for (const w of [
      'usr',
      'bin',
      'lib',
      'src',
      'tmp',
      'venv',
      'python3',
      'site-packages',
      'node_modules',
      'proc',
      'sys',
    ]) {
      expect(isLowQualityTag(w)).toBe(true);
    }
  });

  it('rejects code keywords', () => {
    for (const w of [
      'undefined',
      'false',
      'null',
      'true',
      'import',
      'export',
      'const',
      'let',
      'var',
      'return',
      'function',
      'async',
      'await',
      'void',
      'delete',
      'switch',
      'case',
      'default',
      'this',
      'class',
      'throw',
      'catch',
      'new',
      'extends',
    ]) {
      expect(isLowQualityTag(w)).toBe(true);
    }
  });

  it('rejects English common words beyond the original stop list', () => {
    for (const w of [
      'comes',
      'intent',
      'rather',
      'than',
      'bites',
      'both',
      'allow',
      'url',
      'make',
      'test',
      'case',
      'quietly',
      'survives',
      'guaranteed',
      'installed',
      'attribution',
      'rendered',
    ]) {
      expect(isLowQualityTag(w)).toBe(true);
    }
  });

  it('passes through the keep-list (borderline-but-real tags)', () => {
    for (const w of [
      'model-viewer',
      'django-imagekit',
      '3d-printing',
      'internal',
      'testing',
      'security',
      'ops',
      'frontend',
      'process',
      'media',
      'topics',
      'agedum',
      'agentsconf',
      'citekey',
      'knowledge',
      'node',
      'npm',
      'python',
      'docker',
      'systemd',
      'sqlite',
      'strftime',
      'cgroup',
      'mtime-seconds',
      'static',
      'paintings',
    ]) {
      expect(isLowQualityTag(w)).toBe(false);
    }
  });

  it('is case-insensitive on stop-words but tag identity is preserved by callers', () => {
    expect(isLowQualityTag('THE')).toBe(true);
    expect(isLowQualityTag('The')).toBe(true);
  });
});

describe('filterTags', () => {
  it('removes low-quality tags and preserves order + dedupes by exact-match', () => {
    const input = [
      'sandbox-testing',
      'the',
      'sandbox-testing', // dup
      '2026-04',
      'condash',
      'a',
      'caddy-access-log',
    ];
    expect(filterTags(input)).toEqual(['sandbox-testing', 'condash', 'caddy-access-log']);
  });

  it('returns an empty list when every tag is junk', () => {
    expect(filterTags(['the', 'and', '42', '2026-04'])).toEqual([]);
  });
});
