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
} from './test-helpers';
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
    for (const c of ['lfs', 'binaries', 'cross-repo', 'worktrees', 'index']) {
      expect(checks).toContain(c);
    }
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
