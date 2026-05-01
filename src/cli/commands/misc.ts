import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { search as searchAll } from '../../main/search';
import { listRepos } from '../../main/repos';
import { CliError, ExitCodes, emit, type OutputContext } from '../output';
import { resolveConception } from '../conception';
import type { ParsedArgs } from '../parser';

export async function runSearch(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const query = args.positional.join(' ').trim();
  if (!query) throw new CliError(ExitCodes.USAGE, 'Usage: condash search <query>');
  const scope = (args.flags.scope as string | undefined) ?? 'all';
  if (!['all', 'projects', 'knowledge'].includes(scope)) {
    throw new CliError(ExitCodes.USAGE, '--scope must be all|projects|knowledge');
  }
  const limit = parseIntFlag(args.flags.limit, 50);

  const results = await searchAll(conceptionPath, query);
  const filtered = scope === 'all' ? results.hits : results.hits.filter((h) => h.source === scope);

  emit(
    ctx,
    {
      query,
      scope,
      hits: filtered.slice(0, limit),
      totalBeforeFilter: results.totalBeforeCap,
      truncated: results.truncated,
      terms: results.terms,
    },
    (d) => {
      const data = d as { hits: typeof filtered };
      if (data.hits.length === 0) return `(no matches for "${query}")\n`;
      return (
        data.hits
          .map((h) => `${h.relPath}: ${h.snippets[0]?.text.slice(0, 120) ?? ''}`)
          .join('\n') + '\n'
      );
    },
  );
}

export async function runRepos(
  verb: string | null,
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  if (verb === null || verb === 'list') {
    const repos = await listRepos(conceptionPath);
    if (!args.flags['include-worktrees']) {
      // Strip worktrees to match the documented default (faster, no per-repo
      // git status shell-out beyond what listRepos already paid for).
      for (const r of repos) delete r.worktrees;
    }
    emit(ctx, repos, (d) => {
      const data = d as typeof repos;
      if (data.length === 0) return '(no repos configured)\n';
      return (
        data
          .map(
            (r) => `${r.kind.padEnd(9)}  ${r.name.padEnd(24)}  ${r.missing ? '(missing)' : r.path}`,
          )
          .join('\n') + '\n'
      );
    });
    return;
  }
  throw new CliError(ExitCodes.USAGE, `Unknown repos verb: ${verb}`);
}

export async function runDirty(
  verb: string | null,
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  if (verb === null || verb === 'list') {
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
      throw new CliError(ExitCodes.USAGE, 'Usage: condash dirty touch <projects|knowledge>');
    }
    const path = join(conceptionPath, tree, '.index-dirty');
    try {
      await fs.utimes(path, new Date(), new Date());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        await fs.writeFile(path, '', 'utf8');
      } else throw err;
    }
    emit(ctx, { tree, path, present: true }, (d) => `touched ${(d as { path: string }).path}\n`);
    return;
  }
  if (verb === 'clear') {
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
    emit(ctx, { cleared }, (d) => {
      const list = (d as { cleared: string[] }).cleared;
      return list.length === 0
        ? '(no markers were present)\n'
        : list.map((p) => `cleared ${p}`).join('\n') + '\n';
    });
    return;
  }
  throw new CliError(ExitCodes.USAGE, `Unknown dirty verb: ${verb}`);
}

export async function runConfig(
  verb: string | null,
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  if (verb === 'conception-path') {
    const resolved = await resolveConception(undefined);
    emit(
      ctx,
      { path: resolved.path, source: resolved.source },
      (d) => `${(d as { path: string }).path}\t(${(d as { source: string }).source})\n`,
    );
    return;
  }
  if (verb === null || verb === 'list') {
    const path = join(conceptionPath, 'configuration.json');
    const raw = await fs.readFile(path, 'utf8');
    const config = JSON.parse(raw);
    emit(ctx, config, () => raw);
    return;
  }
  if (verb === 'get') {
    const key = args.positional[0];
    if (!key) throw new CliError(ExitCodes.USAGE, 'Usage: condash config get <key>');
    const path = join(conceptionPath, 'configuration.json');
    const raw = await fs.readFile(path, 'utf8');
    const config = JSON.parse(raw);
    const value = pickByDottedPath(config, key);
    if (value === undefined) {
      throw new CliError(ExitCodes.NOT_FOUND, `Key '${key}' not found in configuration.json`);
    }
    emit(ctx, value, (d) => `${typeof d === 'string' ? d : JSON.stringify(d, null, 2)}\n`);
    return;
  }
  throw new CliError(ExitCodes.USAGE, `Unknown config verb: ${verb}`);
}

function pickByDottedPath(obj: unknown, dotted: string): unknown {
  const parts = dotted.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    const arrayMatch = part.match(/^([^\[]+)\[(\d+)\]$/);
    if (arrayMatch) {
      const [, name, idx] = arrayMatch;
      const next = (current as Record<string, unknown>)[name];
      if (!Array.isArray(next)) return undefined;
      current = next[Number(idx)];
    } else {
      current = (current as Record<string, unknown>)[part];
    }
  }
  return current;
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

function parseIntFlag(value: string | boolean | undefined, fallback: number): number {
  if (typeof value !== 'string') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
