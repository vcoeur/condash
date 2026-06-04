/**
 * Dotted-path addressing of plain JSON objects — `terminal.logging.enabled`,
 * `repos[0].path`. Pure and renderer-safe (no Node imports), so the Settings
 * modal can reuse the same key grammar the `condash config get/set` CLI uses.
 */

/**
 * Read the value at a dotted path. Supports a trailing `[n]` array index on
 * any segment (`repos[0]`). Returns `undefined` when any segment is missing,
 * when traversal hits a non-object, or when an array index is applied to a
 * non-array.
 *
 * @param obj the root value to traverse
 * @param dotted the path, e.g. `terminal.logging.enabled` or `repos[0].path`
 */
export function pickByDottedPath(obj: unknown, dotted: string): unknown {
  const parts = dotted.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    const arrayMatch = part.match(/^([^[]+)\[(\d+)\]$/);
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

/**
 * Set the value at a dotted path, mutating `obj` in place. Intermediate
 * segments that are missing or not plain objects are replaced with fresh
 * objects so the path materialises. Array-index segments are not synthesised
 * (the get path tolerates them, but `set` only writes plain-object keys).
 *
 * @param obj the root object to mutate
 * @param dotted the path, e.g. `audit.thresholds.binary`
 * @param value the value to assign at the leaf
 */
export function setByDottedPath(
  obj: Record<string, unknown>,
  dotted: string,
  value: unknown,
): void {
  const parts = dotted.split('.');
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const next = cursor[part];
    if (next === undefined || next === null || typeof next !== 'object' || Array.isArray(next)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
}
