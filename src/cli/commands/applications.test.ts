/**
 * Tests for `condash applications`. Drives `runApplications` directly against a
 * tmp conception with a seeded `condash.json` registry.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runApplications } from './applications';
import {
  captureStdout,
  jsonCtx,
  makeTmpConception,
  parseJsonEnvelope,
  rmConception,
  writeProjectReadme,
} from './test-helpers';
import { CliError } from '../output';
import type { ParsedArgs } from '../parser';

let conceptionPath: string;

beforeEach(async () => {
  conceptionPath = await makeTmpConception();
});

afterEach(async () => {
  await rmConception(conceptionPath);
});

async function seed(config: Record<string, unknown>): Promise<void> {
  await fs.writeFile(
    join(conceptionPath, 'condash.json'),
    JSON.stringify({ workspace_path: conceptionPath, ...config }),
    'utf8',
  );
}

function args(
  verb: string,
  positional: string[] = [],
  flags: ParsedArgs['flags'] = {},
): ParsedArgs {
  return { noun: 'applications', verb, positional, flags };
}

describe('runApplications list', () => {
  it('lists live + retired apps as JSON', async () => {
    await seed({
      repositories: [{ handle: 'kasten', path: 'notes.vcoeur.com' }],
      retired_apps: [{ handle: 'kasten-manager' }],
    });
    const { stdout, threw } = await captureStdout(() =>
      runApplications('list', args('list'), jsonCtx(), conceptionPath),
    );
    expect(threw).toBeUndefined();
    const apps = parseJsonEnvelope<Array<{ handle: string; retired: boolean }>>(stdout).data!;
    expect(apps.map((a) => a.handle)).toEqual(['kasten', 'kasten-manager']);
    expect(apps.find((a) => a.handle === 'kasten-manager')?.retired).toBe(true);
  });
});

describe('runApplications validate', () => {
  it('exits 3 (validation) when a README names an unknown handle', async () => {
    await seed({ repositories: [{ handle: 'condash', name: 'condash' }] });
    await writeProjectReadme(conceptionPath, 'bad', { date: '2026-05-01', apps: ['ghost'] });
    const { threw } = await captureStdout(() =>
      runApplications('validate', args('validate'), jsonCtx(), conceptionPath),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(3);
  });

  it('passes when every reference resolves', async () => {
    await seed({ repositories: [{ handle: 'condash', name: 'condash' }] });
    await writeProjectReadme(conceptionPath, 'ok', { date: '2026-05-01', apps: ['condash'] });
    const { threw } = await captureStdout(() =>
      runApplications('validate', args('validate'), jsonCtx(), conceptionPath),
    );
    expect(threw).toBeUndefined();
  });
});

describe('runApplications sync-docs', () => {
  it('reports missing sentinels when AGENTS.md lacks them', async () => {
    await seed({ repositories: [{ handle: 'condash', name: 'condash' }] });
    await fs.writeFile(join(conceptionPath, 'AGENTS.md'), '# A\n\nno sentinels\n', 'utf8');
    const { stdout, threw } = await captureStdout(() =>
      runApplications('sync-docs', args('sync-docs'), jsonCtx(), conceptionPath),
    );
    expect(threw).toBeUndefined();
    const result = parseJsonEnvelope<{ missingSentinels: boolean }>(stdout).data!;
    expect(result.missingSentinels).toBe(true);
  });
});

describe('runApplications add', () => {
  it('registers a new app', async () => {
    await seed({ repositories: [{ handle: 'condash', name: 'condash' }] });
    const { threw } = await captureStdout(() =>
      runApplications('add', args('add', ['fovea'], { path: 'fovea' }), jsonCtx(), conceptionPath),
    );
    expect(threw).toBeUndefined();
    const { stdout } = await captureStdout(() =>
      runApplications('list', args('list'), jsonCtx(), conceptionPath),
    );
    const apps = parseJsonEnvelope<Array<{ handle: string }>>(stdout).data!;
    expect(apps.map((a) => a.handle)).toContain('fovea');
  });

  it('rejects add without --path as USAGE', async () => {
    await seed({ repositories: [] });
    const { threw } = await captureStdout(() =>
      runApplications('add', args('add', ['fovea']), jsonCtx(), conceptionPath),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(2);
  });
});

describe('runApplications unknown verb', () => {
  it('rejects with USAGE', async () => {
    await seed({ repositories: [] });
    const { threw } = await captureStdout(() =>
      runApplications('banana', args('banana'), jsonCtx(), conceptionPath),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(2);
  });
});
