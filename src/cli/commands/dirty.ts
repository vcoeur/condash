import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { touchDirtyMarker } from '../../main/dirty';
import { CliError, ExitCodes, emit, type OutputContext } from '../output';
import { assertNoExtraFlags, type ParsedArgs } from '../parser';

export async function runDirty(
  verb: string | null,
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  if (verb === null || verb === 'list') {
    assertNoExtraFlags(args);
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
    const tree = args.positional[0];
    if (tree !== 'projects' && tree !== 'knowledge') {
      throw new CliError(ExitCodes.USAGE, 'Usage: condash-cli dirty touch <projects|knowledge>');
    }
    assertNoExtraFlags(args);
    await touchDirtyMarker(conceptionPath, tree);
    const path = join(conceptionPath, tree, '.index-dirty');
    emit(ctx, { tree, path, present: true }, (d) => `touched ${(d as { path: string }).path}\n`);
    return;
  }
  if (verb === 'clear') {
    const which = args.positional[0];
    if (which !== 'projects' && which !== 'knowledge' && which !== 'all') {
      throw new CliError(
        ExitCodes.USAGE,
        'Usage: condash-cli dirty clear <projects|knowledge|all>',
      );
    }
    assertNoExtraFlags(args);
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
