import { describe, expect, it } from 'vitest';
import {
  appScopeSetPropertyArgv,
  capOwnAppScope,
  defaultAppScopeMax,
  ownAppScopeUnit,
  parseSize,
  scopeArgv,
  wrapWithMemoryScope,
} from './tab-scope';

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

describe('defaultAppScopeMax', () => {
  it('leaves a reserve below physical RAM so the cgroup OOM fires first', () => {
    // 16 GiB − 3 GiB reserve = 13 GiB.
    expect(defaultAppScopeMax(16 * 1024 ** 3)).toBe(`${13 * 1024}M`);
  });

  it('floors at half RAM on a small-memory host', () => {
    // 4 GiB − 3 GiB = 1 GiB would be too tight; floor at half = 2 GiB.
    expect(defaultAppScopeMax(4 * 1024 ** 3)).toBe(`${2 * 1024}M`);
  });
});

describe('ownAppScopeUnit', () => {
  const line = (path: string) => `0::${path}\n`;

  it('returns condash’s own desktop-launched app scope', () => {
    expect(
      ownAppScopeUnit(
        line(
          '/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-condash-2845053.scope',
        ),
      ),
    ).toBe('app-gnome-condash-2845053.scope');
  });

  it('ignores a per-tab run scope (never cap a tab’s own scope)', () => {
    expect(
      ownAppScopeUnit(
        line('/user.slice/.../app.slice/run-r3cfbe4aae9a8403a9683d9f7f11acf28.scope'),
      ),
    ).toBeUndefined();
  });

  it('ignores a shared session scope and a foreign app scope', () => {
    expect(ownAppScopeUnit(line('/user.slice/user-1000.slice/session.scope'))).toBeUndefined();
    expect(
      ownAppScopeUnit(line('/user.slice/.../app.slice/app-gnome-Alacritty-999.scope')),
    ).toBeUndefined();
  });

  it('returns undefined off cgroup v2 (no unified 0:: line)', () => {
    expect(
      ownAppScopeUnit('1:name=systemd:/user.slice/app-gnome-condash-1.scope\n'),
    ).toBeUndefined();
  });
});

describe('appScopeSetPropertyArgv', () => {
  it('builds a runtime set-property call carrying both limits', () => {
    expect(appScopeSetPropertyArgv('app-gnome-condash-1.scope', '13G', '2G')).toEqual([
      '--user',
      'set-property',
      '--runtime',
      'app-gnome-condash-1.scope',
      'MemoryMax=13G',
      'MemorySwapMax=2G',
    ]);
  });
});

describe('capOwnAppScope', () => {
  it('is a no-op when the backstop is explicitly disabled', () => {
    // enabled:false short-circuits before any host probing → deterministic.
    expect(capOwnAppScope({ appScope: { enabled: false } })).toEqual({
      applied: false,
      skipped: 'disabled',
    });
  });
});
