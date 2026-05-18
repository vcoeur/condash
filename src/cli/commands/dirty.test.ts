/**
 * Tests for `condash dirty`: list / touch / clear.
 *
 * The dirty marker is a plain file at `<tree>/.index-dirty`. Tests touch
 * the marker through the CLI verb and inspect the filesystem.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDirty } from './dirty';
import {
  captureStdout,
  jsonCtx,
  makeTmpConception,
  parseJsonEnvelope,
  rmConception,
} from './test-helpers';
import { CliError } from '../output';

let conceptionPath: string;

beforeEach(async () => {
  conceptionPath = await makeTmpConception();
});

afterEach(async () => {
  await rmConception(conceptionPath);
});

describe('dirty list', () => {
  it('reports clean on a fresh conception', async () => {
    const { stdout, threw } = await captureStdout(() =>
      runDirty(
        'list',
        { noun: 'dirty', verb: 'list', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<{
      projects: { present: boolean };
      knowledge: { present: boolean };
    }>(stdout).data!;
    expect(data.projects.present).toBe(false);
    expect(data.knowledge.present).toBe(false);
  });

  it('reports dirty when a marker file exists', async () => {
    await fs.writeFile(join(conceptionPath, 'projects', '.index-dirty'), '', 'utf8');
    const { stdout } = await captureStdout(() =>
      runDirty(
        'list',
        { noun: 'dirty', verb: 'list', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const data = parseJsonEnvelope<{
      projects: { present: boolean; mtime: string | null };
    }>(stdout).data!;
    expect(data.projects.present).toBe(true);
    expect(data.projects.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('dirty touch', () => {
  it('creates the marker for the named tree', async () => {
    const { threw } = await captureStdout(() =>
      runDirty(
        'touch',
        { noun: 'dirty', verb: 'touch', positional: ['knowledge'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const exists = await fs
      .stat(join(conceptionPath, 'knowledge', '.index-dirty'))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  it('USAGE when the tree positional is missing or invalid', async () => {
    const { threw } = await captureStdout(() =>
      runDirty(
        'touch',
        { noun: 'dirty', verb: 'touch', positional: ['banana'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(2);
  });
});

describe('dirty clear', () => {
  it('removes the named tree marker', async () => {
    await fs.writeFile(join(conceptionPath, 'projects', '.index-dirty'), '', 'utf8');
    const { stdout, threw } = await captureStdout(() =>
      runDirty(
        'clear',
        { noun: 'dirty', verb: 'clear', positional: ['projects'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<{ cleared: string[] }>(stdout).data!;
    expect(data.cleared.length).toBe(1);
    const exists = await fs
      .stat(join(conceptionPath, 'projects', '.index-dirty'))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it('"all" clears both trees', async () => {
    await fs.writeFile(join(conceptionPath, 'projects', '.index-dirty'), '', 'utf8');
    await fs.writeFile(join(conceptionPath, 'knowledge', '.index-dirty'), '', 'utf8');
    const { stdout } = await captureStdout(() =>
      runDirty(
        'clear',
        { noun: 'dirty', verb: 'clear', positional: ['all'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const data = parseJsonEnvelope<{ cleared: string[] }>(stdout).data!;
    expect(data.cleared.length).toBe(2);
  });

  it('no-ops when the marker is already absent', async () => {
    const { stdout, threw } = await captureStdout(() =>
      runDirty(
        'clear',
        { noun: 'dirty', verb: 'clear', positional: ['projects'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<{ cleared: string[] }>(stdout).data!;
    expect(data.cleared).toEqual([]);
  });

  it('USAGE on an invalid scope', async () => {
    const { threw } = await captureStdout(() =>
      runDirty(
        'clear',
        { noun: 'dirty', verb: 'clear', positional: ['banana'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(2);
  });
});

describe('runDirty dispatch', () => {
  it('unknown verb → USAGE', async () => {
    const { threw } = await captureStdout(() =>
      runDirty(
        'banana',
        { noun: 'dirty', verb: 'banana', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(2);
  });

  it('--help prints help', async () => {
    const { stdout, threw } = await captureStdout(() =>
      runDirty(
        'list',
        { noun: 'dirty', verb: 'list', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
        true,
      ),
    );
    expect(threw).toBeUndefined();
    expect(stdout).toMatch(/condash dirty list/);
  });
});
