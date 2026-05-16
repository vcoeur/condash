import { describe, expect, it } from 'vitest';
import {
  assertNoExtraFlags,
  parseArgs,
  parseCsvFlag,
  parseIntFlag,
  suggestFlag,
  takeUniversalFlags,
  UsageError,
} from './parser';

describe('parseArgs', () => {
  it('returns nulls for noun/verb when argv is empty', () => {
    const r = parseArgs([]);
    expect(r.noun).toBeNull();
    expect(r.verb).toBeNull();
    expect(r.positional).toEqual([]);
    expect(r.flags).toEqual({});
  });

  it('parses noun + verb + positional', () => {
    const r = parseArgs(['projects', 'read', 'my-slug', 'extra']);
    expect(r.noun).toBe('projects');
    expect(r.verb).toBe('read');
    expect(r.positional).toEqual(['my-slug', 'extra']);
  });

  it('parses --flag value pairs', () => {
    const r = parseArgs(['projects', 'list', '--status', 'now', '--limit', '5']);
    expect(r.flags).toEqual({ status: 'now', limit: '5' });
  });

  it('parses --flag=value form', () => {
    const r = parseArgs(['projects', 'list', '--status=now']);
    expect(r.flags.status).toBe('now');
  });

  it('parses boolean flags', () => {
    const r = parseArgs(['projects', 'list', '--json', '--quiet']);
    expect(r.flags.json).toBe(true);
    expect(r.flags.quiet).toBe(true);
  });

  it('rejects boolean flags with a value via =', () => {
    expect(() => parseArgs(['x', 'y', '--json=true'])).toThrow(UsageError);
  });

  it('rejects duplicate flags', () => {
    expect(() => parseArgs(['x', 'y', '--status', 'now', '--status', 'later'])).toThrow(UsageError);
  });

  it('rejects empty flag name', () => {
    expect(() => parseArgs(['x', 'y', '--='])).toThrow(UsageError);
  });

  it('rejects --flag with no value', () => {
    expect(() => parseArgs(['x', 'y', '--status'])).toThrow(UsageError);
  });

  it('rejects --flag followed by another --flag', () => {
    expect(() => parseArgs(['x', 'y', '--status', '--json'])).toThrow(UsageError);
  });

  it('treats `--` as the start of positional-only', () => {
    const r = parseArgs(['x', 'y', '--', '--not-a-flag', 'thing']);
    expect(r.flags).toEqual({});
    expect(r.positional).toEqual(['--not-a-flag', 'thing']);
  });

  it('maps short flags via SHORT_TO_LONG', () => {
    const r = parseArgs(['-h']);
    expect(r.flags.help).toBe(true);
  });

  it('rejects unknown short flags', () => {
    expect(() => parseArgs(['-z'])).toThrow(UsageError);
  });

  it('passes a short flag through as a positional value when it follows a known --flag', () => {
    const r = parseArgs(['repos', 'list', '--repo', '-X']);
    expect(r.flags.repo).toBe('-X');
  });
});

describe('takeUniversalFlags', () => {
  it('extracts every universal flag and removes them from args.flags', () => {
    const args = parseArgs(['projects', 'list', '--json', '--quiet', '--no-color']);
    const u = takeUniversalFlags(args);
    expect(u.json).toBe(true);
    expect(u.quiet).toBe(true);
    expect(u.noColor).toBe(true);
    expect(args.flags).toEqual({});
  });

  it('rejects --json and --ndjson together', () => {
    const args = parseArgs(['x', 'y', '--json', '--ndjson']);
    expect(() => takeUniversalFlags(args)).toThrow(/mutually exclusive/);
  });

  it('trims whitespace on --conception path', () => {
    const args = parseArgs(['x', 'y', '--conception', '  /tmp/here  ']);
    const u = takeUniversalFlags(args);
    expect(u.conceptionPath).toBe('/tmp/here');
  });

  it('rejects empty --conception value', () => {
    const args = parseArgs(['x', 'y', '--conception', '   ']);
    expect(() => takeUniversalFlags(args)).toThrow(/empty/);
  });

  it('leaves command-specific flags in place', () => {
    const args = parseArgs(['projects', 'list', '--json', '--status', 'now']);
    takeUniversalFlags(args);
    expect(args.flags).toEqual({ status: 'now' });
  });
});

describe('assertNoExtraFlags', () => {
  it('does nothing when args.flags is empty', () => {
    const args = parseArgs(['x', 'y']);
    expect(() => assertNoExtraFlags(args)).not.toThrow();
  });

  it('throws naming the single offender', () => {
    const args = parseArgs(['x', 'y', '--statux', 'now']);
    expect(() => assertNoExtraFlags(args)).toThrow(/--statux/);
  });

  it('throws naming every offender when multiple', () => {
    const args = parseArgs(['x', 'y', '--foo', 'a', '--bar', 'b']);
    try {
      assertNoExtraFlags(args);
      throw new Error('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/--foo/);
      expect(msg).toMatch(/--bar/);
      expect(msg).toMatch(/Unknown flags/);
    }
  });

  it('appends a `(did you mean --X?)` hint when a sibling pool is supplied', () => {
    const args = parseArgs(['x', 'y', '--app', 'foo']);
    expect(() => assertNoExtraFlags(args, ['apps', 'kind', 'slug', 'title'])).toThrow(
      /Unknown flag: --app \(did you mean --apps\?\)/,
    );
  });

  it('emits no hint when nothing is within distance 2', () => {
    const args = parseArgs(['x', 'y', '--xyzzy', 'foo']);
    expect(() => assertNoExtraFlags(args, ['apps', 'kind', 'slug', 'title'])).toThrow(
      /^Unknown flag: --xyzzy$/,
    );
  });
});

describe('suggestFlag', () => {
  it('returns the closest valid flag at distance ≤ 2', () => {
    expect(suggestFlag('app', ['apps', 'kind', 'slug'])).toBe('apps');
    expect(suggestFlag('aps', ['apps', 'kind'])).toBe('apps');
    expect(suggestFlag('bracnh', ['branch', 'base'])).toBe('branch');
  });

  it('returns null when nothing is within distance 2', () => {
    expect(suggestFlag('xyzzy', ['apps', 'kind', 'slug'])).toBeNull();
  });

  it('returns null when two candidates tie', () => {
    // 'aps' is distance 1 from both 'apps' and 'ape' — a tie.
    expect(suggestFlag('aps', ['apps', 'ape'])).toBeNull();
  });
});

describe('parseIntFlag', () => {
  it('parses a positive integer string', () => {
    expect(parseIntFlag('42', 10)).toBe(42);
  });

  it('falls back when value is undefined', () => {
    expect(parseIntFlag(undefined, 10)).toBe(10);
  });

  it('falls back when value is a boolean', () => {
    expect(parseIntFlag(true, 10)).toBe(10);
  });

  it('falls back when value is non-numeric', () => {
    expect(parseIntFlag('abc', 10)).toBe(10);
  });

  it('falls back on zero or negative', () => {
    expect(parseIntFlag('0', 10)).toBe(10);
    expect(parseIntFlag('-3', 10)).toBe(10);
  });
});

describe('parseCsvFlag', () => {
  it('splits, trims, and drops empties', () => {
    expect(parseCsvFlag('a, b ,, c')).toEqual(['a', 'b', 'c']);
  });

  it('returns null for non-string input', () => {
    expect(parseCsvFlag(undefined)).toBeNull();
    expect(parseCsvFlag(true)).toBeNull();
  });

  it('returns null when every token is empty', () => {
    expect(parseCsvFlag('  ,, ')).toBeNull();
  });

  it('returns a single-element list for a bare token', () => {
    expect(parseCsvFlag('only')).toEqual(['only']);
  });
});
