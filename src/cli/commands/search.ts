import { search as searchAll } from '../../main/search';
import { ALL_SCOPES } from '../../shared/types';
import { CliError, ExitCodes, emit, type OutputContext } from '../output';
import { assertNoExtraFlags, takeIntFlag, takeStringFlag, type ParsedArgs } from '../parser';
import { formatSearchHitsHuman } from '../format-hits';
import { renderHelp } from '../help';

const KNOWN_FLAGS_SEARCH = ['scope', 'limit'] as const;

const NOUN_FLAGS: readonly string[] = [...new Set<string>([...KNOWN_FLAGS_SEARCH])];

/** Every accepted `--scope` value: the four indexed markdown scopes, the
 * on-demand logs disk-scan, and `all` (= ALL_SCOPES, logs excluded). */
const VALID_SCOPES: readonly string[] = [...ALL_SCOPES, 'logs', 'all'];

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
  const scope = takeStringFlag(args, 'scope') ?? 'all';
  const limit = takeIntFlag(args, 'limit') ?? 50;
  assertNoExtraFlags(args, NOUN_FLAGS);

  const query = args.positional.join(' ').trim();
  if (!query) throw new CliError(ExitCodes.USAGE, 'Usage: condash search <query>');
  if (!VALID_SCOPES.includes(scope)) {
    throw new CliError(
      ExitCodes.USAGE,
      '--scope must be all|projects|knowledge|resources|skills|logs',
    );
  }

  // `all` forwards exactly the four indexed markdown scopes — never
  // `undefined`, which the backend treats as "everything" and would pay the
  // logs disk-scan on every default query.
  const scopes = scope === 'all' ? [...ALL_SCOPES] : [scope];
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
      'Cross-tree search across project READMEs/notes, knowledge, resources,',
      'skill files, and saved session logs.',
      '',
      'Optional:',
      '  --scope    all | projects | knowledge | resources | skills | logs',
      '             (default: all = the four markdown scopes; logs are',
      '             disk-scanned and searched only with --scope logs)',
      '  --limit    Maximum hits to return  (default: 50)',
      '',
      'Examples:',
      '  condash search "dirty marker"',
      '  condash search retention --scope knowledge --limit 10',
      '  condash search "exit code" --scope logs',
    ]),
  );
}
