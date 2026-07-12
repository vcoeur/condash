import { promises as fs } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { ParsedArgs } from '../parser';
import { assertNoExtraFlags } from '../parser';
import { CliError, emit, ExitCodes, type OutputContext } from '../output';
import { renderHelp, runNoun } from '../help';
import type { PlanIssue } from '../../shared/plan-blocks/schemas';

/**
 * `condash mdx` — the CLI side of plan/review MDX documents (the artifacts
 * the `visual-plan` / `visual-review` skills author into a project item's
 * `notes/NN-<slug>/plan.mdx`).
 *
 *   - `check <path>`  validate a plan.mdx (or a folder holding one) against
 *     the same parser + block schemas the in-app viewer renders — a green
 *     check IS renderability, there is no separate lint to drift.
 *   - `blocks`        print the block-vocabulary reference generated from the
 *     registry (the same content the `/visual` skill ships as `blocks.md`).
 */
export async function runMdx(
  verb: string | null,
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
  universalHelp: boolean,
): Promise<void> {
  await runNoun(
    'mdx',
    verb,
    args,
    {
      check: () => runCheck(args, ctx, conceptionPath),
      blocks: () => runBlocks(args, ctx),
    },
    printHelp,
    universalHelp,
  );
}

function printHelp(verb: string | null): void {
  const lines: string[] = [];
  if (verb === 'check') {
    lines.push(
      'Usage: condash mdx check <path>',
      '',
      'Validate a plan/review MDX document. <path> is a .mdx file or a folder',
      'containing plan.mdx, absolute or relative to the current directory.',
      'Errors exit 3 (validation) with per-issue lines and line numbers.',
    );
  } else if (verb === 'blocks') {
    lines.push(
      'Usage: condash mdx blocks',
      '',
      'Print the plan block vocabulary reference (generated from the registry).',
    );
  } else {
    lines.push(
      'Usage: condash mdx <verb>',
      '',
      'Verbs:',
      '  check <path>   Validate a plan.mdx (or folder) against the block schemas.',
      '  blocks         Print the block vocabulary reference.',
    );
  }
  process.stdout.write(renderHelp(lines));
}

interface CheckReport {
  path: string;
  kind: string | null;
  title: string | null;
  blocks: number;
  errors: PlanIssue[];
  warnings: PlanIssue[];
}

async function runCheck(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  assertNoExtraFlags(args);
  const target = args.positional[0];
  if (!target) {
    throw new CliError(ExitCodes.USAGE, 'Usage: condash mdx check <path>');
  }

  const { filePath, warnings } = await resolvePlanFile(target, conceptionPath);
  let source: string;
  try {
    source = await fs.readFile(filePath, 'utf8');
  } catch {
    throw new CliError(ExitCodes.NOT_FOUND, `cannot read ${filePath}`);
  }

  // Heavy parser module loads only on this verb (CLI cold-start discipline).
  const { parsePlanMdx } = await import('../../shared/plan-blocks/parse-mdx');
  const doc = parsePlanMdx(source);

  const issues = [...doc.issues];
  if (doc.frontmatter.kind === undefined) {
    issues.push({
      severity: 'warning',
      message: 'frontmatter has no `kind` — set `kind: plan` or `kind: review`',
      line: 1,
    });
  }

  const report: CheckReport = {
    path: filePath,
    kind: typeof doc.frontmatter.kind === 'string' ? doc.frontmatter.kind : null,
    title: typeof doc.frontmatter.title === 'string' ? doc.frontmatter.title : null,
    blocks: doc.blocks.length,
    errors: issues.filter((i) => i.severity === 'error'),
    warnings: issues.filter((i) => i.severity === 'warning'),
  };

  // Single envelope discipline (same shape as `projects validate`): errors
  // throw so the dispatcher emits one failure envelope carrying the report.
  if (report.errors.length > 0) {
    throw new CliError(ExitCodes.VALIDATION, `${report.errors.length} validation error(s)`, {
      report,
    });
  }

  emit(
    ctx,
    report,
    (data) => {
      const lines: string[] = [];
      for (const w of data.warnings) {
        lines.push(`  warn ${w.line !== undefined ? ` L${w.line}` : ''}  ${w.message}`);
      }
      const head = `OK ${data.path} (${data.blocks} block${data.blocks === 1 ? '' : 's'})`;
      return [head, ...lines].join('\n') + '\n';
    },
    warnings,
  );
}

/** Resolve the check target: a `.mdx` file directly, or a folder holding
 *  `plan.mdx` (the `notes/NN-<slug>/` layout). Sibling canvas/prototype files
 *  are surfaced as warnings — condash renders the document only. */
async function resolvePlanFile(
  target: string,
  conceptionPath: string,
): Promise<{ filePath: string; warnings: string[] }> {
  const resolved = isAbsolute(target) ? target : resolve(process.cwd(), target);
  const warnings: string[] = [];
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    // A conception-relative path (e.g. projects/…/notes/03-x) is a common
    // spelling when invoking from elsewhere; try it before giving up.
    const underConception = join(conceptionPath, target);
    try {
      stat = await fs.stat(underConception);
      return resolvePlanFile(underConception, conceptionPath);
    } catch {
      throw new CliError(ExitCodes.NOT_FOUND, `no such file or directory: ${target}`);
    }
  }
  if (stat.isDirectory()) {
    for (const sibling of ['canvas.mdx', 'prototype.mdx']) {
      try {
        await fs.stat(join(resolved, sibling));
        warnings.push(`${sibling} present but not supported by the condash viewer — ignored`);
      } catch {
        /* absent is the normal case */
      }
    }
    return { filePath: join(resolved, 'plan.mdx'), warnings };
  }
  if (!resolved.toLowerCase().endsWith('.mdx')) {
    throw new CliError(ExitCodes.USAGE, `expected a .mdx file or a plan folder (got ${target})`);
  }
  return { filePath: resolved, warnings };
}

async function runBlocks(args: ParsedArgs, ctx: OutputContext): Promise<void> {
  assertNoExtraFlags(args);
  const { renderBlocksDoc } = await import('../../shared/plan-blocks/blocks-doc');
  const markdown = renderBlocksDoc();
  emit(ctx, { markdown }, (data) => data.markdown);
}
