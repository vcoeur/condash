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
 * Emit a successful result. In `--json` mode wraps `data` in the envelope;
 * in `--ndjson` mode `data` must be an array and one line is emitted per
 * element (warnings are written to stderr); otherwise calls the human
 * formatter.
 */
export function emit<T>(
  ctx: OutputContext,
  data: T,
  humanFormat: (data: T, ctx: OutputContext) => string,
  warnings: string[] = [],
): void {
  if (ctx.json) {
    const envelope: JsonEnvelope<T> = { ok: true, data, warnings };
    process.stdout.write(JSON.stringify(envelope) + '\n');
    return;
  }
  if (ctx.ndjson) {
    if (!Array.isArray(data)) {
      throw new CliError(
        ExitCodes.RUNTIME,
        '--ndjson requested but command produced a non-array result',
      );
    }
    for (const row of data) {
      process.stdout.write(JSON.stringify(row) + '\n');
    }
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

/**
 * Write a single record on a streaming path (`--ndjson`). The dispatcher
 * holds onto exit-code policy; this just lays a JSON line on stdout.
 */
export function emitNdjsonRecord(record: unknown): void {
  process.stdout.write(JSON.stringify(record) + '\n');
}

export function reportError(ctx: OutputContext, err: unknown): ExitCode {
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
      process.stdout.write(JSON.stringify(envelope) + '\n');
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
    process.stdout.write(JSON.stringify(envelope) + '\n');
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
        .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
        .join(', ');
      const more = value.length > 5 ? ` (+${value.length - 5} more)` : '';
      out.push(`${key}: ${head}${more}`);
    } else if (typeof value === 'string') {
      out.push(`${key}: ${value}`);
    } else {
      out.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  return out;
}
