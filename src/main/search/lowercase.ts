/**
 * Lowercase `s` while guaranteeing the result has exactly the same length
 * (in UTF-16 code units) as the input.
 *
 * A handful of code points grow under `toLowerCase()` — e.g. U+0130 LATIN
 * CAPITAL LETTER I WITH DOT ABOVE lowers to "i" + U+0307 (1 → 2 code units).
 * The matcher computes occurrence offsets on the lowered string and then uses
 * them to index into the raw string (region lookup, snippet windows), so any
 * length drift desyncs every offset after the offending character.
 *
 * Fast path: a single `toLowerCase()` (the overwhelmingly common case). Only
 * when the lengths diverge do we re-lower per code point, keeping any
 * length-changing mapping as the original character — that character simply
 * won't match a lowercased query term, which is a far smaller cost than
 * corrupting every downstream offset.
 */
export function toLowerCaseSameLength(s: string): string {
  const lowered = s.toLowerCase();
  if (lowered.length === s.length) return lowered;
  let out = '';
  for (const ch of s) {
    const low = ch.toLowerCase();
    out += low.length === ch.length ? low : ch;
  }
  return out;
}
