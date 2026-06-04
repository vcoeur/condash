import { readSettings } from '../settings';

/**
 * Shared decoders for renderer-supplied IPC arguments.
 *
 * The renderer is trusted by convention (it's our own SPA behind the
 * `window.condash` bridge), but each handler still defends in depth against a
 * compromised renderer or a wrong call. These replace the per-handler inline
 * guards (`if (typeof x !== 'string' …) throw`) so the trust boundary is
 * uniform and the duplicated literal error strings collapse to one shape:
 * `<channel>: <what was expected>`.
 */

/** Require a non-empty string, e.g. a path/target argument. */
export function requireNonEmptyString(channel: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${channel}: expected a non-empty string`);
  }
  return value;
}

/** Require a boolean argument. */
export function requireBoolean(channel: string, value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${channel}: expected a boolean`);
  }
  return value;
}

/** Require an array of strings, dropping nothing (the handler sanitises). */
export function requireStringArray(channel: string, value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${channel}: expected an array of strings`);
  }
  return value as string[];
}

/**
 * Require the value be one of `allowed`. Returns it narrowed to that union.
 * Used for the small string-enum arguments (theme, skill scope, …).
 */
export function requireEnum<T extends string>(
  channel: string,
  value: unknown,
  allowed: ReadonlySet<T>,
): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) {
    throw new Error(`${channel}: expected one of ${[...allowed].join(' | ')}`);
  }
  return value as T;
}

/**
 * Resolve the active conception path and call `handler` with it. Returns
 * `fallback` when no conception is set. Centralises the
 * `if (!conceptionPath) return …` boilerplate that every conception-scoped
 * handler used to repeat inline.
 */
export async function withConception<T>(
  handler: (conceptionPath: string) => Promise<T> | T,
  fallback: T,
): Promise<T> {
  const { lastConceptionPath: conceptionPath } = await readSettings();
  if (!conceptionPath) return fallback;
  return handler(conceptionPath);
}

/**
 * Same as `withConception` but throws when no conception is set, for handlers
 * that *require* one (e.g. forceStopRepo). The thrown message is the same
 * inline literal those handlers used before the extraction.
 */
export async function requireConception<T>(
  handler: (conceptionPath: string) => Promise<T> | T,
): Promise<T> {
  const { lastConceptionPath: conceptionPath } = await readSettings();
  if (!conceptionPath) throw new Error('No conception path set');
  return handler(conceptionPath);
}
