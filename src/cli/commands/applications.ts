import {
  addApplication,
  fixAppsReferences,
  listApplications,
  renameApplication,
  setApplication,
  syncAppsDocs,
  validateApplications,
} from '../../main/applications';
import { CliError, ExitCodes, emit, type OutputContext } from '../output';
import { assertNoExtraFlags, type ParsedArgs } from '../parser';
import { UNIVERSAL_FOOTER } from '../help';

const NOUN_FLAGS: readonly string[] = ['label', 'path', 'fix'];

/**
 * `condash applications <verb>` — manage the app registry: the single source
 * of truth for `#handle` identity. Thin wrapper over `main/applications.ts`.
 */
export async function runApplications(
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

  if (verb === null || verb === 'list') {
    assertNoExtraFlags(args, NOUN_FLAGS);
    const apps = await listApplications(conceptionPath);
    emit(ctx, apps, (d) => {
      const data = d as typeof apps;
      if (data.length === 0) return '(no applications registered)\n';
      return (
        data
          .map((a) => {
            const tag = a.retired ? '(retired)' : (a.path ?? '');
            return `#${a.handle.padEnd(20)}  ${tag}`;
          })
          .join('\n') + '\n'
      );
    });
    return;
  }

  if (verb === 'validate') {
    const fix = args.flags.fix === true;
    delete args.flags.fix;
    assertNoExtraFlags(args, NOUN_FLAGS);
    if (fix) {
      const result = await fixAppsReferences(conceptionPath);
      emit(ctx, result, (d) => {
        const r = d as typeof result;
        const head = `canonicalised apps: in ${r.readmesRewritten.length} README(s)\n`;
        if (r.unresolved.length === 0) return head;
        return (
          head + r.unresolved.map((i) => `  unresolved: ${i.ref}  (${i.readme})`).join('\n') + '\n'
        );
      });
      if (result.unresolved.length > 0) {
        throw new CliError(
          ExitCodes.VALIDATION,
          `${result.unresolved.length} unresolved app reference(s) need a manual fix`,
        );
      }
      return;
    }
    const issues = await validateApplications(conceptionPath);
    const unknown = issues.filter((i) => i.problem === 'unknown-handle');
    emit(ctx, { ok: unknown.length === 0, issues }, (d) => {
      const data = d as { ok: boolean; issues: typeof issues };
      if (data.issues.length === 0) return 'all apps: references resolve\n';
      return (
        data.issues
          .map((i) => {
            const fix = i.suggestion ? ` → ${i.suggestion}` : '';
            return `${i.problem === 'unknown-handle' ? 'ERROR' : 'alias'}  ${i.ref}${fix}  (${i.readme})`;
          })
          .join('\n') + '\n'
      );
    });
    // Unknown handles are a validation failure (exit 3); alias-only is advisory.
    if (unknown.length > 0) {
      throw new CliError(ExitCodes.VALIDATION, `${unknown.length} unresolved app reference(s)`);
    }
    return;
  }

  if (verb === 'sync-docs') {
    assertNoExtraFlags(args, NOUN_FLAGS);
    const result = await syncAppsDocs(conceptionPath);
    emit(ctx, result, (d) => {
      const r = d as typeof result;
      if (r.missingSentinels) {
        return `AGENTS.md has no condash:apps sentinels — add them around the Apps table once, then re-run.\n`;
      }
      return r.changed
        ? `regenerated Apps table in AGENTS.md\n`
        : `Apps table already up to date\n`;
    });
    return;
  }

  if (verb === 'add') {
    const label = takeStringFlag(args, 'label');
    const path = takeStringFlag(args, 'path');
    assertNoExtraFlags(args, NOUN_FLAGS);
    const handle = args.positional[0];
    if (!handle || !path) {
      throw new CliError(
        ExitCodes.USAGE,
        'Usage: condash applications add <handle> --path <path> [--label <label>]',
      );
    }
    await addApplication(conceptionPath, { handle, path, label });
    emit(ctx, { ok: true, handle }, () => `registered #${handle}\n`);
    return;
  }

  if (verb === 'set') {
    const label = takeStringFlag(args, 'label');
    const path = takeStringFlag(args, 'path');
    assertNoExtraFlags(args, NOUN_FLAGS);
    const handle = args.positional[0];
    if (!handle || (label === undefined && path === undefined)) {
      throw new CliError(
        ExitCodes.USAGE,
        'Usage: condash applications set <handle> [--label <label>] [--path <path>]',
      );
    }
    await setApplication(conceptionPath, handle, { label, path });
    emit(ctx, { ok: true, handle }, () => `updated #${handle}\n`);
    return;
  }

  if (verb === 'rename') {
    assertNoExtraFlags(args, NOUN_FLAGS);
    const from = args.positional[0];
    const to = args.positional[1];
    if (!from || !to) {
      throw new CliError(ExitCodes.USAGE, 'Usage: condash applications rename <old> <new>');
    }
    const result = await renameApplication(conceptionPath, from, to);
    emit(
      ctx,
      result,
      (d) =>
        `renamed #${(d as typeof result).oldHandle} → #${(d as typeof result).newHandle}; ` +
        `rewrote ${(d as typeof result).readmesRewritten.length} README(s)\n`,
    );
    return;
  }

  throw new CliError(ExitCodes.USAGE, `Unknown applications verb: ${verb}`);
}

/** Consume a `--flag <value>` string flag, returning undefined when absent. */
function takeStringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  delete args.flags[name];
  if (value === undefined || value === true) return undefined;
  return String(value);
}

function printHelp(verb: string | null): void {
  if (verb && verb !== 'list') {
    process.stdout.write(verbHelp(verb));
    return;
  }
  process.stdout.write(
    [
      'condash applications <verb> [args]',
      '',
      'The app registry — one canonical #handle per app, with label + path.',
      '',
      'Verbs:',
      '  list                       List registered apps (live + retired).',
      '  add <handle> --path P      Register a new app.',
      '  set <handle> [--label|--path]   Update an app.',
      '  rename <old> <new>         Rename a handle; rewrites README refs.',
      '  sync-docs                  Regenerate the AGENTS.md Apps table.',
      '  validate                   Check every README apps: resolves.',
      UNIVERSAL_FOOTER,
    ].join('\n'),
  );
}

function verbHelp(verb: string): string {
  const lines: Record<string, string[]> = {
    add: [
      'condash applications add <handle> --path <path> [--label <label>]',
      '',
      'Register a new live app. <path> is relative to workspace_path or absolute.',
    ],
    set: [
      'condash applications set <handle> [--label <label>] [--path <path>]',
      '',
      "Update a registered app's label or path.",
    ],
    rename: [
      'condash applications rename <old-handle> <new-handle>',
      '',
      'Rename a handle. Records the old handle as an alias and rewrites every',
      'project README apps: reference that pointed at it.',
    ],
    'sync-docs': [
      'condash applications sync-docs',
      '',
      'Regenerate the Apps table in AGENTS.md between the condash:apps sentinels',
      'from the registry. CLAUDE.md is compiled from AGENTS.md downstream.',
    ],
    validate: [
      'condash applications validate [--fix]',
      '',
      'Every project README apps: value must resolve to a known #handle (live or',
      'retired) or an existing absolute path. Unknown handles exit 3.',
      '',
      '  --fix   Rewrite every resolvable apps: value to its canonical #handle',
      '          (bare names and legacy aliases alike). Unresolved refs are left',
      '          in place and reported; the run still exits 3 if any remain.',
    ],
  };
  return [...(lines[verb] ?? [`condash applications ${verb}`]), UNIVERSAL_FOOTER].join('\n');
}
