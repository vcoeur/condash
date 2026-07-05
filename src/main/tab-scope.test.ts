import { describe, expect, it } from 'vitest';
import { parseSize, scopeArgv, wrapWithMemoryScope } from './tab-scope';

describe('parseSize', () => {
  it('parses systemd size strings to bytes (base 1024)', () => {
    expect(parseSize('8G')).toBe(8 * 1024 ** 3);
    expect(parseSize('512M')).toBe(512 * 1024 ** 2);
    expect(parseSize('2G')).toBe(2 * 1024 ** 3);
    expect(parseSize('1024')).toBe(1024);
    expect(parseSize('1.5G')).toBe(Math.round(1.5 * 1024 ** 3));
  });

  it('returns undefined for non-numeric caps', () => {
    expect(parseSize('infinity')).toBeUndefined();
    expect(parseSize('')).toBeUndefined();
    expect(parseSize('lots')).toBeUndefined();
  });
});

describe('scopeArgv', () => {
  it('applies the default limits when prefs are absent', () => {
    const argv = scopeArgv('/bin/bash', ['-lc', 'agedum cline'], undefined);
    expect(argv).toEqual([
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      '-p',
      'MemoryHigh=6G',
      '-p',
      'MemoryMax=8G',
      '-p',
      'MemorySwapMax=2G',
      '--',
      '/bin/bash',
      '-lc',
      'agedum cline',
    ]);
  });

  it('honours per-field overrides and preserves the target program + args', () => {
    const argv = scopeArgv('agedum', ['claude'], { max: '12G', swapMax: '0' });
    expect(argv).toContain('MemoryMax=12G');
    expect(argv).toContain('MemorySwapMax=0');
    // Unset field falls back to its default.
    expect(argv).toContain('MemoryHigh=6G');
    // The wrapped command trails after the `--` separator, in order.
    expect(argv.slice(argv.indexOf('--'))).toEqual(['--', 'agedum', 'claude']);
  });
});

describe('wrapWithMemoryScope', () => {
  it('passes the spawn through unchanged when explicitly disabled', () => {
    // enabled:false short-circuits before any host probing, so this is
    // deterministic regardless of platform.
    expect(wrapWithMemoryScope('/bin/bash', ['-i'], { enabled: false })).toEqual({
      program: '/bin/bash',
      argv: ['-i'],
    });
  });
});
