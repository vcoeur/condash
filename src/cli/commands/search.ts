import { search as searchAll } from '../../main/search';
import { CliError, ExitCodes, emit, type OutputContext } from '../output';
import { assertNoExtraFlags, parseIntFlag, type ParsedArgs } from '../parser';
import { formatSearchHitsHuman } from '../format-hits';
import { renderHelp } from '../help';

const KNOWN_FLAGS_SEARCH = ['scope', 'limit'] as const;

const NOUN_FLAGS: readonly string[] = [...new Set<string>([...KNOWN_FLAGS_SEARCH])];

export async function runSearch(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
  universalHelp = false,
): Promise<void> {
  // `search` is verbless; the help triggers are `search --help` and the
  // `search help` positional alias (which means: query is exactly `help`
  // with no other words → ambiguous, lean toward help).
  if (universalHelp || (args.positional[0] === 'help' && args.positional.length === 1)) {
    printHelp();
    return;
  }
  const scopeFlag = args.flags.scope;
  const limitFlag = args.flags.limit;
  for (const k of ['scope', 'limit']) delete args.flags[k];
  assertNoExtraFlags(args, NOUN_FLAGS);

  const query = args.positional.join(' ').trim();
  if (!query) throw new CliError(ExitCodes.USAGE, 'Usage: condash search <query>');
  const scope = (scopeFlag as string | undefined) ?? 'all';
  if (!['all', 'projects', 'knowledge'].includes(scope)) {
    throw new CliError(ExitCodes.USAGE, '--scope must be all|projects|knowledge');
  }
  const limit = parseIntFlag(limitFlag, 50);

  const scopes = scope === 'all' ? undefined : [scope];
  const results = await searchAll(conceptionPath, query, scopes);
  const filtered = results.hits;

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
      return formatSearchHitsHuman(data.hits, `(no matches for "${query}")\n`);
    },
    [],
    { streamField: 'hits' },
  );
}

function printHelp(): void {
  process.stdout.write(
    renderHelp([
      'condash search <query> [--scope <scope>] [--limit <n>]',
      '',
      'Cross-tree search across project READMEs/notes and knowledge files.',
      '',
      'Optional:',
      '  --scope    all | projects | knowledge   (default: all)',
      '  --limit    Maximum hits to return       (default: 50)',
      '',
      'Examples:',
      '  condash search "dirty marker"',
      '  condash search retention --scope knowledge --limit 10',
    ]),
  );
}
