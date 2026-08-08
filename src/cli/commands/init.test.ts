/**
 * Tests for `condash init` — CLI bootstrap of a conception from the bundled
 * template (audit §5.14).
 *
 * Uses the real conception-template/ tree as the fixture (like
 * skills.test.ts), pointed at via CONDASH_TEMPLATE_ROOT — the same escape
 * hatch `locateShippedSkillsRoot` honours. `initConception`'s own electron
 * resolution is never reached under the override.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInit } from './init';
import { captureStdout, humanCtx, jsonCtx, parseJsonEnvelope } from './test-helpers';
import { CliError } from '../output';
import { UsageError } from '../parser';

const TEMPLATE_ROOT = resolve(__dirname, '..', '..', '..', 'conception-template');

let scratch: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(join(tmpdir(), 'condash-init-cmd-'));
  process.env.CONDASH_TEMPLATE_ROOT = TEMPLATE_ROOT;
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
  delete process.env.CONDASH_TEMPLATE_ROOT;
  vi.restoreAllMocks();
});

async function run(args: {
  verb?: string | null;
  positional?: string[];
  flags?: Record<string, string | boolean>;
}): Promise<{ stdout: string; threw: unknown }> {
  return captureStdout(() =>
    runInit(
      {
        noun: 'init',
        verb: args.verb ?? null,
        positional: args.positional ?? [],
        flags: args.flags ?? {},
      },
      jsonCtx(),
    ),
  );
}

describe('runInit', () => {
  it('lays down the template into a fresh --path dir with AGENTS.md substitution', async () => {
    const target = join(scratch, 'my-conception');
    const { stdout, threw } = await run({ flags: { path: target } });
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<{ path: string; created: string[] }>(stdout).data!;
    expect(data.path).toBe(target);
    expect(data.created.length).toBeGreaterThan(0);

    // The `.example` files materialise under their real names.
    await expect(fs.readFile(join(target, '.condash', 'settings.json'), 'utf8')).resolves.toContain(
      '{',
    );
    await expect(fs.readFile(join(target, 'projects', 'index.md'), 'utf8')).resolves.toBeTruthy();
    await expect(fs.readFile(join(target, 'AGENTS.md'), 'utf8')).resolves.toContain(
      'my-conception',
    );
  });

  it('prints the created paths + summary line in human mode', async () => {
    const target = join(scratch, 'human-init');
    const { stdout, threw } = await captureStdout(() =>
      runInit({ noun: 'init', verb: null, positional: [], flags: { path: target } }, humanCtx()),
    );
    expect(threw).toBeUndefined();
    expect(stdout).toContain('AGENTS.md');
    expect(stdout).toContain(`Initialised conception at ${target} — `);
    expect(stdout).toMatch(/\d+ files created\.\n$/);
  });

  it('is idempotent on an already-initialised tree — no overwrite, exit 0', async () => {
    const target = join(scratch, 're-init');
    await run({ flags: { path: target } });
    const custom = '# My hand-edited AGENTS.md\n';
    await fs.writeFile(join(target, 'AGENTS.md'), custom, 'utf8');

    const { stdout, threw } = await run({ flags: { path: target } });
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<{ created: string[] }>(stdout).data!;
    expect(data.created).toEqual([]);
    // The existing file was left untouched.
    await expect(fs.readFile(join(target, 'AGENTS.md'), 'utf8')).resolves.toBe(custom);
  });

  it('human mode on a re-run says the tree already looks initialised', async () => {
    const target = join(scratch, 're-init-human');
    await run({ flags: { path: target } });
    const { stdout } = await captureStdout(() =>
      runInit({ noun: 'init', verb: null, positional: [], flags: { path: target } }, humanCtx()),
    );
    expect(stdout).toContain('Already initialised');
    expect(stdout).toContain('Existing files are never overwritten');
  });

  it('--path creates missing parent directories', async () => {
    const target = join(scratch, 'nested', 'deep', 'tree');
    const { stdout, threw } = await run({ flags: { path: target } });
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<{ created: string[] }>(stdout).data!;
    expect(data.created.length).toBeGreaterThan(0);
    await expect(fs.readFile(join(target, 'projects', 'index.md'), 'utf8')).resolves.toBeTruthy();
  });

  it('defaults to the current directory when no --path is given', async () => {
    const cwdTarget = join(scratch, 'cwd-init');
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(cwdTarget);
    try {
      const { stdout, threw } = await run({});
      expect(threw).toBeUndefined();
      const data = parseJsonEnvelope<{ path: string; created: string[] }>(stdout).data!;
      expect(data.path).toBe(cwdTarget);
      expect(data.created.length).toBeGreaterThan(0);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('never overwrites a pre-existing file on first init', async () => {
    const target = join(scratch, 'partial');
    await fs.mkdir(target, { recursive: true });
    const custom = '# Hand-made AGENTS.md — {{ conception_name }}\n';
    await fs.writeFile(join(target, 'AGENTS.md'), custom, 'utf8');
    const { stdout, threw } = await run({ flags: { path: target } });
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<{ created: string[] }>(stdout).data!;
    expect(data.created).not.toContain('AGENTS.md');
    expect(data.created.length).toBeGreaterThan(0);
    await expect(fs.readFile(join(target, 'AGENTS.md'), 'utf8')).resolves.toBe(custom);
  });

  it('rejects an unknown verb', async () => {
    const { threw } = await run({ verb: 'bogus' });
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(2);
  });

  it('rejects unknown flags with a did-you-mean hint', async () => {
    const { threw } = await run({ flags: { pathx: join(scratch, 'x') } });
    expect(threw).toBeInstanceOf(UsageError);
    expect((threw as UsageError).message).toContain('--path');
  });

  it('--help prints usage and returns OK', async () => {
    const { stdout, threw } = await captureStdout(() =>
      runInit(
        { noun: 'init', verb: null, positional: [], flags: {} },
        jsonCtx(),
        undefined,
        true, // help
      ),
    );
    expect(threw).toBeUndefined();
    expect(stdout).toMatch(/condash init/);
    expect(stdout).toContain('--path <dir>');
  });
});
