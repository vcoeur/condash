/**
 * `condash skills <list|install|status|validate>`
 *
 * Single CLI verb for everything condash drops into a conception:
 *
 *   - **Agent skills** under `<dest>/.agents/skills/<name>/` — `SKILL.md`
 *     (+ optional task `.md` files and an optional `SKILL.<harness>.md`
 *     overlay), placed verbatim. condash no longer compiles to per-harness
 *     dirs; the harness launcher renders them per agent at run time.
 *   - **The `AGENTS.md` marker region** — condash regenerates everything from
 *     line 1 through `<!-- end condash agents -->` on install and preserves the
 *     user-owned tail.
 *   - **`.gitignore`** — ships the body of one heading-delimited region; the
 *     surrounding text is user-owned and never touched.
 *
 * Skill sources and `.gitignore` flow through one manifest at
 * `<dest>/.agents/.condash-skills.json` (v3 schema: `skills.<name>` +
 * `files.<path>`) and share the same refuse-on-edit semantics. `AGENTS.md` is
 * deterministic (the marker is the boundary) and not manifest-tracked.
 *
 * Positionals accept a skill name (`pr`, `knowledge`, …), a region-delimited
 * file path (`.gitignore`), or `AGENTS.md`. With no positionals, everything
 * installs. Unknown positionals error.
 *
 * Flags:
 *
 *   `--dest <path>`   retargets the install dir (default: conception root or cwd).
 *   `--force`         override refuse-on-edit.
 *   `--diff`          show a unified diff per refused item.
 *   `--prune`         drop manifest entries whose shipped source has been removed.
 *   `--dry-run`       report what would be written without touching disk.
 *
 * This file is a thin dispatcher. Implementation lives in:
 *
 *   skills-shipped.ts  — shipped-tree readers + dest resolution + constants
 *   skills-manifest.ts — skill-namespace manifest mutations (prune)
 *   skills-install.ts  — the install verb
 *   skills-status.ts   — list / status / validate verbs
 */

import { CliError, ExitCodes, type OutputContext } from '../output';
import { type ParsedArgs } from '../parser';
import { UNIVERSAL_FOOTER } from '../help';
import { installRepo } from './skills-install';
import { listRepo, repoStatus, validateSkills } from './skills-status';

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
  switch (verb) {
    case null:
    case 'list':
      return await listRepo(args, ctx);
    case 'install':
      return await installRepo(args, ctx);
    case 'status':
      return await repoStatus(args, ctx);
    case 'validate':
      return await validateSkills(args, ctx);
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
          'condash skills list [--dest <path>]',
          '',
          'List shipped skills + top-level files (and their install status).',
          '',
          'Optional:',
          '  --dest <path> Override destination (default: resolved conception).',
          '',
          'Examples:',
          '  condash skills list',
          '',
          UNIVERSAL_FOOTER,
          '',
        ].join('\n'),
      );
      return;
    case 'install':
      process.stdout.write(
        [
          'condash skills install [<skill-or-file>...] [--dest <path>]',
          '                       [--force] [--diff] [--dry-run] [--prune]',
          '',
          'Install (or refresh) shipped skills + top-level files into the conception:',
          '  - skill sources under .agents/skills/<name>/ (SKILL.md + tasks + overlays),',
          '  - the AGENTS.md marker region (head regenerated, tail preserved),',
          '  - the .gitignore region.',
          'Refuses to overwrite user-edited skill sources / .gitignore unless --force.',
          '',
          'Positionals: a skill name, `.gitignore`, or `AGENTS.md`. None = everything.',
          '',
          'Optional:',
          '  --dest <path> Override destination.',
          '  --force       Override refuse-on-edit.',
          '  --diff        Show a unified diff per refused item.',
          '  --dry-run     Report what would change; touch nothing.',
          '  --prune       Drop manifest entries whose shipped source has been removed.',
          '',
          'Examples:',
          '  condash skills install',
          '  condash skills install pr knowledge --diff',
          '  condash skills install AGENTS.md',
          '',
          UNIVERSAL_FOOTER,
          '',
        ].join('\n'),
      );
      return;
    case 'status':
      process.stdout.write(
        [
          'condash skills status [--dest <path>]',
          '',
          'Per-skill / per-file install state (tracked, edited, missing on source).',
          '',
          'Examples:',
          '  condash skills status',
          '  condash skills status --json',
          '',
          UNIVERSAL_FOOTER,
          '',
        ].join('\n'),
      );
      return;
    case 'validate':
      process.stdout.write(
        [
          'condash skills validate [--dest <path>]',
          '',
          'Lint shipped skills (each must have a SKILL.md with a description).',
          '',
          'Examples:',
          '  condash skills validate',
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
      '  validate   Lint shipped skills.',
      '',
      UNIVERSAL_FOOTER,
      '',
    ].join('\n'),
  );
}
