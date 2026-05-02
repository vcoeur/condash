/**
 * Tiny argv parser for `condash <noun> <verb> [args] [--flags]`.
 *
 * Hand-rolled instead of pulling in commander / yargs:
 *   - Only one shape of CLI to support.
 *   - Help text is generated from the same option specs we parse with, so a
 *     dependency wouldn't reduce code by much.
 *   - Bundle size matters (the CLI is meant to be invoked from skill hooks
 *     hundreds of times per session).
 */

export interface ParsedArgs {
  noun: string | null;
  verb: string | null;
  positional: string[];
  flags: Record<string, string | boolean>;
}

const BOOL_FLAGS = new Set([
  'json',
  'ndjson',
  'quiet',
  'no-color',
  'help',
  'version',
  'with-notes',
  'dry-run',
  'rewrite-aggregated',
  'all',
  'include-worktrees',
  'header',
  'force',
  'diff',
  'no-touch-dirty',
]);

/**
 * Parse argv (without the leading `node` + script). Returns positional in
 * order, flags by long name. Short flags supported: -h, -q, -v.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === '--') {
      // Everything after `--` is positional.
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = (eq === -1 ? token.slice(2) : token.slice(2, eq)).trim();
      if (!name) {
        throw new UsageError(`Empty flag name: '${token}'`);
      }
      if (BOOL_FLAGS.has(name) && eq === -1) {
        flags[name] = true;
        i += 1;
        continue;
      }
      if (eq !== -1) {
        flags[name] = token.slice(eq + 1);
        i += 1;
        continue;
      }
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`Flag '--${name}' expects a value`);
      }
      flags[name] = value;
      i += 2;
      continue;
    }
    if (token.startsWith('-') && token.length === 2) {
      const short = token[1];
      const long = SHORT_TO_LONG[short];
      if (!long) {
        throw new UsageError(`Unknown short flag: '-${short}'`);
      }
      flags[long] = true;
      i += 1;
      continue;
    }
    positional.push(token);
    i += 1;
  }

  const [noun = null, verb = null, ...rest] = positional;
  return {
    noun,
    verb,
    positional: rest,
    flags,
  };
}

const SHORT_TO_LONG: Record<string, string> = {
  h: 'help',
  q: 'quiet',
  v: 'version',
};

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * Pull the universal flags off the parsed bag, returning the subset that
 * every command honours. Mutates `args.flags` (removes the universal entries)
 * so the caller can validate "unknown flags" without re-listing the global
 * ones.
 */
export function takeUniversalFlags(args: ParsedArgs): UniversalFlags {
  const out: UniversalFlags = {
    json: false,
    ndjson: false,
    quiet: false,
    noColor: false,
    help: false,
    version: false,
    conceptionPath: undefined,
  };

  for (const [key, value] of Object.entries(args.flags)) {
    switch (key) {
      case 'json':
        out.json = value === true;
        delete args.flags[key];
        break;
      case 'ndjson':
        out.ndjson = value === true;
        delete args.flags[key];
        break;
      case 'quiet':
        out.quiet = value === true;
        delete args.flags[key];
        break;
      case 'no-color':
        out.noColor = value === true;
        delete args.flags[key];
        break;
      case 'help':
        out.help = value === true;
        delete args.flags[key];
        break;
      case 'version':
        out.version = value === true;
        delete args.flags[key];
        break;
      case 'conception':
        if (typeof value !== 'string') {
          throw new UsageError(`--conception expects a path`);
        }
        out.conceptionPath = value;
        delete args.flags[key];
        break;
    }
  }

  if (out.json && out.ndjson) {
    throw new UsageError('--json and --ndjson are mutually exclusive');
  }
  return out;
}

export interface UniversalFlags {
  json: boolean;
  ndjson: boolean;
  quiet: boolean;
  noColor: boolean;
  help: boolean;
  version: boolean;
  conceptionPath: string | undefined;
}
