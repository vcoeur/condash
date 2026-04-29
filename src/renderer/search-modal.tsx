import {
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  Suspense,
} from 'solid-js';
import type { SearchHighlight, SearchHit, SearchResults, SearchSnippet } from '@shared/types';
import { HighlightedText } from './search/highlight';
import { groupHits, type ProjectGroup } from './search/grouping';

const EMPTY_RESULTS: SearchResults = { hits: [], terms: [], totalBeforeCap: 0, truncated: false };

/**
 * Modal-shell around the search backend. Top-anchored (command-palette
 * feel) — expands downward as results arrive.
 *
 * Heavy lifting lives elsewhere:
 * - `search/highlight.tsx` — multi-token `<mark>` segmenter.
 * - `search/grouping.ts` — collapse project-side hits into per-project cards.
 *
 * This file owns shell behaviour (input state, debounce, keyboard, layout).
 * Row components live as siblings below so Solid sees them as stable
 * references (declaring them inside SearchModal means each render call
 * re-creates the function identity, which trips Solid's reactive tracking).
 */
export function SearchModal(props: {
  onClose: () => void;
  onOpenProject: (projectPath: string) => void;
  onOpenFile: (filePath: string) => void;
}) {
  const [input, setInput] = createSignal('');
  const [query, setQuery] = createSignal('');
  let inputEl: HTMLInputElement | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const [results] = createResource<SearchResults, string>(query, async (q) => {
    if (q.trim().length === 0) return EMPTY_RESULTS;
    return window.condash.search(q);
  });

  const grouped = createMemo(() => groupHits(results()?.hits ?? []));
  const truncated = createMemo(() => !!results()?.truncated);
  const totalBeforeCap = createMemo(() => results()?.totalBeforeCap ?? 0);

  const onInput = (value: string): void => {
    setInput(value);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => setQuery(value), 200);
  };

  const handleKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      props.onClose();
    }
  };

  onMount(() => {
    document.addEventListener('keydown', handleKeydown, true);
    queueMicrotask(() => inputEl?.focus());
  });
  onCleanup(() => {
    document.removeEventListener('keydown', handleKeydown, true);
    if (debounceTimer) clearTimeout(debounceTimer);
  });

  const openProjectAndClose = (path: string): void => {
    props.onOpenProject(path);
    props.onClose();
  };
  const openFileAndClose = (path: string): void => {
    props.onOpenFile(path);
    props.onClose();
  };

  return (
    <div class="modal-backdrop search-modal-backdrop" onClick={props.onClose}>
      <div
        class="modal search-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onClick={(e) => e.stopPropagation()}
      >
        <header class="modal-head search-modal-head">
          <input
            ref={(el) => (inputEl = el)}
            class="search-input search-modal-input"
            type="search"
            placeholder='Search projects + knowledge — "phrases" stay together'
            value={input()}
            onInput={(e) => onInput(e.currentTarget.value)}
          />
          <button
            class="modal-button"
            onClick={props.onClose}
            title="Close (Esc)"
            aria-label="Close"
          >
            ×
          </button>
        </header>
        <div class="search-modal-body">
          <Show when={input().trim().length > 0} fallback={<SearchTips />}>
            <Suspense fallback={<div class="empty">Searching…</div>}>
              <Show when={grouped().total > 0} fallback={<div class="empty">No matches.</div>}>
                <ul class="search-results search-results-grouped">
                  <For each={grouped().projects}>
                    {(g) => (
                      <ProjectGroupRow
                        group={g}
                        onOpenProject={openProjectAndClose}
                        onOpenFile={openFileAndClose}
                      />
                    )}
                  </For>
                  <For each={grouped().knowledge}>
                    {(hit) => <FileResultRow hit={hit} onOpen={openFileAndClose} />}
                  </For>
                </ul>
                <Show when={truncated()}>
                  <div class="search-truncated-hint">
                    Showing top 100 of {totalBeforeCap()} matches — refine the query for more.
                  </div>
                </Show>
              </Show>
            </Suspense>
          </Show>
        </div>
      </div>
    </div>
  );
}

function ProjectGroupRow(props: {
  group: ProjectGroup;
  onOpenProject: (projectPath: string) => void;
  onOpenFile: (filePath: string) => void;
}) {
  const headerTitle = (): string => {
    if (props.group.header) return props.group.header.title;
    const leaf = props.group.projectPath.split('/').pop();
    return leaf ?? props.group.projectPath;
  };

  return (
    <li class="search-result search-project-group">
      <button
        class="search-row search-project-header"
        onClick={() => props.onOpenProject(props.group.projectPath)}
      >
        <div class="search-head">
          <span class="search-title">{headerTitle()}</span>
          <span class="badge badge-project">project</span>
          <span class="search-count">{props.group.totalScore}</span>
        </div>
        <ResultPath
          relPath={props.group.projectPath}
          pathMatches={props.group.header?.pathMatches}
        />
        <Show when={props.group.header && props.group.header.snippets.length > 0}>
          <SnippetList snippets={props.group.header!.snippets} />
        </Show>
        <span class="search-row-hint">Click to open the project popup ↗</span>
      </button>
      <Show when={props.group.files.length > 0}>
        <ul class="search-project-files">
          <For each={props.group.files}>
            {(file) => (
              <li>
                <button
                  class="search-row search-file-row"
                  onClick={() => props.onOpenFile(file.path)}
                >
                  <div class="search-head">
                    <span class="search-title search-file-title">
                      {relativeToProject(file.relPath, props.group.projectPath)}
                    </span>
                    <span class="search-count">{file.score}</span>
                  </div>
                  <SnippetList snippets={file.snippets} />
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </li>
  );
}

function FileResultRow(props: { hit: SearchHit; onOpen: (path: string) => void }) {
  return (
    <li class="search-result">
      <button class="search-row" onClick={() => props.onOpen(props.hit.path)}>
        <div class="search-head">
          <span class="search-title">{props.hit.title}</span>
          <span class="badge">{props.hit.source}</span>
          <span class="search-count">{props.hit.score}</span>
        </div>
        <ResultPath relPath={props.hit.relPath} pathMatches={props.hit.pathMatches} />
        <SnippetList snippets={props.hit.snippets} />
      </button>
    </li>
  );
}

function SnippetList(props: { snippets: readonly SearchSnippet[] }) {
  return (
    <ul class="search-snippets">
      <For each={props.snippets}>
        {(s) => (
          <li
            classList={{
              'snippet-meta': s.region === 'meta',
              'snippet-h1': s.region === 'h1',
            }}
          >
            <Show when={s.region === 'meta'}>
              <span class="snippet-region-tag">meta</span>
            </Show>
            <Show when={s.region === 'h1'}>
              <span class="snippet-region-tag">title</span>
            </Show>
            <Show when={s.region === 'heading'}>
              <span class="snippet-region-tag">heading</span>
            </Show>
            <HighlightedText text={s.text} matches={s.matches} />
          </li>
        )}
      </For>
    </ul>
  );
}

function ResultPath(props: { relPath: string; pathMatches?: readonly SearchHighlight[] }) {
  const hasMatches = (): boolean => !!props.pathMatches && props.pathMatches.length > 0;
  return (
    <span class="search-path">
      <Show when={hasMatches()} fallback={props.relPath}>
        <HighlightedText text={props.relPath} matches={props.pathMatches!} markClass="dim" />
      </Show>
    </span>
  );
}

function relativeToProject(relPath: string, projectAbsPath: string): string {
  const slug = projectAbsPath.split('/').pop();
  if (!slug) return relPath;
  const idx = relPath.indexOf(`/${slug}/`);
  if (idx === -1) return relPath;
  return relPath.slice(idx + slug.length + 2);
}

function SearchTips() {
  return (
    <div class="search-tips">
      <h4>Tips</h4>
      <ul>
        <li>
          Multiple words act as <strong>AND</strong> — files must contain every word.
        </li>
        <li>
          Quote a phrase to keep words together: <code>"force stop"</code>.
        </li>
        <li>
          Searches READMEs <strong>and</strong> their <code>notes/</code> files. Slugs / paths match
          too — try a date prefix.
        </li>
        <li>Click a project header to open its popup; click a file to open it directly.</li>
        <li>
          Hits are ranked: title &gt; meta &gt; headings &gt; body, with a bonus when terms appear
          close together.
        </li>
      </ul>
    </div>
  );
}
