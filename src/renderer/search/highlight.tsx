import { For } from 'solid-js';
import type { SearchHighlight } from '@shared/types';

/** Number of distinct highlight colours. Token index modulo this number
 * picks a colour, so up to N tokens get unique mark colours; further tokens
 * cycle. Keep in sync with the `.search-mark-{i}` rules in styles.css. */
const HIGHLIGHT_COLOURS = 4;

/**
 * Render `text` with each `<mark>` covering one match. Multiple tokens get
 * distinct colours via `search-mark-{tokenIndex % HIGHLIGHT_COLOURS}` —
 * scanning a snippet, the user can see which words landed where.
 *
 * Match overlaps are resolved by skipping the later match (matches arrive
 * already sorted by `start`).
 */
export function HighlightedText(props: {
  text: string;
  matches: readonly SearchHighlight[];
  /** Optional class added to every `<mark>` — used by the path-line highlight
   * to dim the colour vs. body snippets. */
  markClass?: string;
}) {
  const segments = (): { text: string; tokenIndex?: number }[] => {
    const text = props.text;
    const matches = [...props.matches].sort((a, b) => a.start - b.start);
    const out: { text: string; tokenIndex?: number }[] = [];
    let cursor = 0;
    for (const m of matches) {
      if (m.start < cursor) continue;
      if (m.start > cursor) out.push({ text: text.slice(cursor, m.start) });
      out.push({
        text: text.slice(m.start, m.start + m.length),
        tokenIndex: m.tokenIndex,
      });
      cursor = m.start + m.length;
    }
    if (cursor < text.length) out.push({ text: text.slice(cursor) });
    return out;
  };

  return (
    <For each={segments()}>
      {(seg) =>
        seg.tokenIndex !== undefined ? (
          <mark
            class={`search-mark search-mark-${seg.tokenIndex % HIGHLIGHT_COLOURS}${
              props.markClass ? ` ${props.markClass}` : ''
            }`}
          >
            {seg.text}
          </mark>
        ) : (
          <span>{seg.text}</span>
        )
      }
    </For>
  );
}
