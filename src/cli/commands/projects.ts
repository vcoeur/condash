import { CliError, ExitCodes, type OutputContext } from '../output';
import { type ParsedArgs } from '../parser';
import {
  listProjects,
  readProject,
  resolveCommand,
  searchProjects,
  validateCommand,
} from './projects-read';
import { statusCommand, closeProject, reopenProject } from './projects-mutate';
import {
  indexCommand,
  createCommand,
  scanPromotionsCommand,
  rewriteHeadersCommand,
  backfillClosed,
  createProjectCore,
  isValidSlugTail,
} from './projects-maintenance';
import type { CreateProjectInput, CreateProjectResult } from './projects-maintenance';

// Re-exports kept on the historical import path. `createProjectCore` and
// helpers live in src/main/create-project.ts; we surface them here so any
// external consumer that imported from this file keeps working.
export { createProjectCore, isValidSlugTail };
export type { CreateProjectInput, CreateProjectResult };

export async function runProjects(
  verb: string | null,
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  switch (verb) {
    case null:
    case 'list':
      return verb === null ? printSubHelp() : await listProjects(args, ctx, conceptionPath);
    case 'read':
      return await readProject(args, ctx, conceptionPath);
    case 'resolve':
      return await resolveCommand(args, ctx, conceptionPath);
    case 'search':
      return await searchProjects(args, ctx, conceptionPath);
    case 'validate':
      return await validateCommand(args, ctx, conceptionPath);
    case 'status':
      return await statusCommand(args, ctx, conceptionPath);
    case 'close':
      return await closeProject(args, ctx, conceptionPath);
    case 'reopen':
      return await reopenProject(args, ctx, conceptionPath);
    case 'backfill-closed':
      return await backfillClosed(args, ctx, conceptionPath);
    case 'index':
      return await indexCommand(args, ctx, conceptionPath);
    case 'create':
      return await createCommand(args, ctx, conceptionPath);
    case 'scan-promotions':
      return await scanPromotionsCommand(args, ctx, conceptionPath);
    case 'rewrite-headers':
      return await rewriteHeadersCommand(args, ctx, conceptionPath);
    default:
      throw new CliError(ExitCodes.USAGE, `Unknown projects verb: ${verb}`);
  }
}

function printSubHelp(): void {
  process.stdout.write(
    [
      'condash-cli projects <verb> [args]',
      '',
      'Verbs:',
      '  list             List projects (filters: --status --kind --apps --branch).',
      '  read             Read a project README + metadata.',
      '  resolve          Resolve a slug to its absolute path.',
      '  search           Search project READMEs and notes.',
      '  validate         Validate header(s) against canonical enums.',
      '  status           get|set the **Status** field. set: --summary appends to ## Timeline on done-edges.',
      '  close            Flip status to done + append closing timeline entry. --summary "..." annotates the entry.',
      '  reopen           Flip status from done back to --status (default now) + append reopen entry.',
      '  backfill-closed  One-shot: append `Closed.` timeline entries to legacy done items missing one. --dry-run previews.',
      '  index            Regenerate projects/index.md + month indexes.',
      '  create           Create a new item: --kind --slug --apps --title [--branch …].',
      "  scan-promotions  Surface durable-finding candidates inside an item's notes/.",
      '  rewrite-headers  One-shot: convert legacy bold-prose headers to YAML frontmatter. --dry-run previews.',
      '',
    ].join('\n'),
  );
}
