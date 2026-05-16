import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { touchDirtyMarker } from '../../main/dirty';
import { CliError, ExitCodes, emit, type OutputContext } from '../output';
import { assertNoExtraFlags, type ParsedArgs } from '../parser';
import { UNIVERSAL_FOOTER } from '../help';

// `dirty` verbs take only positional args today — the suggestion pool is
// empty but `assertNoExtraFlags(args, NOUN_FLAGS)` still rejects any flag
// the user invents.
const NOUN_FLAGS: readonly string[] = [];

export async function runDirty(
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
    const data = {
      projects: await readMarker(join(conceptionPath, 'projects', '.index-dirty')),
      knowledge: await readMarker(join(conceptionPath, 'knowledge', '.index-dirty')),
    };
    emit(ctx, data, (d) => {
      const x = d as typeof data;
      const lines: string[] = [];
      lines.push(
        `projects:  ${x.projects.present ? `dirty (since ${x.projects.mtime})` : 'clean'}`,
      );
      lines.push(
        `knowledge: ${x.knowledge.present ? `dirty (since ${x.knowledge.mtime})` : 'clean'}`,
      );
      return lines.join('\n') + '\n';
    });
    return;
  }
  if (verb === 'touch') {
    assertNoExtraFlags(args, NOUN_FLAGS);
    const tree = args.positional[0];
    if (tree !== 'projects' && tree !== 'knowledge') {
      throw new CliError(ExitCodes.USAGE, 'Usage: condash dirty touch <projects|knowledge>');
    }
    await touchDirtyMarker(conceptionPath, tree);
    const path = join(conceptionPath, tree, '.index-dirty');
    emit(ctx, { tree, path, present: true }, (d) => `touched ${(d as { path: string }).path}\n`);
    return;
  }
  if (verb === 'clear') {
    assertNoExtraFlags(args, NOUN_FLAGS);
    const which = args.positional[0];
    if (which !== 'projects' && which !== 'knowledge' && which !== 'all') {
      throw new CliError(ExitCodes.USAGE, 'Usage: condash dirty clear <projects|knowledge|all>');
    }
    const targets = which === 'all' ? ['projects', 'knowledge'] : [which];
    const cleared: string[] = [];
    for (const t of targets) {
      const path = join(conceptionPath, t, '.index-dirty');
      try {
        await fs.unlink(path);
        cleared.push(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    emit(
      ctx,
      { cleared },
      (d) => {
        const list = (d as { cleared: string[] }).cleared;
        return list.length === 0
          ? '(no markers were present)\n'
          : list.map((p) => `cleared ${p}`).join('\n') + '\n';
      },
      [],
      { streamField: 'cleared' },
    );
    return;
  }
  throw new CliError(ExitCodes.USAGE, `Unknown dirty verb: ${verb}`);
}

interface MarkerInfo {
  present: boolean;
  mtime: string | null;
}

async function readMarker(path: string): Promise<MarkerInfo> {
  try {
    const stat = await fs.stat(path);
    return { present: true, mtime: stat.mtime.toISOString() };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { present: false, mtime: null };
    }
    throw err;
  }
}

function printHelp(verb: string | null): void {
  switch (verb) {
    case 'list':
    case null:
      process.stdout.write(
        [
          'condash dirty list',
          '',
          'Show the per-tree dirty marker state (which trees need re-indexing).',
          '',
          'Examples:',
          '  condash dirty list',
          '  condash dirty list --json',
          '',
          UNIVERSAL_FOOTER,
          '',
        ].join('\n'),
      );
      return;
    case 'touch':
      process.stdout.write(
        [
          'condash dirty touch <projects|knowledge>',
          '',
          "Force the named tree's dirty marker on so the next index regeneration runs.",
          '',
          'Examples:',
          '  condash dirty touch projects',
          '',
          UNIVERSAL_FOOTER,
          '',
        ].join('\n'),
      );
      return;
    case 'clear':
      process.stdout.write(
        [
          'condash dirty clear <projects|knowledge|all>',
          '',
          "Remove the named tree's dirty marker (or both with `all`).",
          '',
          'Examples:',
          '  condash dirty clear knowledge',
          '  condash dirty clear all',
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
      'condash dirty <verb> [args]',
      '',
      'Verbs:',
      '  list    Show per-tree dirty marker state.',
      "  touch   Force a tree's dirty marker on.",
      "  clear   Remove a tree's dirty marker (or both with `all`).",
      '',
      UNIVERSAL_FOOTER,
      '',
    ].join('\n'),
  );
}
