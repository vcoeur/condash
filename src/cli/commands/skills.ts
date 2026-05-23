/**
 * `condash skills <list|install|status|validate>`
 *
 * Single CLI verb for everything condash drops into a conception:
 *
 *   - **Agent skills** under `<dest>/.agents/skills/<name>/` (skillspec
 *     sources: `spec.yaml` + `body.md` + optional `targets/<claude|kimi>.yaml`
 *     overlays + arbitrary sibling assets). The skillspec compiler in
 *     `src/skillspec/` turns each spec into agent-native skill files for
 *     Claude (`.claude/skills/`) and Kimi (`.kimi/skills/`).
 *   - **Top-level files** at the conception root (e.g. `AGENTS.md`,
 *     `.gitignore`). Each ships the body of one heading-delimited region;
 *     the surrounding text is user-owned and never touched. AGENTS.md
 *     additionally compiles to `.claude/CLAUDE.md` and `.kimi/AGENTS.md`
 *     (target-specific section stripping + variable substitution).
 *
 * Both kinds flow through one manifest at
 * `<dest>/.claude/skills/.condash-skills.json` (v3 schema: `skills.<name>`
 * + `files.<path>`) and share the same refuse-on-edit semantics — if the
 * user edited a tracked source, condash refuses without `--force`.
 *
 * Positionals accept either a skill name (`pr`, `knowledge`, …) or a
 * shipped-file path (`AGENTS.md`, `.gitignore`). With no positionals,
 * everything installs. Unknown positionals error.
 *
 * Two scopes, selected by flag:
 *
 *   • **Repo scope (default)** — installs the artefacts condash ships into
 *     the resolved conception. Pass 1: copy skill source files + write
 *     top-level file regions, both refuse-on-edit. Pass 2: always-compile
 *     (skillspec → target trees, AGENTS.md → per-target outputs) regardless
 *     of pass-1 refusals; the on-disk source is what compiles, so a user-
 *     edited skill body still propagates to `.claude/skills/`.
 *
 *   • **User scope (`--user`)** — compiles user-owned skillspecs at
 *     `~/.config/agents/skills/<name>/` into `~/.claude/skills/<name>/`
 *     + `~/.kimi/skills/<name>/`. No pass-1, no manifest, no top-level
 *     files: the user owns the source tree directly and compiled outputs
 *     are always regenerated. Specs may declare a `hosts:` list; condash
 *     reads `~/.claude/.host` and skips skills whose `hosts:` doesn't
 *     include the current host label.
 *
 * Flags:
 *
 *   `--dest <path>`   retargets the repo-scope install dir (default:
 *                     conception root or cwd). Incompatible with `--user`.
 *   `--user`          switch to user scope. Incompatible with `--dest`.
 *   `--force`         repo scope only: override refuse-on-edit.
 *   `--diff`          repo scope only: show a unified diff per refused item.
 *   `--prune`         repo scope only: drop manifest entries whose shipped
 *                     source has been removed from the bundle (cleans up
 *                     residue from older condash versions).
 *   `--dry-run`       report what would be written without touching disk.
 *
 * This file is a thin dispatcher. Implementation lives in:
 *
 *   skills-shipped.ts  — shipped-tree readers + dest resolution + constants
 *   skills-user-fs.ts  — user-scope path resolvers + readers + host filter
 *   skills-manifest.ts — skill-namespace manifest mutations (prune)
 *   skills-compile.ts  — skillspec → target tree compile pipeline
 *   skills-install.ts  — install verbs (repo + user)
 *   skills-status.ts   — list / status / validate verbs (repo + user)
 */

import { CliError, ExitCodes, type OutputContext } from '../output';
import { type ParsedArgs } from '../parser';
import { UNIVERSAL_FOOTER } from '../help';
import { installRepo, installUserSkills } from './skills-install';
import {
  listRepo,
  listUser,
  repoStatus,
  userSkillsStatus,
  validateSkills,
  validateUserSkills,
} from './skills-status';

export async function runSkills(
  verb: string | null,
  args: ParsedArgs,
  ctx: OutputContext,
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
  const userScope = args.flags.user === true;
  if (userScope && args.flags.dest !== undefined) {
    throw new CliError(ExitCodes.USAGE, '`--user` is incompatible with `--dest`');
  }
  switch (verb) {
    case null:
    case 'list':
      return userScope ? await listUser(args, ctx) : await listRepo(args, ctx);
    case 'install':
      return userScope ? await installUserSkills(args, ctx) : await installRepo(args, ctx);
    case 'status':
      return userScope ? await userSkillsStatus(args, ctx) : await repoStatus(args, ctx);
    case 'validate':
      return userScope ? await validateUserSkills(args, ctx) : await validateSkills(args, ctx);
    default:
      throw new CliError(ExitCodes.USAGE, `Unknown skills verb: ${verb}`);
  }
}

function printHelp(verb: string | null): void {
  switch (verb) {
    case 'list':
    case null:
      process.stdout.write(
        [
          'condash skills list [--user] [--dest <path>]',
          '',
          'List shipped skills + top-level files (and their install status).',
          '',
          'Optional:',
          '  --user        Switch to user scope (~/.config/agents/skills).',
          '  --dest <path> Override repo-scope destination (default: resolved conception).',
          '',
          'Examples:',
          '  condash skills list',
          '  condash skills list --user',
          '',
          UNIVERSAL_FOOTER,
          '',
        ].join('\n'),
      );
      return;
    case 'install':
      process.stdout.write(
        [
          'condash skills install [<skill-or-file>...] [--user] [--dest <path>]',
          '                       [--force] [--diff] [--dry-run] [--prune]',
          '',
          'Install (or refresh) shipped skills + top-level files into the conception.',
          'Refuses to overwrite user-edited sources unless --force.',
          '',
          'User scope (--user) also installs script trees (rsync + chmod +x, no compile):',
          '  ~/.config/agents/agents-scripts/  → ~/.config/agents/scripts/',
          '  ~/.config/agents/claude-scripts/  → ~/.claude/scripts/',
          'And compiles user-scope agent configs from ~/.config/agents/agents/:',
          '  {common,claude}.md  → ~/.claude/CLAUDE.md      (Claude global)',
          '  {common,kimi}.md    → ~/.kimi/AGENTS.md        (Kimi global)',
          '  {common,opencode}.md→ ~/.config/opencode/AGENTS.md (OpenCode global)',
          'Kimi reads no AGENTS.md natively; the condash kimi agent wraps it into a',
          'transient --agent-file (ROLE_ADDITIONAL) at launch.',
          'Sources are silently skipped when absent.',
          '',
          'Optional:',
          '  --user        User scope (~/.config/agents/skills → ~/.claude/, ~/.kimi/; plus script trees above).',
          '  --dest <path> Override repo-scope destination.',
          '  --force       Override refuse-on-edit (repo scope only).',
          '  --diff        Show a unified diff per refused item.',
          '  --dry-run     Report what would change; touch nothing.',
          '  --prune       Drop manifest entries whose shipped source has been removed.',
          '',
          'Examples:',
          '  condash skills install',
          '  condash skills install pr knowledge --diff',
          '  condash skills install --user --dry-run',
          '',
          UNIVERSAL_FOOTER,
          '',
        ].join('\n'),
      );
      return;
    case 'status':
      process.stdout.write(
        [
          'condash skills status [--user] [--dest <path>]',
          '',
          'Per-skill / per-file install state (tracked, edited, missing on source).',
          '',
          'Examples:',
          '  condash skills status',
          '  condash skills status --user --json',
          '',
          UNIVERSAL_FOOTER,
          '',
        ].join('\n'),
      );
      return;
    case 'validate':
      process.stdout.write(
        [
          'condash skills validate [--user] [--dest <path>]',
          '',
          'Lint shipped skill specs + top-level file regions.',
          '',
          'Examples:',
          '  condash skills validate',
          '  condash skills validate --user',
          '',
          UNIVERSAL_FOOTER,
          '',
        ].join('\n'),
      );
      return;
    default:
      printSubHelp();
  }
}

function printSubHelp(): void {
  process.stdout.write(
    [
      'condash skills <verb> [args]',
      '',
      'Verbs:',
      '  list       List shipped skills + top-level files.',
      '  install    Install (or refresh) shipped artefacts.',
      '  status     Per-skill / per-file install state.',
      '  validate   Lint shipped skill specs + top-level file regions.',
      '',
      'Scopes: pass --user for user-scope (~/.config/agents/skills); default is repo scope.',
      '',
      UNIVERSAL_FOOTER,
      '',
    ].join('\n'),
  );
}
