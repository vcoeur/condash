import { Accessor, createEffect, createSignal, onCleanup } from 'solid-js';

/**
 * Debounce a reactive search-input string into a derived query signal.
 *
 * Pulled out of `panes/knowledge.tsx` and `panes/projects.tsx` where
 * the same `let debounceTimer` + `clearTimeout` + `onCleanup` shape
 * lived in both places. Returns the debounced value as a Solid
 * Accessor so it composes with the rest of the reactive graph.
 *
 * @param input  reactive accessor (typically a prop on a pane)
 * @param delay  ms to wait after the last change before publishing.
 *               Default 200 ms — matches the previous hand-rolled value.
 */
export function useSearchDebounce(input: Accessor<string>, delay = 200): Accessor<string> {
  const [query, setQuery] = createSignal(input());
  let timer: ReturnType<typeof setTimeout> | null = null;

  createEffect(() => {
    const value = input();
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => setQuery(value), delay);
  });

  onCleanup(() => {
    if (timer) clearTimeout(timer);
  });

  return query;
}
