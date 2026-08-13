/**
 * Shared description-elision helper for the index regenerator.
 *
 * Replaces the two hard char-cuts (the knowledge `parseHead` cap and the
 * projects clip helper) that truncated at a raw character boundary and landed
 * the ellipsis mid-word or mid-sentence (`so t…`, `….*`). Cut order:
 *
 *  1. Sentence boundary — the last `. ` / `! ` / `? ` (sentence end followed
 *     by a space) at or before the limit. The result is the complete
 *     sentence, with NO ellipsis. Colons are deliberately not sentence ends
 *     (`…up to a state where:` is a fragment, not a complete thought).
 *  2. Word boundary — the last space at or before the limit; the result is
 *     trimmed and terminated with an ellipsis.
 *  3. Hard cut — `max - 1` characters plus an ellipsis (only reachable for a
 *     single unbreakable token).
 *
 * The return value never exceeds `max` characters. `max` must be positive —
 * a non-positive `max` is a programming error and throws.
 */
export function elide(text: string, max: number): string {
  if (max <= 0) {
    throw new Error(`elide: max must be positive, got ${max}`);
  }
  if (text.length <= max) return text;

  // Sentence boundary: last sentence end followed by a space starting within
  // [0, max). `lastIndexOf(sep, max - 1)` searches backward from the limit,
  // so the found index satisfies `i < max` and `slice(0, i + 1)` fits.
  let sentenceEnd = -1;
  for (const sep of ['. ', '! ', '? ']) {
    const i = text.lastIndexOf(sep, max - 1);
    if (i > sentenceEnd) sentenceEnd = i;
  }
  if (sentenceEnd !== -1) return text.slice(0, sentenceEnd + 1).trimEnd();

  // Word boundary: last space within [0, max).
  const wordEnd = text.lastIndexOf(' ', max - 1);
  if (wordEnd !== -1) return text.slice(0, wordEnd).trimEnd() + '…';

  // Hard cut: single token longer than the limit.
  return text.slice(0, max - 1) + '…';
}
