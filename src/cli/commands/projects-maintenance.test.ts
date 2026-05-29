/**
 * Tests for projects-maintenance: indexCommand, scanPromotionsCommand,
 * rewriteHeadersCommand, backfillClosed. createCommand is already covered
 * by `projects-create.test.ts` — not re-tested here.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  indexCommand,
  scanPromotionsCommand,
  rewriteHeadersCommand,
  backfillClosed,
} from './projects-maintenance';
import {
  captureStdout,
  jsonCtx,
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

describe('indexCommand', () => {
  it('--dry-run reports the planned changes without writing index.md', async () => {
    await writeProjectReadme(conceptionPath, 'alpha', {
      date: '2026-05-01',
      kind: 'project',
      status: 'now',
      title: 'Alpha',
    });
    const { stdout, threw } = await captureStdout(() =>
      indexCommand(
        { noun: 'projects', verb: 'index', positional: [], flags: { 'dry-run': true } },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<{ dryRun: boolean }>(stdout).data!;
    expect(data.dryRun).toBe(true);
    // Top-level index would land at projects/index.md — verify it wasn't written.
    let topIndexExists = true;
    try {
      await fs.access(join(conceptionPath, 'projects', 'index.md'));
    } catch {
      topIndexExists = false;
    }
    expect(topIndexExists).toBe(false);
  });
});

describe('scanPromotionsCommand', () => {
  it('flags paragraphs containing promotion keywords', async () => {
    await writeProjectReadme(conceptionPath, 'alpha', {
      date: '2026-05-01',
      kind: 'project',
      status: 'now',
      title: 'Alpha',
    });
    const notesDir = join(conceptionPath, 'projects', '2026-05', '2026-05-01-alpha', 'notes');
    await fs.mkdir(notesDir, { recursive: true });
    await fs.writeFile(
      join(notesDir, '01-design.md'),
      [
        '# Design',
        '',
        'We always avoid raw `mkdir` and use the skill instead.',
        '',
        'This paragraph carries no promotion-worthy fact.',
        '',
      ].join('\n'),
      'utf8',
    );
    const { stdout, threw } = await captureStdout(() =>
      scanPromotionsCommand(
        { noun: 'projects', verb: 'scan-promotions', positional: ['alpha'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<{
      candidates: Array<{ relPath: string; match: string; paragraph: string }>;
    }>(stdout).data!;
    expect(data.candidates.length).toBeGreaterThanOrEqual(1);
    expect(data.candidates[0].match.toLowerCase()).toMatch(/always/);
  });

  it('returns an empty candidate list when notes/ is missing', async () => {
    await writeProjectReadme(conceptionPath, 'alpha', {
      date: '2026-05-01',
      kind: 'project',
      status: 'now',
      title: 'Alpha',
    });
    const { stdout } = await captureStdout(() =>
      scanPromotionsCommand(
        { noun: 'projects', verb: 'scan-promotions', positional: ['alpha'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const data = parseJsonEnvelope<{ candidates: unknown[] }>(stdout).data!;
    expect(data.candidates).toEqual([]);
  });

  it('USAGE when slug is missing', async () => {
    const { threw } = await captureStdout(() =>
      scanPromotionsCommand(
        { noun: 'projects', verb: 'scan-promotions', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(2);
  });
});

describe('rewriteHeadersCommand', () => {
  it('reports already-YAML when every README is already in YAML shape', async () => {
    await writeProjectReadme(conceptionPath, 'alpha', {
      date: '2026-05-01',
      kind: 'project',
      status: 'now',
      title: 'Alpha',
    });
    const { stdout, threw } = await captureStdout(() =>
      rewriteHeadersCommand(
        { noun: 'projects', verb: 'rewrite-headers', positional: [], flags: { 'dry-run': true } },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<{ rewritten: unknown[]; alreadyYaml: unknown[] }>(stdout).data!;
    expect(data.alreadyYaml.length).toBe(1);
    expect(data.rewritten).toEqual([]);
  });

  it('migrates a bold-prose README to YAML in --dry-run mode (no writes)', async () => {
    const dir = join(conceptionPath, 'projects', '2026-05', '2026-05-02-legacy');
    await fs.mkdir(dir, { recursive: true });
    const readme = join(dir, 'README.md');
    const original = [
      '# Legacy header',
      '',
      '**Date**: 2026-05-02',
      '**Kind**: project',
      '**Status**: now',
      '',
      '## Goal',
      '',
      'Some goal.',
      '',
    ].join('\n');
    await fs.writeFile(readme, original, 'utf8');
    const { stdout } = await captureStdout(() =>
      rewriteHeadersCommand(
        { noun: 'projects', verb: 'rewrite-headers', positional: [], flags: { 'dry-run': true } },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const data = parseJsonEnvelope<{ rewritten: string[]; dryRun: boolean }>(stdout).data!;
    expect(data.dryRun).toBe(true);
    expect(data.rewritten.length).toBe(1);
    // Source preserved on disk under --dry-run.
    expect(await fs.readFile(readme, 'utf8')).toBe(original);
  });
});

describe('backfillClosed', () => {
  it('lists done items lacking a Closed timeline entry under --dry-run', async () => {
    await writeProjectReadme(conceptionPath, 'finished', {
      date: '2026-05-01',
      kind: 'project',
      status: 'done',
      title: 'Finished',
      body: '## Timeline\n\n',
    });
    await writeProjectReadme(conceptionPath, 'already-closed', {
      date: '2026-05-02',
      kind: 'project',
      status: 'done',
      title: 'Already closed',
      body: '## Timeline\n\n- 2026-05-02 — Closed.\n',
    });
    const { stdout, threw } = await captureStdout(() =>
      backfillClosed(
        { noun: 'projects', verb: 'backfill-closed', positional: [], flags: { 'dry-run': true } },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<{
      candidates: Array<{ slug: string }>;
      skipped: Array<{ slug: string; reason: string }>;
      dryRun?: boolean;
    }>(stdout).data!;
    const candidateSlugs = data.candidates.map((c) => c.slug);
    expect(candidateSlugs.some((s) => s.includes('finished'))).toBe(true);
    const skippedSlugs = data.skipped.map((s) => s.slug);
    expect(skippedSlugs.some((s) => s.includes('already-closed'))).toBe(true);
  });
});
