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
  'force-rm',
  'diff',
  'no-touch-dirty',
  'copy-env',
  'install',
  'no-env',
  'no-install',
  'effective',
  'global',
  'user',
  'prune',
  'fix',
  'active',
  'meta',
  'with-meta',
  'redact',
  'record',
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
      // Reject duplicates: a second `--foo bar --foo baz` is almost always
      // a typo or shell-history mishap, and silently letting the second
      // value win has burned skills that thought they were composing
      // additive flags. Boolean flags get the same treatment for symmetry
      // (a true→true overwrite is still a sign of a mistake).
      if (Object.prototype.hasOwnProperty.call(flags, name)) {
        throw new UsageError(`Flag '--${name}' specified more than once`);
      }
      if (BOOL_FLAGS.has(name)) {
        if (eq !== -1) {
          throw new UsageError(`Boolean flag '--${name}' does not accept a value`);
        }
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
      // The previous "starts with --" check rejected `--flag --next` but
      // also wrongly rejected `--flag -X` (legitimate short-flag value
      // inside CSV inputs). Tighten to "exactly the next token starts
      // with `--`": short flags pass through as positional values.
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
        // Trim leading/trailing whitespace: copy-paste from a Markdown
        // log or YAML config easily picks up a stray space, and the
        // resulting `path.resolve(' /home/alice/...')` silently maps to
        // `cwd/ /home/alice/...` instead of the intended absolute path.
        out.conceptionPath = value.trim();
        if (out.conceptionPath.length === 0) {
          throw new UsageError(`--conception value is empty`);
        }
        delete args.flags[key];
        break;
    }
  }

  if (out.json && out.ndjson) {
    throw new UsageError('--json and --ndjson are mutually exclusive');
  }
  return out;
}

/**
 * Reject any flag keys remaining on `args.flags` after the command has
 * extracted everything it knows about. Pass-4 and pass-5 audits flagged
 * that `takeUniversalFlags` documents this as the caller's responsibility
 * but every command was silently dropping unknown flags. Call this at
 * the END of a command's flag extraction (after pulling each known key
 * into a local) to catch typos like `--sortx status`.
 *
 * When `siblingPool` is supplied, each unknown flag is matched against it
 * via Levenshtein distance ≤ 2; the closest unique match is appended as
 * `(did you mean --X?)`. Pass the union of every flag valid on the noun
 * (across its verbs), not just the current verb's set, so a typo of a
 * sibling-verb flag is suggested even when this verb wouldn't accept it.
 * Pre-2026-05-16 callers of `assertNoExtraFlags(args)` keep working
 * unchanged (no suggestion, same single-flag error).
 */
export function assertNoExtraFlags(args: ParsedArgs, siblingPool?: readonly string[]): void {
  const extras = Object.keys(args.flags);
  if (extras.length === 0) return;
  const word = extras.length === 1 ? 'flag' : 'flags';
  const tagged = extras.map((k) => {
    if (!siblingPool) return `--${k}`;
    const hint = suggestFlag(k, siblingPool);
    return hint ? `--${k} (did you mean --${hint}?)` : `--${k}`;
  });
  throw new UsageError(`Unknown ${word}: ${tagged.join(', ')}`);
}

/**
 * Closest match for `typo` within Levenshtein distance ≤ 2; returns null
 * when nothing is close enough or when two candidates tie. Used by
 * `assertNoExtraFlags` to attach a `(did you mean --X?)` hint to unknown
 * flag errors.
 */
export function suggestFlag(typo: string, candidates: readonly string[]): string | null {
  let best: { name: string; dist: number } | null = null;
  for (const cand of candidates) {
    if (cand === typo) continue; // shouldn't happen — typo by definition isn't valid
    const d = levenshtein(typo, cand);
    if (d > 2) continue;
    if (!best || d < best.dist) {
      best = { name: cand, dist: d };
    } else if (d === best.dist && cand !== best.name) {
      // Two candidates at the same distance — prefer no suggestion over a
      // coin-flip.
      return null;
    }
  }
  return best?.name ?? null;
}

/**
 * Iterative Levenshtein with a single rolling row. ~12 lines instead of a
 * dependency; runs once per unknown flag against ~20-flag pools.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * Parse a positive-integer flag value, falling back to `fallback` when the
 * value is missing, non-string, or not a positive int. Four byte-identical
 * copies used to live across the command files.
 */
export function parseIntFlag(value: string | boolean | undefined, fallback: number): number {
  if (typeof value !== 'string') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Parse a comma-separated string flag into a trimmed, non-empty list.
 * Returns `null` when the flag is missing/non-string or all entries are
 * empty after trimming. Used by every verb that accepts CSV inputs
 * (`--apps`, `--status`, `--kind`, `--repo`). Centralised to retire the
 * parseCsvFlag/parseRepoFlag duplicates that had drifted across the
 * command files.
 */
export function parseCsvFlag(value: string | boolean | undefined): string[] | null {
  if (typeof value !== 'string') return null;
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length === 0 ? null : parts;
}

/**
 * Pull a string-valued flag off the bag and delete it. Returns `null` when the
 * flag is absent. Throws a `UsageError` when the flag is present as a bare
 * boolean (`--name` with no value) — every consuming command expects a value.
 *
 * This is the consume-and-delete counterpart to the read-only `parseIntFlag`/
 * `parseCsvFlag`: it mutates `args.flags` so `assertNoExtraFlags` stays the
 * single source of "what's left is unknown". Retires the per-command
 * `takeString`/`takeStringFlag`/`consumeFlag` copies.
 */
export function takeStringFlag(args: ParsedArgs, name: string): string | null {
  const value = args.flags[name];
  if (value === undefined) return null;
  if (typeof value !== 'string') {
    throw new UsageError(`--${name} expects a value`);
  }
  delete args.flags[name];
  return value;
}

/**
 * Pull a boolean flag off the bag and delete it, returning whether it was
 * present-and-true. A flag carrying a string value (`--name=x`) still counts
 * as present here — callers use this for switches the parser already typed as
 * booleans, so that case is a misuse the command's `assertNoExtraFlags` would
 * otherwise miss; treat any presence as "set".
 */
export function takeBoolFlag(args: ParsedArgs, name: string): boolean {
  const present = args.flags[name] !== undefined;
  if (present) delete args.flags[name];
  return present;
}

/**
 * Pull an integer-valued flag off the bag and delete it. Returns `null` when
 * absent. Throws `UsageError` when the value is non-numeric or out of range.
 * `allowZero` permits 0 (e.g. a `--from-byte 0` "from the start" cursor);
 * otherwise the value must be a positive integer.
 */
export function takeIntFlag(args: ParsedArgs, name: string, allowZero = false): number | null {
  const value = args.flags[name];
  if (value === undefined) return null;
  if (typeof value !== 'string') {
    throw new UsageError(`--${name} expects a number`);
  }
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) {
    throw new UsageError(
      `--${name} must be a ${allowZero ? 'non-negative' : 'positive'} integer (got '${value}')`,
    );
  }
  delete args.flags[name];
  return n;
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
