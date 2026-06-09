/**
 * Handler-level tests for `condash config`: path / list / get / set / migrate.
 *
 * Tests that touch the global settings.json redirect XDG_CONFIG_HOME to a
 * tmp dir so they never mutate the real `~/.config/condash/settings.json`.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runConfig } from './config';
import {
  captureStdout,
  jsonCtx,
  makeTmpConception,
  parseJsonEnvelope,
  rmConception,
} from './test-helpers';
import { CliError } from '../output';

let conceptionPath: string;
let xdgTmp: string;
let savedXdg: string | undefined;

beforeEach(async () => {
  conceptionPath = await makeTmpConception();
  xdgTmp = await fs.mkdtemp(join(tmpdir(), 'condash-xdg-'));
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdgTmp;
});

afterEach(async () => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  await rmConception(conceptionPath);
  await fs.rm(xdgTmp, { recursive: true, force: true });
});

describe('config path', () => {
  it('prints both global + conception settings paths', async () => {
    const { stdout, threw } = await captureStdout(() =>
      runConfig(
        'path',
        { noun: 'config', verb: 'path', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<{ global: string; conception: string }>(stdout).data!;
    expect(data.global).toContain('condash');
    expect(data.global).toContain('settings.json');
    expect(data.conception).toContain(conceptionPath);
  });
});

describe('config list', () => {
  it('default view reads condash.json from the conception', async () => {
    await fs.writeFile(
      join(conceptionPath, 'condash.json'),
      JSON.stringify({ theme: 'dark', repos: [] }),
      'utf8',
    );
    const { stdout } = await captureStdout(() =>
      runConfig(
        'list',
        { noun: 'config', verb: 'list', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const data = parseJsonEnvelope<{ theme: string }>(stdout).data!;
    expect(data.theme).toBe('dark');
  });

  it('--global reads from settings.json', async () => {
    // Pre-seed the redirected global settings file.
    const globalDir = join(xdgTmp, 'condash');
    await fs.mkdir(globalDir, { recursive: true });
    await fs.writeFile(
      join(globalDir, 'settings.json'),
      JSON.stringify({ theme: 'light' }),
      'utf8',
    );
    const { stdout } = await captureStdout(() =>
      runConfig(
        'list',
        { noun: 'config', verb: 'list', positional: [], flags: { global: true } },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const data = parseJsonEnvelope<{ theme: string }>(stdout).data!;
    expect(data.theme).toBe('light');
  });

  it('--effective + --global together throw USAGE', async () => {
    const { threw } = await captureStdout(() =>
      runConfig(
        'list',
        {
          noun: 'config',
          verb: 'list',
          positional: [],
          flags: { effective: true, global: true },
        },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(2);
  });
});

describe('config get', () => {
  it('reads a top-level key', async () => {
    await fs.writeFile(
      join(conceptionPath, 'condash.json'),
      JSON.stringify({ theme: 'dark' }),
      'utf8',
    );
    const { stdout } = await captureStdout(() =>
      runConfig(
        'get',
        { noun: 'config', verb: 'get', positional: ['theme'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(parseJsonEnvelope<string>(stdout).data).toBe('dark');
  });

  it('reads a dotted path', async () => {
    await fs.writeFile(
      join(conceptionPath, 'condash.json'),
      JSON.stringify({ terminal: { shell: '/bin/zsh' } }),
      'utf8',
    );
    const { stdout } = await captureStdout(() =>
      runConfig(
        'get',
        { noun: 'config', verb: 'get', positional: ['terminal.shell'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(parseJsonEnvelope<string>(stdout).data).toBe('/bin/zsh');
  });

  it('reads an array index via name[i]', async () => {
    await fs.writeFile(
      join(conceptionPath, 'condash.json'),
      JSON.stringify({ repos: [{ path: '/a' }, { path: '/b' }] }),
      'utf8',
    );
    const { stdout } = await captureStdout(() =>
      runConfig(
        'get',
        { noun: 'config', verb: 'get', positional: ['repos[1].path'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(parseJsonEnvelope<string>(stdout).data).toBe('/b');
  });

  it('NOT_FOUND when the key is missing', async () => {
    const { threw } = await captureStdout(() =>
      runConfig(
        'get',
        { noun: 'config', verb: 'get', positional: ['no.such.key'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(4);
  });

  it('USAGE when no key positional is given', async () => {
    const { threw } = await captureStdout(() =>
      runConfig(
        'get',
        { noun: 'config', verb: 'get', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(2);
  });
});

describe('config set', () => {
  it('writes a string value to .condash/settings.json by default', async () => {
    await captureStdout(() =>
      runConfig(
        'set',
        { noun: 'config', verb: 'set', positional: ['theme', 'dark'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const written = JSON.parse(
      await fs.readFile(join(conceptionPath, '.condash', 'settings.json'), 'utf8'),
    );
    expect(written.theme).toBe('dark');
  });

  it('parses JSON values when the input looks like one', async () => {
    await captureStdout(() =>
      runConfig(
        'set',
        { noun: 'config', verb: 'set', positional: ['count', '42'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const written = JSON.parse(
      await fs.readFile(join(conceptionPath, '.condash', 'settings.json'), 'utf8'),
    );
    expect(written.count).toBe(42);
  });

  it('writes to settings.json when --global is set', async () => {
    await captureStdout(() =>
      runConfig(
        'set',
        {
          noun: 'config',
          verb: 'set',
          positional: ['theme', 'light'],
          flags: { global: true },
        },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const written = JSON.parse(await fs.readFile(join(xdgTmp, 'condash', 'settings.json'), 'utf8'));
    expect(written.theme).toBe('light');
  });

  it('USAGE when key or value is missing', async () => {
    const { threw } = await captureStdout(() =>
      runConfig(
        'set',
        { noun: 'config', verb: 'set', positional: ['only-key'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(2);
  });

  it('warns when the written key is unknown to the schema (non-fatal)', async () => {
    const { stdout, threw } = await captureStdout(() =>
      runConfig(
        'set',
        {
          noun: 'config',
          verb: 'set',
          positional: ['audit.thresholds.binary', '5242880'],
          flags: {},
        },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const envelope = parseJsonEnvelope(stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.warnings?.some((w) => w.includes('audit'))).toBe(true);
    // The write itself still lands — the warning is advisory.
    const written = JSON.parse(
      await fs.readFile(join(conceptionPath, '.condash', 'settings.json'), 'utf8'),
    );
    expect(written.audit.thresholds.binary).toBe(5242880);
  });

  it('emits no warning for a schema-valid write', async () => {
    const { stdout } = await captureStdout(() =>
      runConfig(
        'set',
        { noun: 'config', verb: 'set', positional: ['theme', 'dark'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(parseJsonEnvelope(stdout).warnings).toEqual([]);
  });

  it('warns on an unknown key written with --global too', async () => {
    const { stdout } = await captureStdout(() =>
      runConfig(
        'set',
        {
          noun: 'config',
          verb: 'set',
          positional: ['no_such_key', 'x'],
          flags: { global: true },
        },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const envelope = parseJsonEnvelope(stdout);
    expect(envelope.warnings?.some((w) => w.includes('no_such_key'))).toBe(true);
  });

  it('rejects array-index keys loudly instead of writing a literal key', async () => {
    const { threw } = await captureStdout(() =>
      runConfig(
        'set',
        {
          noun: 'config',
          verb: 'set',
          positional: ['repositories[0].path', '/home/me/src/foo'],
          flags: {},
        },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(Error);
    expect((threw as Error).message).toMatch(/array-index/);
    // Nothing was written — the conception primary was never created.
    await expect(
      fs.readFile(join(conceptionPath, '.condash', 'settings.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('config migrate', () => {
  it('reports nothing-to-migrate on a tree with no legacy file', async () => {
    // makeTmpConception writes condash.json by default — strip it for this
    // test so the migrator sees a pristine tree.
    await fs.rm(join(conceptionPath, 'condash.json'), { force: true });
    const { stdout, threw } = await captureStdout(() =>
      runConfig(
        'migrate',
        { noun: 'config', verb: 'migrate', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<{ migrated: boolean }>(stdout).data!;
    expect(data.migrated).toBe(false);
  });

  it('migrates legacy condash.json → .condash/settings.json', async () => {
    // makeTmpConception already wrote `condash.json` — populate it.
    await fs.writeFile(
      join(conceptionPath, 'condash.json'),
      JSON.stringify({ theme: 'dark' }),
      'utf8',
    );
    const { threw } = await captureStdout(() =>
      runConfig(
        'migrate',
        { noun: 'config', verb: 'migrate', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const migrated = JSON.parse(
      await fs.readFile(join(conceptionPath, '.condash', 'settings.json'), 'utf8'),
    );
    expect(migrated.theme).toBe('dark');
  });
});

describe('runConfig dispatch', () => {
  it('rejects an unknown verb', async () => {
    const { threw } = await captureStdout(() =>
      runConfig(
        'banana',
        { noun: 'config', verb: 'banana', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(2);
  });

  it('--help prints help text', async () => {
    const { stdout, threw } = await captureStdout(() =>
      runConfig(
        'get',
        { noun: 'config', verb: 'get', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
        true,
      ),
    );
    expect(threw).toBeUndefined();
    expect(stdout).toMatch(/condash config get/);
  });
});
