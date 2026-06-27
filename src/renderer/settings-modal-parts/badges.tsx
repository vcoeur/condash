/**
 * Stable deep-equality used by the Settings modal's per-section unsaved-changes
 * pip. (This file once held the inheritance-badge vocabulary; that whole model
 * was removed when every setting was given exactly one home — see the
 * scope-partition revamp. Only the equality helper remains.)
 */

/** Stable JSON-based deep equality. Object keys are sorted recursively so
 *  the same logical shape always serialises identically. */
export function stableEqual(a: unknown, b: unknown): boolean {
  return canonicalise(a) === canonicalise(b);
}

function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalise).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(',')}}`;
}
