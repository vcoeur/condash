/** `projects rename` — move an item dir and rewrite every inbound reference.
 *
 *  `mv projects/<month>/<old>/ <new>/` by hand strands every `[[wikilink]]`,
 *  `parent:` field, and `projects/…` path pointing at the item, with nothing
 *  to say which ones you missed (condash#582). This verb plans the rewrite
 *  first (`--dry-run` prints `file:line old → new` per edit), then moves the
 *  directory — gitignored content under it moves along — writes the edited
 *  files, regenerates the projects indexes, and touches the dirty marker.
 *
 *  The engine lives in `src/main/rename-project.ts`; this file is the verb
 *  surface: resolve the old slug (any resolver form), validate the new tail,
 *  emit the report. */
import { renameProjectCore, type RenameProjectReport } from '../../main/rename-project';
import { resolveSlug } from '../slug-resolver';
import { CliError, ExitCodes, emit, type OutputContext } from '../output';
import { assertNoExtraFlags, takeBoolFlag, type ParsedArgs } from '../parser';
import { NOUN_FLAGS } from './projects';

export async function renameCommand(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const dryRun = takeBoolFlag(args, 'dry-run');
  assertNoExtraFlags(args, NOUN_FLAGS);
  const oldSlug = args.positional[0];
  const newSlug = args.positional[1];
  if (!oldSlug || !newSlug) {
    throw new CliError(
      ExitCodes.USAGE,
      'Usage: condash projects rename <old-slug> <new-slug> [--dry-run]',
    );
  }

  const candidate = await resolveSlug(conceptionPath, oldSlug);
  const report = await renameProjectCore(conceptionPath, candidate.slug, newSlug, { dryRun });
  emit(ctx, report, formatRenameReport);
}

function formatRenameReport(report: RenameProjectReport): string {
  const lines: string[] = [];
  const verb = report.dryRun ? 'Would move' : 'Moved';
  lines.push(`${verb} ${report.moved.from} → ${report.moved.to}`);
  if (report.edits.length > 0) {
    const sites = new Set(report.edits.map((e) => e.file));
    const head = report.dryRun ? 'Planned edits' : 'Rewrote references';
    lines.push(`${head} (${report.edits.length} in ${sites.size} file(s)):`);
    for (const edit of report.edits) {
      lines.push(`  ${edit.file}:${edit.line} ${edit.old} → ${edit.new}`);
    }
  } else {
    lines.push('No references to rewrite.');
  }
  if (report.indexes) {
    const i = report.indexes;
    lines.push(`Indexes regenerated: ${i.tree} (created ${i.created}, updated ${i.updated}).`);
  }
  return lines.join('\n') + '\n';
}
