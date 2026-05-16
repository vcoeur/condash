/**
 * Output + exit-code helpers shared by every command.
 *
 * Stdout carries data; stderr carries diagnostics. With `--json` the output
 * is a single envelope; with `--ndjson` it's one line per record. Without
 * either, we emit human-readable text.
 *
 * Exit codes are documented in the design notes (`notes/01-design-overview.md`)
 * and form the contract with skills — adding a new code is a major bump.
 */

export const ExitCodes = {
  OK: 0,
  RUNTIME: 1,
  USAGE: 2,
  VALIDATION: 3,
  NOT_FOUND: 4,
  NO_CONCEPTION: 5,
  AMBIGUOUS: 6,
} as const;

export type ExitCode = (typeof ExitCodes)[keyof typeof ExitCodes];

export const ErrorCodes: Record<ExitCode, string> = {
  [ExitCodes.OK]: 'OK',
  [ExitCodes.RUNTIME]: 'RUNTIME',
  [ExitCodes.USAGE]: 'USAGE',
  [ExitCodes.VALIDATION]: 'VALIDATION',
  [ExitCodes.NOT_FOUND]: 'NOT_FOUND',
  [ExitCodes.NO_CONCEPTION]: 'NO_CONCEPTION',
  [ExitCodes.AMBIGUOUS]: 'AMBIGUOUS',
};

export interface OutputContext {
  json: boolean;
  ndjson: boolean;
  quiet: boolean;
  noColor: boolean;
}

export interface JsonEnvelope<T> {
  ok: boolean;
  data?: T;
  warnings: string[];
  error?: {
    code: string;
    message: string;
    [key: string]: unknown;
  };
}

/**
 * Domain error carrying a stable exit code + an optional details payload that
 * gets surfaced under `error` in the JSON envelope. Throw it from any command;
 * the top-level dispatcher converts it to the right exit code + envelope.
 */
export class CliError extends Error {
  readonly exitCode: ExitCode;
  readonly details: Record<string, unknown>;

  constructor(exitCode: ExitCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function notFound(message: string, details: Record<string, unknown> = {}): never {
  throw new CliError(ExitCodes.NOT_FOUND, message, details);
}

export function ambiguous(message: string, candidates: unknown[]): never {
  throw new CliError(ExitCodes.AMBIGUOUS, message, { candidates });
}

export function validation(message: string, details: Record<string, unknown> = {}): never {
  throw new CliError(ExitCodes.VALIDATION, message, details);
}

export function usage(message: string): never {
  throw new CliError(ExitCodes.USAGE, message);
}

export function noConception(triedSources: string[]): never {
  throw new CliError(ExitCodes.NO_CONCEPTION, 'No conception path resolved', { triedSources });
}

/**
 * Per-command --ndjson shape hint.
 *
 * Most CLI verbs return a single envelope-shaped object. The historic
 * contract — "ndjson means data MUST be an array" — crashed those verbs
 * with a RUNTIME exit code when invoked under `--ndjson`. The new shape:
 *
 *   - `data` is itself an array → stream each row, no trailer.
 *   - `streamField` is set and `data[streamField]` is an array → stream
 *     those rows, then emit one trailing `{ "__meta": <rest> }` line
 *     carrying every other top-level field (so consumers that want the
 *     summary still see it without having to guess where the boundary is).
 *   - Otherwise → emit `data` as a single line (same shape `--json` would
 *     produce, minus the envelope wrapping).
 *
 * Callers that benefit from streaming (search hits, list items) pass
 * `streamField`; everyone else gets the "single trailing object" default
 * for free, which is what the contract should have been from day one.
 */
export interface NdjsonShape {
  /** Top-level field on `data` whose array value should be streamed
   *  one record per line. Missing or non-array → fall back to single-
   *  object emission. */
  streamField?: string;
}

export function emit<T>(
  ctx: OutputContext,
  data: T,
  humanFormat: (data: T, ctx: OutputContext) => string,
  warnings: string[] = [],
  ndjsonShape: NdjsonShape = {},
): void {
  if (ctx.json) {
    const envelope: JsonEnvelope<T> = { ok: true, data, warnings };
    process.stdout.write(JSON.stringify(envelope) + '\n');
    return;
  }
  if (ctx.ndjson) {
    emitNdjson(data, ndjsonShape);
    if (warnings.length > 0 && !ctx.quiet) {
      for (const w of warnings) {
        process.stderr.write(`warning: ${w}\n`);
      }
    }
    return;
  }
  process.stdout.write(humanFormat(data, ctx));
  if (warnings.length > 0 && !ctx.quiet) {
    for (const w of warnings) {
      process.stderr.write(`warning: ${w}\n`);
    }
  }
}

function emitNdjson<T>(data: T, shape: NdjsonShape): void {
  if (Array.isArray(data)) {
    for (const row of data) {
      process.stdout.write(JSON.stringify(row) + '\n');
    }
    return;
  }
  if (
    shape.streamField &&
    data !== null &&
    typeof data === 'object' &&
    Array.isArray((data as Record<string, unknown>)[shape.streamField])
  ) {
    const obj = data as Record<string, unknown>;
    const rows = obj[shape.streamField] as unknown[];
    for (const row of rows) {
      process.stdout.write(JSON.stringify(row) + '\n');
    }
    const meta: Record<string, unknown> = {};
    let hasMeta = false;
    for (const [key, value] of Object.entries(obj)) {
      if (key === shape.streamField) continue;
      meta[key] = value;
      hasMeta = true;
    }
    if (hasMeta) {
      process.stdout.write(JSON.stringify({ __meta: meta }) + '\n');
    }
    return;
  }
  process.stdout.write(JSON.stringify(data) + '\n');
}

export function reportError(ctx: OutputContext, err: unknown): ExitCode {
  // Promote UsageError (parser-level, e.g. unknown-flag rejections from
  // `assertNoExtraFlags`) to a USAGE CliError so consumers see exit code 2
  // instead of the generic RUNTIME (1). Without this, every typo a verb's
  // assertNoExtraFlags catches surfaces as exit 1.
  if (err && typeof err === 'object' && (err as { name?: string }).name === 'UsageError') {
    err = new CliError(ExitCodes.USAGE, (err as Error).message);
  }
  if (err instanceof CliError) {
    if (ctx.json || ctx.ndjson) {
      const envelope: JsonEnvelope<never> = {
        ok: false,
        warnings: [],
        error: {
          code: ErrorCodes[err.exitCode],
          message: err.message,
          ...err.details,
        },
      };
      // Error envelope on stderr: JSON-mode consumers piping `condash X --json`
      // into `jq` should not have failure envelopes interleaved with success
      // data on stdout. The exit code is still the contract; the envelope is
      // just the human-readable side. Match human-mode by routing to stderr.
      process.stderr.write(JSON.stringify(envelope) + '\n');
    } else {
      process.stderr.write(`error: ${err.message}\n`);
      const detailLines = humanDetails(err.details);
      if (detailLines.length > 0) {
        for (const line of detailLines) {
          process.stderr.write(`  ${line}\n`);
        }
      }
    }
    return err.exitCode;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (ctx.json || ctx.ndjson) {
    const envelope: JsonEnvelope<never> = {
      ok: false,
      warnings: [],
      error: { code: 'RUNTIME', message },
    };
    process.stderr.write(JSON.stringify(envelope) + '\n');
  } else {
    process.stderr.write(`error: ${message}\n`);
    if (process.env.CONDASH_CLI_DEBUG && err instanceof Error && err.stack) {
      process.stderr.write(err.stack + '\n');
    }
  }
  return ExitCodes.RUNTIME;
}

function humanDetails(details: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      const head = value
        .slice(0, 5)
        .map((v) => sanitiseForTty(typeof v === 'string' ? v : JSON.stringify(v)))
        .join(', ');
      const more = value.length > 5 ? ` (+${value.length - 5} more)` : '';
      out.push(`${key}: ${head}${more}`);
    } else if (typeof value === 'string') {
      out.push(`${key}: ${sanitiseForTty(value)}`);
    } else {
      out.push(`${key}: ${sanitiseForTty(JSON.stringify(value))}`);
    }
  }
  return out;
}

/** Strip control characters from a string before it lands on a terminal.
 *  An attacker-controlled error detail (e.g. a slug carried straight back
 *  from the user) must not be able to inject ANSI escape sequences,
 *  cursor moves, or alt-screen toggles into the operator's TTY. We keep
 *  newline/tab visible-only by rendering them as escapes so multi-line
 *  payloads don't break the per-detail "key: value" layout either. */
function sanitiseForTty(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (ch === '\n') {
      out += '\\n';
      continue;
    }
    if (ch === '\t') {
      out += '\\t';
      continue;
    }
    if (ch === '\r') {
      out += '\\r';
      continue;
    }
    // Strip C0 controls (0x00-0x1f except handled above) and DEL (0x7f).
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
  }
  return out;
}
