/**
 * Tests for `condash audit` — flag parsing, USAGE rejections, and a
 * smoke-run against a fresh tmp conception.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAuditCommand } from './audit';
import {
  captureStdout,
  jsonCtx,
  makeTmpConception,
  parseJsonEnvelope,
  rmConception,
  writeProjectReadme,
} from './test-helpers';
import type { AuditIssue } from '../../main/audit';
import { CliError } from '../output';

let conceptionPath: string;

beforeEach(async () => {
  conceptionPath = await makeTmpConception();
});

afterEach(async () => {
  await rmConception(conceptionPath);
});

describe('runAuditCommand', () => {
  it('runs with no flags and emits a summary envelope', async () => {
    const { stdout, threw } = await captureStdout(() =>
      runAuditCommand(
        { noun: 'audit', verb: '', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<{
      summary: { conceptionRoot: string; checksRun: string[]; total: number };
      issues: unknown[];
    }>(stdout).data!;
    expect(data.summary.conceptionRoot).toBe(conceptionPath);
    expect(Array.isArray(data.summary.checksRun)).toBe(true);
    expect(Array.isArray(data.issues)).toBe(true);
  });

  it('--include filters checksRun to the requested subset', async () => {
    const { stdout } = await captureStdout(() =>
      runAuditCommand(
        { noun: 'audit', verb: '', positional: [], flags: { include: 'lfs,binaries' } },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const data = parseJsonEnvelope<{ summary: { checksRun: string[] } }>(stdout).data!;
    expect(new Set(data.summary.checksRun)).toEqual(new Set(['lfs', 'binaries']));
  });

  it('--include all expands to every check', async () => {
    const { stdout } = await captureStdout(() =>
      runAuditCommand(
        { noun: 'audit', verb: '', positional: [], flags: { include: 'all' } },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const checks = parseJsonEnvelope<{ summary: { checksRun: string[] } }>(stdout).data!.summary
      .checksRun;
    for (const c of ['lfs', 'binaries', 'cross-repo', 'worktrees', 'index', 'knowledge-recheck']) {
      expect(checks).toContain(c);
    }
  });

  it('flags an unresolved knowledge-recheck marker, even on a done project', async () => {
    await writeProjectReadme(conceptionPath, 'deferred-thing', {
      date: '2026-05-22',
      kind: 'project',
      status: 'done',
      body: [
        '## Timeline',
        '',
        '- 2026-05-22 — [knowledge-recheck:pending] field rename; re-test after PR #5 merges.',
        '- 2026-05-23 — Closed. Shipped.',
        '',
      ].join('\n'),
    });
    const { stdout } = await captureStdout(() =>
      runAuditCommand(
        { noun: 'audit', verb: '', positional: [], flags: { include: 'knowledge-recheck' } },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const issues = parseJsonEnvelope<{ issues: AuditIssue[] }>(stdout).data!.issues;
    const recheck = issues.filter((i) => i.check === 'knowledge-recheck');
    expect(recheck).toHaveLength(1);
    expect(recheck[0].severity).toBe('warn');
    expect(recheck[0].message).toContain('field rename');
  });

  it('does not flag a knowledge-recheck that was later resolved', async () => {
    await writeProjectReadme(conceptionPath, 'resolved-thing', {
      date: '2026-05-22',
      kind: 'project',
      status: 'done',
      body: [
        '## Timeline',
        '',
        '- 2026-05-22 — [knowledge-recheck:pending] field rename; re-test after PR #5 merges.',
        '- 2026-06-01 — [knowledge-recheck:done] promoted to knowledge/topics/ops/x.md.',
        '',
      ].join('\n'),
    });
    const { stdout } = await captureStdout(() =>
      runAuditCommand(
        { noun: 'audit', verb: '', positional: [], flags: { include: 'knowledge-recheck' } },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const issues = parseJsonEnvelope<{ issues: AuditIssue[] }>(stdout).data!.issues;
    expect(issues.filter((i) => i.check === 'knowledge-recheck')).toHaveLength(0);
  });

  it('rejects an unknown --include check with USAGE', async () => {
    const { threw } = await captureStdout(() =>
      runAuditCommand(
        { noun: 'audit', verb: '', positional: [], flags: { include: 'banana' } },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(2);
  });

  it('--help short-circuits to help text', async () => {
    const { stdout, threw } = await captureStdout(() =>
      runAuditCommand(
        { noun: 'audit', verb: '', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
        true,
      ),
    );
    expect(threw).toBeUndefined();
    expect(stdout).toMatch(/condash audit/);
  });

  it('positional `help` is a help alias', async () => {
    const { stdout, threw } = await captureStdout(() =>
      runAuditCommand(
        { noun: 'audit', verb: '', positional: ['help'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    expect(stdout).toMatch(/condash audit/);
  });
});
