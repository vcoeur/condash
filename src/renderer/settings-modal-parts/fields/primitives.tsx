import { createContext, createMemo, createSignal, Show, useContext } from 'solid-js';
import type { JSX } from 'solid-js';
import { Caret } from '../../icons';

// --- Search context ---------------------------------------------------

interface SearchContextValue {
  /** Active query (already trimmed externally). Empty string = no filter. */
  query: () => string;
  /** Returns true when the haystack matches the active query OR when the
   *  query is empty. Case-insensitive substring match. */
  hasMatch: (haystack: string) => boolean;
}

const FALLBACK_SEARCH: SearchContextValue = {
  query: () => '',
  hasMatch: () => true,
};

const SearchContext = createContext<SearchContextValue>(FALLBACK_SEARCH);

/** Hook for descendants that want to filter their own rendering on the
 *  active query. Returns the noop context when no provider is mounted, so
 *  components can be reused outside the Settings modal. */
export function useSearch(): SearchContextValue {
  return useContext(SearchContext);
}

/** Mounts the search context. The modal owns the query signal and wraps
 *  every section in this provider. */
export function SearchProvider(props: { query: () => string; children: JSX.Element }): JSX.Element {
  const value: SearchContextValue = {
    query: props.query,
    hasMatch: (haystack) => {
      const q = props.query().trim().toLowerCase();
      if (!q) return true;
      return haystack.toLowerCase().includes(q);
    },
  };
  return <SearchContext.Provider value={value}>{props.children}</SearchContext.Provider>;
}

// --- Subgroup (collapsible) ------------------------------------------

const SUBGROUP_OPEN_KEY = 'condash:settings-modal:subgroup-open';

function readSubgroupOpen(id: string, defaultOpen: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(SUBGROUP_OPEN_KEY);
    if (!raw) return defaultOpen;
    const map = JSON.parse(raw) as Record<string, boolean>;
    return typeof map[id] === 'boolean' ? map[id] : defaultOpen;
  } catch {
    return defaultOpen;
  }
}

function writeSubgroupOpen(id: string, open: boolean): void {
  try {
    const raw = window.localStorage.getItem(SUBGROUP_OPEN_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    map[id] = open;
    window.localStorage.setItem(SUBGROUP_OPEN_KEY, JSON.stringify(map));
  } catch {
    // Private-mode browsers throw on localStorage writes; the subgroup
    // simply forgets its open state across reloads — acceptable.
  }
}

/** Collapsible subgroup with a `<h3>` heading. Participates in search:
 *  when the active query matches neither the title nor `keywords`, the
 *  subgroup hides entirely. When a query is active and the subgroup
 *  matches, it force-opens so the user can see what matched without an
 *  extra click. */
export function Subgroup(props: {
  id: string;
  title: string;
  /** Extra match text (label and hint strings from descendants). When
   *  omitted, only the title participates in search matching. */
  keywords?: string;
  defaultOpen?: boolean;
  children: JSX.Element;
}): JSX.Element {
  const search = useSearch();
  const matchesSearch = createMemo(() => search.hasMatch(`${props.title} ${props.keywords ?? ''}`));
  const [userOpen, setUserOpen] = createSignal(
    readSubgroupOpen(props.id, props.defaultOpen ?? false),
  );
  const open = createMemo(() => (search.query().trim().length > 0 ? matchesSearch() : userOpen()));
  return (
    <Show when={matchesSearch()}>
      <details
        class="settings-subgroup"
        open={open()}
        data-subgroup-id={props.id}
        onToggle={(e) => {
          if (search.query().trim().length > 0) return;
          const isOpen = e.currentTarget.open;
          setUserOpen(isOpen);
          writeSubgroupOpen(props.id, isOpen);
        }}
      >
        <summary class="settings-subgroup-summary">
          <Caret expanded={open()} />
          <h3>{props.title}</h3>
        </summary>
        <div class="settings-subgroup-body">{props.children}</div>
      </details>
    </Show>
  );
}

/** Labelled control row with an optional `[abs]`/`[rel]` path chip. */
export function LabeledField(props: {
  label: string;
  hint?: string;
  /** Path-scope tag: 'abs' shows an [abs] chip, 'rel' shows [rel]. Omit
   *  for non-path fields. */
  pathScope?: 'abs' | 'rel';
  children: JSX.Element;
}): JSX.Element {
  return (
    <label class="settings-field-with-badge">
      <span class="settings-field-row">
        <span class="settings-field-label">
          {props.label}
          <Show when={props.pathScope}>
            {(scope) => (
              <span
                class="settings-path-chip"
                classList={{ 'settings-path-chip--rel': scope() === 'rel' }}
                title={scope() === 'abs' ? 'Absolute path' : 'Relative to conception root'}
              >
                {scope()}
              </span>
            )}
          </Show>
        </span>
      </span>
      {props.children}
      <Show when={props.hint}>
        <span class="settings-field-hint">{props.hint}</span>
      </Show>
    </label>
  );
}
