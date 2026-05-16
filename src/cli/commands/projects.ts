import { CliError, ExitCodes, type OutputContext } from '../output';
import { type ParsedArgs } from '../parser';
import { UNIVERSAL_FOOTER } from '../help';
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

// Per-verb known flags. Used both to (a) reorder validation so unknown-flag
// errors come before missing-required, and (b) build NOUN_FLAGS — the
// suggestion pool used by `assertNoExtraFlags(args, NOUN_FLAGS)` so a typo
// of a sibling-verb flag still gets a `(did you mean --X?)` hint.
export const KNOWN_FLAGS_LIST = ['status', 'kind', 'apps', 'branch', 'sort'] as const;
export const KNOWN_FLAGS_READ = ['with-notes'] as const;
export const KNOWN_FLAGS_RESOLVE: readonly string[] = [];
export const KNOWN_FLAGS_SEARCH = ['limit', 'status', 'kind'] as const;
export const KNOWN_FLAGS_VALIDATE = ['all', 'path'] as const;
export const KNOWN_FLAGS_STATUS = ['summary'] as const;
export const KNOWN_FLAGS_CLOSE = ['status', 'summary', 'no-touch-dirty'] as const;
export const KNOWN_FLAGS_REOPEN = ['status'] as const;
export const KNOWN_FLAGS_BACKFILL_CLOSED = ['dry-run'] as const;
export const KNOWN_FLAGS_INDEX = ['dry-run', 'rewrite-aggregated'] as const;
export const KNOWN_FLAGS_CREATE = [
  'apps',
  'kind',
  'slug',
  'title',
  'branch',
  'base',
  'date',
  'status',
  'severity',
  'severity-impact',
  'environment',
] as const;
export const KNOWN_FLAGS_SCAN_PROMOTIONS: readonly string[] = [];
export const KNOWN_FLAGS_REWRITE_HEADERS = ['dry-run'] as const;

export const NOUN_FLAGS: readonly string[] = [
  ...new Set<string>([
    ...KNOWN_FLAGS_LIST,
    ...KNOWN_FLAGS_READ,
    ...KNOWN_FLAGS_RESOLVE,
    ...KNOWN_FLAGS_SEARCH,
    ...KNOWN_FLAGS_VALIDATE,
    ...KNOWN_FLAGS_STATUS,
    ...KNOWN_FLAGS_CLOSE,
    ...KNOWN_FLAGS_REOPEN,
    ...KNOWN_FLAGS_BACKFILL_CLOSED,
    ...KNOWN_FLAGS_INDEX,
    ...KNOWN_FLAGS_CREATE,
    ...KNOWN_FLAGS_SCAN_PROMOTIONS,
    ...KNOWN_FLAGS_REWRITE_HEADERS,
  ]),
];

export async function runProjects(
  verb: string | null,
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
  universalHelp = false,
): Promise<void> {
  if (verb === 'help') {
    printHelp(args.positional[0] ?? null);
    return;
  }
  if (universalHelp) {
    printHelp(verb);
    return;
  }
  switch (verb) {
    case null:
      printHelp(null);
      return;
    case 'list':
      return await listProjects(args, ctx, conceptionPath);
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

function printHelp(verb: string | null): void {
  switch (verb) {
    case 'list':
      writeBlock([
        'condash projects list [--status <s>] [--kind <k>] [--apps <a,b>] [--branch <br>] [--sort <s>]',
        '',
        'List projects, filtered + sorted.',
        '',
        'Optional:',
        '  --status   CSV of {now, review, later, backlog, done}.',
        '  --kind     CSV of {project, incident, document}.',
        '  --apps     CSV of app names; matches if any overlap.',
        '  --branch   Exact branch match.',
        '  --sort     status (default) | slug | date',
        '',
        'Examples:',
        '  condash projects list',
        '  condash projects list --status now,review --sort date',
      ]);
      return;
    case 'read':
      writeBlock([
        'condash projects read <slug> [--with-notes]',
        '',
        'Read a project README + parsed metadata.',
        '',
        'Optional:',
        '  --with-notes   Also include the contents of notes/*.md.',
        '',
        'Examples:',
        '  condash projects read condash-cli-ux-fixes',
        '  condash projects read condash-cli-ux-fixes --with-notes --json',
      ]);
      return;
    case 'resolve':
      writeBlock([
        'condash projects resolve <slug>',
        '',
        'Resolve a slug to its absolute item path.',
        '',
        'Examples:',
        '  condash projects resolve condash-cli-ux-fixes',
      ]);
      return;
    case 'search':
      writeBlock([
        'condash projects search <query> [--status <s>] [--kind <k>] [--limit <n>]',
        '',
        'Full-text search restricted to project READMEs/notes.',
        '',
        'Optional:',
        '  --status   CSV of statuses to filter by.',
        '  --kind     CSV of kinds to filter by.',
        '  --limit    Maximum hits to return (default: 50).',
        '',
        'Examples:',
        '  condash projects search "dirty marker"',
        '  condash projects search retention --status now,review --limit 20',
      ]);
      return;
    case 'validate':
      writeBlock([
        'condash projects validate [<slug> | --all | --path <readme>]',
        '',
        'Validate one or many project READMEs against the canonical header schema.',
        '',
        'Optional:',
        '  --all          Validate every project README.',
        '  --path <p>     Validate one specific README (must resolve inside the conception).',
        '',
        'Examples:',
        '  condash projects validate condash-cli-ux-fixes',
        '  condash projects validate --all --json',
      ]);
      return;
    case 'status':
      writeBlock([
        'condash projects status <get|set> <slug> [<value>] [--summary <text>]',
        '',
        'Get or set the **Status** field. On set, --summary appends a Timeline entry on done-edges.',
        '',
        'Optional:',
        '  --summary   Annotate the Timeline entry written on done-edges.',
        '',
        'Examples:',
        '  condash projects status get condash-cli-ux-fixes',
        '  condash projects status set condash-cli-ux-fixes review',
        '  condash projects status set condash-cli-ux-fixes done --summary "shipped via PR #42"',
      ]);
      return;
    case 'close':
      writeBlock([
        'condash projects close <slug> [--status <s>] [--summary <text>] [--no-touch-dirty]',
        '',
        'Flip status to done + append a closing Timeline entry; warn on leftover branch/worktree.',
        '',
        'Optional:',
        '  --status           Override target status (default: done).',
        '  --summary          Annotate the Timeline entry.',
        '  --no-touch-dirty   Skip touching the projects dirty marker.',
        '',
        'Examples:',
        '  condash projects close condash-cli-ux-fixes',
        '  condash projects close condash-cli-ux-fixes --summary "shipped"',
      ]);
      return;
    case 'reopen':
      writeBlock([
        'condash projects reopen <slug> [--status <s>]',
        '',
        'Flip status from done back to --status (default: now) + append a reopen Timeline entry.',
        '',
        'Optional:',
        '  --status   Target status (default: now). `done` is rejected.',
        '',
        'Examples:',
        '  condash projects reopen condash-cli-ux-fixes',
        '  condash projects reopen condash-cli-ux-fixes --status review',
      ]);
      return;
    case 'backfill-closed':
      writeBlock([
        'condash projects backfill-closed [--dry-run]',
        '',
        'One-shot: append `Closed.` Timeline entries to legacy done items missing one.',
        'Date is taken from `git log -1` on the README, falling back to mtime.',
        '',
        'Optional:',
        '  --dry-run   Preview without writing.',
        '',
        'Examples:',
        '  condash projects backfill-closed --dry-run',
        '  condash projects backfill-closed',
      ]);
      return;
    case 'index':
      writeBlock([
        'condash projects index [--dry-run] [--rewrite-aggregated]',
        '',
        'Regenerate projects/index.md + month indexes.',
        '',
        'Optional:',
        '  --dry-run                Preview without writing.',
        '  --rewrite-aggregated     One-shot: re-derive every aggregated bullet.',
        '',
        'Examples:',
        '  condash projects index',
        '  condash projects index --dry-run --json',
      ]);
      return;
    case 'create':
      writeBlock([
        'condash projects create --kind <kind> --slug <slug> --title <text> --apps <a,b> [flags]',
        '',
        'Create a new item under projects/YYYY-MM/<slug>/.',
        '',
        'Required:',
        '  --kind     project | incident | document',
        '  --slug     lowercase letters, digits, hyphens',
        '  --title    free text',
        '  --apps     comma-separated app list (e.g. condash,knoten)',
        '',
        'Optional:',
        '  --branch              git branch name',
        '  --base                base branch for PRs (default: main)',
        '  --status              now | review | later | backlog  (default: now)',
        '  --date                YYYY-MM-DD (default: today)',
        '  --severity            low | medium | high           (incidents only)',
        '  --severity-impact     free text                     (incidents only)',
        '  --environment         PROD | STAGING | DEV          (incidents only)',
        '',
        'Examples:',
        '  condash projects create --kind project --slug fix-x --title "Fix X" --apps condash',
        '  condash projects create --kind project --slug y --title "Y" --apps a,b --status later',
      ]);
      return;
    case 'scan-promotions':
      writeBlock([
        'condash projects scan-promotions <slug>',
        '',
        "Surface durable-finding candidates inside an item's notes/ for /knowledge promotion.",
        '',
        'Examples:',
        '  condash projects scan-promotions condash-cli-ux-fixes',
      ]);
      return;
    case 'rewrite-headers':
      writeBlock([
        'condash projects rewrite-headers [--dry-run]',
        '',
        'One-shot migration: convert legacy bold-prose headers to YAML frontmatter.',
        '',
        'Optional:',
        '  --dry-run   Preview without writing.',
        '',
        'Examples:',
        '  condash projects rewrite-headers --dry-run',
      ]);
      return;
    default:
      printSubHelp();
  }
}

function writeBlock(lines: string[]): void {
  process.stdout.write([...lines, '', UNIVERSAL_FOOTER, ''].join('\n'));
}

function printSubHelp(): void {
  process.stdout.write(
    [
      'condash projects <verb> [args]',
      '',
      'Verbs:',
      '  list             List projects (filters: --status --kind --apps --branch).',
      '  read             Read a project README + metadata.',
      '  resolve          Resolve a slug to its absolute path.',
      '  search           Search project READMEs and notes.',
      '  validate         Validate header(s) against canonical enums.',
      '  status           get|set the **Status** field.',
      '  close            Flip status to done + append closing Timeline entry.',
      '  reopen           Flip status from done back to --status (default: now).',
      '  backfill-closed  One-shot: append `Closed.` to legacy done items.',
      '  index            Regenerate projects/index.md + month indexes.',
      '  create           Create a new item.',
      '  scan-promotions  Surface durable-finding candidates inside notes/.',
      '  rewrite-headers  One-shot: convert legacy bold-prose headers to YAML.',
      '',
      UNIVERSAL_FOOTER,
      '',
    ].join('\n'),
  );
}
