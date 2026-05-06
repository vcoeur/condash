import { readSettings } from '../settings';

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
  const { conceptionPath } = await readSettings();
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
  const { conceptionPath } = await readSettings();
  if (!conceptionPath) throw new Error('No conception path set');
  return handler(conceptionPath);
}
