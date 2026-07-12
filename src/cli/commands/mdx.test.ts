import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMdx } from './mdx';
import { CliError, ExitCodes } from '../output';
import type { ParsedArgs } from '../parser';
import {
  captureStdout,
  jsonCtx,
  makeTmpConception,
  parseJsonEnvelope,
  rmConception,
} from './test-helpers';

function args(positional: string[], flags: Record<string, string | boolean> = {}): ParsedArgs {
  return { noun: 'mdx', verb: null, positional, flags } as unknown as ParsedArgs;
}

const VALID_PLAN = [
  '---',
  'title: A plan',
  'kind: plan',
  '---',
  '',
  '## Goal',
  '',
  'Do the thing.',
  '',
  '<Code id="c1" code={"const x = 1;\\n"} language="ts" />',
  '',
].join('\n');

describe('mdx check', () => {
  let conceptionPath: string;
  let planDir: string;

  beforeEach(async () => {
    conceptionPath = await makeTmpConception();
    planDir = join(conceptionPath, 'projects', '2026-07', '2026-07-12-x', 'notes', '01-plan');
    await fs.mkdir(planDir, { recursive: true });
  });
  afterEach(async () => {
    await rmConception(conceptionPath);
  });

  it('passes a valid plan.mdx given the folder', async () => {
    await fs.writeFile(join(planDir, 'plan.mdx'), VALID_PLAN, 'utf8');
    const { stdout, threw } = await captureStdout(() =>
      runMdx('check', args([planDir]), jsonCtx(), conceptionPath, false),
    );
    expect(threw).toBeUndefined();
    const envelope = parseJsonEnvelope<{ blocks: number; kind: string }>(stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.data?.blocks).toBe(2);
    expect(envelope.data?.kind).toBe('plan');
  });

  it('accepts a direct .mdx path and warns on a missing kind', async () => {
    const file = join(planDir, 'plan.mdx');
    await fs.writeFile(file, '# hi\n\n<Code id="c" code={"x"} />\n', 'utf8');
    const { stdout, threw } = await captureStdout(() =>
      runMdx('check', args([file]), jsonCtx(), conceptionPath, false),
    );
    expect(threw).toBeUndefined();
    const envelope = parseJsonEnvelope<{ warnings: { message: string }[] }>(stdout);
    expect(envelope.data?.warnings.some((w) => w.message.includes('kind'))).toBe(true);
  });

  it('exits VALIDATION with the report on block errors', async () => {
    await fs.writeFile(join(planDir, 'plan.mdx'), '<Bogus id="b" />\n', 'utf8');
    const { threw } = await captureStdout(() =>
      runMdx('check', args([planDir]), jsonCtx(), conceptionPath, false),
    );
    expect(threw).toBeInstanceOf(CliError);
    const err = threw as CliError;
    expect(err.exitCode).toBe(ExitCodes.VALIDATION);
    const report = err.details.report as { errors: { message: string }[] };
    expect(report.errors[0].message).toContain('Bogus');
  });

  it('warns about unsupported canvas.mdx siblings', async () => {
    await fs.writeFile(join(planDir, 'plan.mdx'), VALID_PLAN, 'utf8');
    await fs.writeFile(join(planDir, 'canvas.mdx'), '<DesignBoard />\n', 'utf8');
    const { stdout } = await captureStdout(() =>
      runMdx('check', args([planDir]), jsonCtx(), conceptionPath, false),
    );
    const envelope = parseJsonEnvelope(stdout);
    expect(envelope.warnings?.some((w) => w.includes('canvas.mdx'))).toBe(true);
  });

  it('NOT_FOUND for a missing path and USAGE for a non-mdx file', async () => {
    const missing = await captureStdout(() =>
      runMdx('check', args([join(planDir, 'nope')]), jsonCtx(), conceptionPath, false),
    );
    expect((missing.threw as CliError).exitCode).toBe(ExitCodes.NOT_FOUND);

    const txt = join(planDir, 'a.txt');
    await fs.writeFile(txt, 'x', 'utf8');
    const wrongExt = await captureStdout(() =>
      runMdx('check', args([txt]), jsonCtx(), conceptionPath, false),
    );
    expect((wrongExt.threw as CliError).exitCode).toBe(ExitCodes.USAGE);
  });

  it('resolves a conception-relative path', async () => {
    await fs.writeFile(join(planDir, 'plan.mdx'), VALID_PLAN, 'utf8');
    const rel = 'projects/2026-07/2026-07-12-x/notes/01-plan';
    const { stdout, threw } = await captureStdout(() =>
      runMdx('check', args([rel]), jsonCtx(), conceptionPath, false),
    );
    expect(threw).toBeUndefined();
    expect(parseJsonEnvelope(stdout).ok).toBe(true);
  });
});

describe('mdx blocks', () => {
  it('prints the registry-generated reference', async () => {
    const { stdout, threw } = await captureStdout(() =>
      runMdx('blocks', args([]), jsonCtx(), '/nonexistent', false),
    );
    expect(threw).toBeUndefined();
    const envelope = parseJsonEnvelope<{ markdown: string }>(stdout);
    expect(envelope.data?.markdown).toContain('| `diff` |');
    expect(envelope.data?.markdown).toContain('`<WireframeBlock>`');
  });
});
