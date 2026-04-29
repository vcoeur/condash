import type { SearchTerm } from '../../shared/types';

/**
 * Parse a free-form search query into ordered terms.
 *
 * - Bare whitespace-separated words → individual `token` terms.
 * - `"double-quoted strings"` → a single `phrase` term that must match
 *   contiguously (used for "force stop" type lookups).
 *
 * The lexer is intentionally minimal — no escape characters, no operators,
 * no field-scoped queries. Anything we add later (`-foo` exclusion,
 * `tag:condash` field scope, …) plugs in here without touching the matcher.
 */
export function parseQuery(query: string): SearchTerm[] {
  const out: SearchTerm[] = [];
  const n = query.length;
  let i = 0;

  const push = (value: string, phrase: boolean): void => {
    if (value.length === 0) return;
    out.push({ value: value.toLowerCase(), phrase, index: out.length });
  };

  while (i < n) {
    const ch = query[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }

    if (ch === '"') {
      i++;
      let buf = '';
      while (i < n && query[i] !== '"') {
        buf += query[i];
        i++;
      }
      if (i < n) i++; // consume the closing quote
      push(buf, true);
      continue;
    }

    let buf = '';
    while (i < n && !/\s/.test(query[i]) && query[i] !== '"') {
      buf += query[i];
      i++;
    }
    push(buf, false);
  }

  return out;
}
