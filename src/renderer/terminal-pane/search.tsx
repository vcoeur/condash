import { type Accessor, createSignal, type JSX, Show } from 'solid-js';
import type { SearchAddon } from '@xterm/addon-search';

export interface SearchControllerDeps {
  /** Look up the search addon for the currently-active terminal handle.
   *  Returns null when no tab is focused or the handle is gone. */
  getActiveSearch: () => SearchAddon | null;
  /** Re-fit + focus the active xterm after closing the bar. */
  focusActive: () => void;
}

export interface SearchController {
  searchOpen: Accessor<boolean>;
  /** Open the search bar and focus the input. */
  openSearch: () => void;
  /** Close + clear the bar; restores focus to the active xterm. */
  closeSearch: () => void;
  /** Run the next/previous match against the current query. */
  runSearch: (direction: 'next' | 'prev') => void;
  /** Render the search bar UI (already wrapped in `<Show>` against
   *  `searchOpen`). */
  SearchBar: () => JSX.Element;
}

/** In-pane Ctrl+F search across the active terminal's visible buffer
 *  (xterm `addon-search`). Per the non-goals revision: this is **output
 *  search inside the live session**, not shell-history text search. */
export function createSearchController(deps: SearchControllerDeps): SearchController {
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal('');
  let inputRef: HTMLInputElement | undefined;

  const openSearch = (): void => {
    setSearchOpen(true);
    queueMicrotask(() => inputRef?.focus());
  };

  const closeSearch = (): void => {
    setSearchOpen(false);
    setSearchQuery('');
    queueMicrotask(deps.focusActive);
  };

  const runSearch = (direction: 'next' | 'prev'): void => {
    const search = deps.getActiveSearch();
    if (!search) return;
    const q = searchQuery();
    if (!q) return;
    if (direction === 'next') search.findNext(q);
    else search.findPrevious(q);
  };

  const SearchBar = () => (
    <Show when={searchOpen()}>
      <div class="terminal-search-bar">
        <input
          ref={(el) => (inputRef = el)}
          class="terminal-search-input"
          type="text"
          placeholder="Find in buffer…"
          value={searchQuery()}
          onInput={(e) => setSearchQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              closeSearch();
            } else if (e.key === 'Enter') {
              e.preventDefault();
              runSearch(e.shiftKey ? 'prev' : 'next');
            }
            e.stopPropagation();
          }}
        />
        <button
          class="terminal-search-action"
          onClick={() => runSearch('prev')}
          title="Previous match (Shift+Enter)"
          aria-label="Previous match"
        >
          ↑
        </button>
        <button
          class="terminal-search-action"
          onClick={() => runSearch('next')}
          title="Next match (Enter)"
          aria-label="Next match"
        >
          ↓
        </button>
        <button
          class="terminal-search-action"
          onClick={closeSearch}
          title="Close (Esc)"
          aria-label="Close find"
        >
          ×
        </button>
      </div>
    </Show>
  );

  return { searchOpen, openSearch, closeSearch, runSearch, SearchBar };
}
