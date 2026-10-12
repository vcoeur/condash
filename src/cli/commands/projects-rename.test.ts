/** Tests for the `projects rename` verb surface: wiring through runProjects,
 *  help, argument validation, and the JSON envelope. The engine itself is
 *  covered by `src/main/rename-project.test.ts`. */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renameCommand } from './projects-rename';
import { runProjects } from './projects';
import {
  captureStdout,
  jsonCtx,
  humanCtx,
  makeTmpConception,
  parseJsonEnvelope,
  rmConception,
  writeProjectReadme,
} from './test-helpers';
import { CliError } from '../output';

let conceptionPath: string;

beforeEach(async () => {
  conceptionPath = await makeTmpConception();
});

afterEach(async () => {
  await rmConception(conceptionPath);
});

function renameArgs(positional: string[], flags: Record<string, string | boolean> = {}) {
  return { noun: 'projects', verb: 'rename', positional, flags };
}

describe('renameCommand', () => {
  it('--dry-run reports the plan and writes nothing', async () => {
    await writeProjectReadme(conceptionPath, 'old-one', {
      date: '2026-10-12',
      kind: 'project',
      status: 'now',
      title: 'Old one',
    });
    const readme = join(conceptionPath, 'projects', '2026-10', '2026-10-12-old-one', 'README.md');
    const before = await fs.readFile(readme, 'utf8');

    const { stdout, threw } = await captureStdout(() =>
      renameCommand(
        renameArgs(['old-one', 'renamed-one'], { 'dry-run': true }),
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<{
      moved: { from: string; to: string };
      edits: unknown[];
      dryRun: boolean;
    }>(stdout).data!;
    expect(data.dryRun).toBe(true);
    expect(data.moved).toEqual({
      from: 'projects/2026-10/2026-10-12-old-one',
      to: 'projects/2026-10/2026-10-12-renamed-one',
    });
    expect(data.edits).toEqual([]);
    // Nothing moved, nothing written.
    await expect(fs.stat(readme)).resolves.toBeTruthy();
    expect(await fs.readFile(readme, 'utf8')).toBe(before);
  });

  it('renames through the short slug form and reports the rewrite', async () => {
    await writeProjectReadme(conceptionPath, 'old-one', {
      date: '2026-10-12',
      kind: 'project',
      status: 'now',
      title: 'Old one',
    });
    await fs.writeFile(
      join(conceptionPath, 'knowledge', 'ref.md'),
      'See [[2026-10-12-old-one]].\n',
      'utf8',
    );

    const { stdout, threw } = await captureStdout(() =>
      renameCommand(renameArgs(['old-one', 'renamed-one']), jsonCtx(), conceptionPath),
    );
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<{
      moved: { to: string };
      edits: { file: string; line: number; old: string; new: string }[];
      indexes?: { tree: string };
    }>(stdout).data!;
    expect(data.moved.to).toBe('projects/2026-10/2026-10-12-renamed-one');
    expect(data.edits).toEqual([
      {
        file: 'knowledge/ref.md',
        line: 1,
        old: '2026-10-12-old-one',
        new: '2026-10-12-renamed-one',
      },
    ]);
    expect(data.indexes).toMatchObject({ tree: 'projects' });
    const ref = await fs.readFile(join(conceptionPath, 'knowledge', 'ref.md'), 'utf8');
    expect(ref).toBe('See [[2026-10-12-renamed-one]].\n');
    await expect(
      fs.stat(join(conceptionPath, 'projects', '2026-10', '2026-10-12-renamed-one')),
    ).resolves.toBeTruthy();
  });

  it('exits 4 on an unknown old slug and 6 on an ambiguous short form', async () => {
    const { threw: notFound } = await captureStdout(() =>
      renameCommand(renameArgs(['ghost', 'new-name']), jsonCtx(), conceptionPath),
    );
    expect(notFound).toBeInstanceOf(CliError);
    expect((notFound as CliError).exitCode).toBe(4);

    await writeProjectReadme(conceptionPath, 'alpha', {
      date: '2026-10-11',
      kind: 'project',
      status: 'now',
      title: 'Alpha',
    });
    await writeProjectReadme(conceptionPath, 'alpha-bar', {
      date: '2026-10-12',
      kind: 'project',
      status: 'now',
      title: 'Alpha bar',
    });
    const { threw: ambiguous } = await captureStdout(() =>
      renameCommand(renameArgs(['alpha', 'new-name']), jsonCtx(), conceptionPath),
    );
    expect(ambiguous).toBeInstanceOf(CliError);
    expect((ambiguous as CliError).exitCode).toBe(6);
  });

  it('exits 2 when a positional is missing', async () => {
    const { threw } = await captureStdout(() =>
      renameCommand(renameArgs(['old-one']), jsonCtx(), conceptionPath),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(2);
  });

  it('rejects an unknown flag with a did-you-mean hint from the noun pool', async () => {
    const { threw } = await captureStdout(() =>
      renameCommand(renameArgs(['a', 'b'], { dryrun: true }), jsonCtx(), conceptionPath),
    );
    expect(threw).toBeDefined();
    expect((threw as Error).message).toContain('did you mean --dry-run?');
  });
});

describe('rename verb wiring + help', () => {
  it('dispatches through runProjects', async () => {
    await writeProjectReadme(conceptionPath, 'old-one', {
      date: '2026-10-12',
      kind: 'project',
      status: 'now',
      title: 'Old one',
    });
    const { threw } = await captureStdout(() =>
      runProjects('rename', renameArgs(['old-one', 'renamed-one']), jsonCtx(), conceptionPath),
    );
    expect(threw).toBeUndefined();
    await expect(
      fs.stat(join(conceptionPath, 'projects', '2026-10', '2026-10-12-renamed-one')),
    ).resolves.toBeTruthy();
  });

  it('prints per-verb help without resolving a conception', async () => {
    const { stdout, threw } = await captureStdout(() =>
      runProjects('rename', renameArgs([], {}), humanCtx(), '', true),
    );
    expect(threw).toBeUndefined();
    expect(stdout).toContain('condash projects rename <old-slug> <new-slug> [--dry-run]');
    expect(stdout).toContain('Short-form wikilinks');
  });

  it('lists rename in the noun overview', async () => {
    const { stdout, threw } = await captureStdout(() =>
      runProjects(
        null,
        { noun: 'projects', verb: null, positional: [], flags: {} },
        humanCtx(),
        '',
      ),
    );
    expect(threw).toBeUndefined();
    expect(stdout).toMatch(/rename +Move an item dir/);
  });
});
