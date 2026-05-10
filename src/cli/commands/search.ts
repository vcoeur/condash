import { search as searchAll } from '../../main/search';
import { CliError, ExitCodes, emit, type OutputContext } from '../output';
import { assertNoExtraFlags, parseIntFlag, type ParsedArgs } from '../parser';

export async function runSearch(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const query = args.positional.join(' ').trim();
  if (!query) throw new CliError(ExitCodes.USAGE, 'Usage: condash-cli search <query>');
  const scope = (args.flags.scope as string | undefined) ?? 'all';
  if (!['all', 'projects', 'knowledge'].includes(scope)) {
    throw new CliError(ExitCodes.USAGE, '--scope must be all|projects|knowledge');
  }
  const limit = parseIntFlag(args.flags.limit, 50);
  for (const k of ['scope', 'limit']) delete args.flags[k];
  assertNoExtraFlags(args);

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
    [],
    { streamField: 'hits' },
  );
}
