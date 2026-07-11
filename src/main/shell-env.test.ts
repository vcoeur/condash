import { afterEach, describe, expect, it, vi } from 'vitest';
import * as shellEnv from './shell-env';

describe('buildProbeArgs', () => {
  it('runs the shell as login + interactive and runs a command', () => {
    const args = shellEnv.buildProbeArgs('/opt/condash/condash.bin', 'MARK');
    expect(args.slice(0, 3)).toEqual(['-l', '-i', '-c']);
    expect(args).toHaveLength(4);
  });

  it('embeds the marker on both sides of the env dump and single-quotes the binary', () => {
    const command = shellEnv.buildProbeArgs('/opt/condash/condash.bin', 'M4RK3R')[3];
    expect(command).toContain("'/opt/condash/condash.bin'");
    expect(command).toContain('JSON.stringify(process.env)');
    // The marker is emitted as a JS string literal twice (leading + trailing).
    expect(command.match(/"M4RK3R"/g)).toHaveLength(2);
  });

  it('escapes a single quote in the executable path', () => {
    const command = shellEnv.buildProbeArgs("/weird/it's/condash", 'MARK')[3];
    expect(command).toContain("'/weird/it'\\''s/condash'");
  });
});

describe('parseMarkedEnv', () => {
  const mark = 'abc123';

  it('extracts the JSON object framed by the markers', () => {
    const stdout = `motd banner\n${mark}{"PATH":"/a:/b","HOME":"/home/x"}${mark}\n`;
    expect(shellEnv.parseMarkedEnv(stdout, mark)).toEqual({ PATH: '/a:/b', HOME: '/home/x' });
  });

  it('tolerates rc-file noise before and after the framed payload', () => {
    const stdout = `Welcome!\nno job control\n${mark}{"PATH":"/usr/bin"}${mark}trailing junk`;
    expect(shellEnv.parseMarkedEnv(stdout, mark)).toEqual({ PATH: '/usr/bin' });
  });

  it('returns null when the markers are absent', () => {
    expect(shellEnv.parseMarkedEnv('nothing here', mark)).toBeNull();
  });

  it('returns null when only one marker is present', () => {
    expect(shellEnv.parseMarkedEnv(`${mark}{"PATH":"/a"}`, mark)).toBeNull();
  });

  it('returns null when the framed slice is not valid JSON', () => {
    expect(shellEnv.parseMarkedEnv(`${mark}not json${mark}`, mark)).toBeNull();
  });
});

describe('resolveLoginPath', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    shellEnv.resetLoginPathCache();
  });

  it('returns the PATH the probe shell reports', async () => {
    const run = async (shell: string, args: string[]) => {
      expect(shell).toBe(process.env.SHELL || '/bin/bash');
      // args[3] is the constructed command; echo back a framed env dump.
      const marker = args[3].match(/"([0-9a-f]+)"/)?.[1];
      return { stdout: `${marker}{"PATH":"/home/x/.opencode/bin:/usr/bin"}${marker}` };
    };
    expect(await shellEnv.resolveLoginPath(run)).toBe('/home/x/.opencode/bin:/usr/bin');
  });

  it('returns null when the probe output carries no PATH', async () => {
    const run = async (_shell: string, args: string[]) => {
      const marker = args[3].match(/"([0-9a-f]+)"/)?.[1];
      return { stdout: `${marker}{"HOME":"/home/x"}${marker}` };
    };
    expect(await shellEnv.resolveLoginPath(run)).toBeNull();
  });

  it('returns null when the probe shell throws', async () => {
    const run = async () => {
      throw new Error('spawn ENOENT');
    };
    expect(await shellEnv.resolveLoginPath(run)).toBeNull();
  });

  it('short-circuits to null on Windows without spawning', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    let called = false;
    const run = async () => {
      called = true;
      return { stdout: '' };
    };
    expect(await shellEnv.resolveLoginPath(run)).toBeNull();
    expect(called).toBe(false);
  });
});

describe('withPath', () => {
  const base = { HOME: '/home/x', PATH: '/usr/bin' };

  it('replaces PATH when a resolved path is supplied', () => {
    expect(shellEnv.withPath(base, '/a:/b')).toEqual({ HOME: '/home/x', PATH: '/a:/b' });
  });

  it('leaves PATH untouched when the resolved path is null', () => {
    expect(shellEnv.withPath(base, null)).toEqual(base);
  });

  it('never mutates the base env', () => {
    const copy = { ...base };
    shellEnv.withPath(base, '/changed');
    expect(base).toEqual(copy);
  });
});

describe('spawnPtyEnv', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    Object.assign(process.env, originalEnv);
    vi.restoreAllMocks();
  });

  it('sets TERM and scrubs npm_config_* leakage without mutating the base env', async () => {
    const base: NodeJS.ProcessEnv = {
      PATH: '/test/bin',
      npm_config_prefix: '/usr/local',
      npm_config_globalconfig: '/usr/local/etc/npmrc',
      npm_config_userconfig: '/home/x/.npmrc',
      CONDASH_TEST_KEEP: 'keep',
    };

    const env = await shellEnv.spawnPtyEnv(base);
    expect(env.TERM).toBe('xterm-256color');
    expect(env.PATH).toBe('/test/bin');
    expect(env.npm_config_prefix).toBeUndefined();
    expect(env.npm_config_globalconfig).toBeUndefined();
    expect(env.npm_config_userconfig).toBeUndefined();
    expect(env.CONDASH_TEST_KEEP).toBe('keep');
    expect(env).not.toBe(base);

    // The supplied base env is left intact.
    expect(base.npm_config_prefix).toBe('/usr/local');
    expect(base.CONDASH_TEST_KEEP).toBe('keep');
  });
});
