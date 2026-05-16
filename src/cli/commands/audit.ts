import { runAudit, type AuditCheckName, type AuditReport } from '../../main/audit';
import { CliError, ExitCodes, emit, type OutputContext } from '../output';
import { assertNoExtraFlags, type ParsedArgs } from '../parser';
import { UNIVERSAL_FOOTER } from '../help';

const ALL_AUDIT_CHECKS: AuditCheckName[] = ['lfs', 'binaries', 'cross-repo', 'worktrees', 'index'];

const KNOWN_FLAGS_AUDIT = ['include'] as const;

const NOUN_FLAGS: readonly string[] = [...new Set<string>([...KNOWN_FLAGS_AUDIT])];

export async function runAuditCommand(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
  universalHelp = false,
): Promise<void> {
  // `audit` is verbless. The two help triggers are:
  //   - `condash audit --help`
  //   - `condash audit help` (positional alias)
  // Either prints the same usage block.
  if (universalHelp || (args.positional[0] === 'help' && args.positional.length === 1)) {
    printHelp();
    return;
  }
  const includeFlag = args.flags.include;
  delete args.flags.include;
  assertNoExtraFlags(args, NOUN_FLAGS);

  const includeRaw =
    typeof includeFlag === 'string'
      ? includeFlag
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : ALL_AUDIT_CHECKS;
  // `all` is a documented alias for "every check" — keeps wrapping skills
  // (`/tidy`) able to write `--include all --json` without conditional flag
  // construction.
  const include = includeRaw.flatMap((c) => (c === 'all' ? ALL_AUDIT_CHECKS : [c]));
  for (const c of include) {
    if (!ALL_AUDIT_CHECKS.includes(c as AuditCheckName)) {
      throw new CliError(
        ExitCodes.USAGE,
        `--include must be 'all' or a comma-separated subset of {${ALL_AUDIT_CHECKS.join(', ')}}; got '${c}'`,
      );
    }
  }
  const report = await runAudit(conceptionPath, include as AuditCheckName[]);
  emit(ctx, report, formatAuditPretty, [], { streamField: 'issues' });
}

function printHelp(): void {
  process.stdout.write(
    [
      'condash audit [--include <checks>]',
      '',
      'Run umbrella audits across the conception tree.',
      '',
      'Optional:',
      `  --include    Comma-separated subset of {${ALL_AUDIT_CHECKS.join(', ')}}, or 'all' (default).`,
      '',
      'Examples:',
      '  condash audit',
      '  condash audit --include lfs,binaries --json',
      '  condash audit --include all',
      '',
      UNIVERSAL_FOOTER,
      '',
    ].join('\n'),
  );
}

function formatAuditPretty(report: AuditReport): string {
  const lines: string[] = [];
  lines.push(`=== conception audit ===`);
  lines.push(`Root:         ${report.summary.conceptionRoot}`);
  lines.push(`Checks run:   ${report.summary.checksRun.join(', ')}`);
  lines.push(`Total:        ${report.summary.total} issues`);
  lines.push(`Severity:     ${JSON.stringify(report.summary.bySeverity)}`);
  lines.push(`By check:     ${JSON.stringify(report.summary.byCheck)}`);
  lines.push('');
  if (report.issues.length === 0) {
    lines.push('No issues found.');
    return lines.join('\n') + '\n';
  }
  for (const i of report.issues) {
    const loc = i.line ? `${i.file ?? '-'}:${i.line}` : (i.file ?? '-');
    lines.push(`[${i.severity.padEnd(5)}] ${i.check.padEnd(12)} ${loc}`);
    lines.push(`        ${i.message}`);
  }
  return lines.join('\n') + '\n';
}
