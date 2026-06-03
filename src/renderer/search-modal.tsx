import {
  createEffect,
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
import { Modal } from './modal';
import './search-modal.css';

const EMPTY_RESULTS: SearchResults = { hits: [], terms: [], totalBeforeCap: 0, truncated: false };

/** Minimum query length before hitting the backend. A 1-char query matches
 * nearly everything and produces the worst-case scan for no useful result. */
const MIN_QUERY_LEN = 2;

/** Sources the default "All" filter searches — the four markdown buckets held
 * in the in-memory index. Logs are deliberately excluded: they're ~9/10 of the
 * corpus bytes and aren't indexed, so scanning them is the ~1 s per-query cost
 * the index was built to avoid. Forwarding these scopes (rather than the old
 * `undefined` = "everything") keeps the default search on the ~45 ms index path;
 * logs stay one click away behind the Logs pill, which forwards `['logs']` and
 * triggers the on-demand disk scan. Names match the backend's `wants(source)`
 * (`src/main/search/index.ts`). */
const ALL_SCOPES = ['projects', 'knowledge', 'resources', 'skills'];

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
/** Which source bucket(s) to surface in the result list. `all` shows
 * both — projects (with their notes) and knowledge files. The pill
 * filter sits on the search modal header. The backend doesn't know
 * about the filter; we just hide non-matching buckets in the UI. */
type SourceFilter = 'all' | 'projects' | 'knowledge' | 'resources' | 'skills' | 'logs';

export function SearchModal(props: {
  onClose: () => void;
  onOpenProject: (projectPath: string) => void;
  onOpenFile: (filePath: string) => void;
  /** Optional — when provided, log hits are surfaced as their own row
   * type that, on click, opens the Logs pane and selects that session. */
  onOpenLog?: (logPath: string) => void;
}) {
  const [input, setInput] = createSignal('');
  const [query, setQuery] = createSignal('');
  const [sourceFilter, setSourceFilter] = createSignal<SourceFilter>('all');
  const [selectedIndex, setSelectedIndex] = createSignal<number>(-1);
  let inputEl: HTMLInputElement | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Re-runs whenever the query OR the active source filter changes. The scope
  // is always forwarded to the backend so it scans only what's needed: a
  // specific filter narrows to that one bucket, and the default 'all' narrows to
  // the four indexed markdown sources (ALL_SCOPES) — never the heavy, unindexed
  // logs tree. Logs are searched only when the Logs pill is active. Sub-
  // MIN_QUERY_LEN queries never reach the backend.
  const [results] = createResource(
    () => ({ q: query(), filter: sourceFilter() }),
    async ({ q, filter }) => {
      if (q.trim().length < MIN_QUERY_LEN) return EMPTY_RESULTS;
      const scopes = filter === 'all' ? ALL_SCOPES : [filter];
      return window.condash.search(q, scopes);
    },
  );

  const grouped = createMemo(() => groupHits(results()?.hits ?? []));
  const truncated = createMemo(() => !!results()?.truncated);
  const totalBeforeCap = createMemo(() => results()?.totalBeforeCap ?? 0);

  // Counts shown on the filter pills — derived from the unfiltered
  // groups so each pill always reflects "how many hits I'd see if I
  // picked this filter," even while a different one is selected.
  const projectCount = createMemo(() =>
    grouped().projects.reduce((acc, g) => acc + 1 + g.files.length, 0),
  );
  const knowledgeCount = createMemo(() => grouped().knowledge.length);
  const resourcesCount = createMemo(() => grouped().resources.length);
  const skillsCount = createMemo(() => grouped().skills.length);
  const logsCount = createMemo(() => grouped().logs.length);
  const totalCount = createMemo(
    () => projectCount() + knowledgeCount() + resourcesCount() + skillsCount() + logsCount(),
  );

  const showProjects = (): boolean => sourceFilter() === 'all' || sourceFilter() === 'projects';
  const showKnowledge = (): boolean => sourceFilter() === 'all' || sourceFilter() === 'knowledge';
  const showResources = (): boolean => sourceFilter() === 'all' || sourceFilter() === 'resources';
  const showSkills = (): boolean => sourceFilter() === 'all' || sourceFilter() === 'skills';
  const showLogs = (): boolean => sourceFilter() === 'all' || sourceFilter() === 'logs';

  // Once a specific filter narrows the backend, the other buckets aren't
  // searched, so their counts would read a misleading 0. Show a pill's count
  // only in the 'all' view or on the active pill itself.
  const pillCount = (filter: SourceFilter, count: number): string =>
    sourceFilter() === 'all' || sourceFilter() === filter ? String(count) : '';

  // Long enough to search — below this we keep showing the tips rather than
  // flashing a premature "no matches" while the user is still typing.
  const queryLongEnough = (): boolean => input().trim().length >= MIN_QUERY_LEN;

  // Visible-results count under the active filter — drives the
  // "no matches in this source" empty state.
  const visibleCount = createMemo(() => {
    if (sourceFilter() === 'projects') return projectCount();
    if (sourceFilter() === 'knowledge') return knowledgeCount();
    if (sourceFilter() === 'resources') return resourcesCount();
    if (sourceFilter() === 'skills') return skillsCount();
    if (sourceFilter() === 'logs') return logsCount();
    return totalCount();
  });

  const filterHints = createMemo(() => {
    const current = sourceFilter();
    const hints: { label: string; filter: SourceFilter; count: number }[] = [];
    if (current !== 'projects' && projectCount() > 0)
      hints.push({ label: 'Projects', filter: 'projects', count: projectCount() });
    if (current !== 'knowledge' && knowledgeCount() > 0)
      hints.push({ label: 'Knowledge', filter: 'knowledge', count: knowledgeCount() });
    if (current !== 'resources' && resourcesCount() > 0)
      hints.push({ label: 'Resources', filter: 'resources', count: resourcesCount() });
    if (current !== 'skills' && skillsCount() > 0)
      hints.push({ label: 'Skills', filter: 'skills', count: skillsCount() });
    if (current !== 'logs' && logsCount() > 0)
      hints.push({ label: 'Logs', filter: 'logs', count: logsCount() });
    return hints;
  });

  createEffect(() => {
    const idx = selectedIndex();
    // Track results so the effect re-runs when rows are added/removed.
    results();
    document.querySelectorAll('.search-row').forEach((el, i) => {
      el.toggleAttribute('data-selected', i === idx);
    });
  });

  const changeFilter = (filter: SourceFilter): void => {
    setSelectedIndex(-1);
    setSourceFilter(filter);
  };

  const onInput = (value: string): void => {
    setInput(value);
    setSelectedIndex(-1);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => setQuery(value), 200);
  };

  const handleKeydown = (e: KeyboardEvent): void => {
    // Esc → close and backdrop dismissal are owned by the shared <Modal>
    // shell. This handler covers the search-specific arrow/Enter navigation.
    const rows = document.querySelectorAll('.search-row');
    const totalVisibleResults = rows.length;
    if (totalVisibleResults === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, totalVisibleResults - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter' && selectedIndex() >= 0) {
      e.preventDefault();
      const selected = rows[selectedIndex()] as HTMLElement | undefined;
      selected?.click();
      return;
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
  const openLogAndClose = (path: string): void => {
    if (props.onOpenLog) props.onOpenLog(path);
    props.onClose();
  };

  return (
    <Modal
      class="search-modal"
      ariaLabel="Search"
      backdropClass="search-modal-backdrop"
      headClass="search-modal-head"
      onClose={props.onClose}
      headLeading={
        <input
          ref={(el) => (inputEl = el)}
          class="search-input search-modal-input"
          type="search"
          placeholder='Search projects, knowledge, logs — "phrases" stay together'
          value={input()}
          onInput={(e) => onInput(e.currentTarget.value)}
        />
      }
    >
      <Show when={queryLongEnough()}>
        <div class="search-source-filter" role="radiogroup" aria-label="Filter by source">
          <button
            class="search-source-pill"
            classList={{ active: sourceFilter() === 'all' }}
            role="radio"
            aria-checked={sourceFilter() === 'all'}
            onClick={() => changeFilter('all')}
          >
            All <span class="search-source-count">{pillCount('all', totalCount())}</span>
          </button>
          <button
            class="search-source-pill"
            classList={{ active: sourceFilter() === 'projects' }}
            role="radio"
            aria-checked={sourceFilter() === 'projects'}
            onClick={() => changeFilter('projects')}
          >
            Projects{' '}
            <span class="search-source-count">{pillCount('projects', projectCount())}</span>
          </button>
          <button
            class="search-source-pill"
            classList={{ active: sourceFilter() === 'knowledge' }}
            role="radio"
            aria-checked={sourceFilter() === 'knowledge'}
            onClick={() => changeFilter('knowledge')}
          >
            Knowledge{' '}
            <span class="search-source-count">{pillCount('knowledge', knowledgeCount())}</span>
          </button>
          <button
            class="search-source-pill"
            classList={{ active: sourceFilter() === 'resources' }}
            role="radio"
            aria-checked={sourceFilter() === 'resources'}
            onClick={() => changeFilter('resources')}
          >
            Resources{' '}
            <span class="search-source-count">{pillCount('resources', resourcesCount())}</span>
          </button>
          <button
            class="search-source-pill"
            classList={{ active: sourceFilter() === 'skills' }}
            role="radio"
            aria-checked={sourceFilter() === 'skills'}
            onClick={() => changeFilter('skills')}
          >
            Skills <span class="search-source-count">{pillCount('skills', skillsCount())}</span>
          </button>
          <button
            class="search-source-pill"
            classList={{ active: sourceFilter() === 'logs' }}
            role="radio"
            aria-checked={sourceFilter() === 'logs'}
            onClick={() => changeFilter('logs')}
          >
            {/* Logs aren't scanned in the 'all' view (ALL_SCOPES excludes
                  them), so unlike the other pills their count is only known —
                  and shown — when the Logs filter is the active one. */}
            Logs{' '}
            <span class="search-source-count">
              {sourceFilter() === 'logs' ? String(logsCount()) : ''}
            </span>
          </button>
        </div>
      </Show>
      <div class="search-modal-body">
        <Show when={queryLongEnough()} fallback={<SearchTips />}>
          <Suspense fallback={<div class="empty">Searching…</div>}>
            <Show
              when={visibleCount() > 0}
              fallback={
                <div class="empty">
                  {grouped().total === 0 ? 'No matches.' : `No matches in ${sourceFilter()}.`}
                  <Show when={grouped().total > 0 && sourceFilter() !== 'all'}>
                    <div class="search-source-hints">
                      Also found in{' '}
                      <For each={filterHints()}>
                        {(hint, i) => (
                          <span class="search-source-hint-item">
                            <Show when={i() > 0}>, </Show>
                            <button
                              class="search-source-hint-link"
                              onClick={() => changeFilter(hint.filter)}
                            >
                              {hint.label} ({hint.count})
                            </button>
                          </span>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              }
            >
              <ul class="search-results search-results-grouped">
                <Show when={showProjects()}>
                  <For each={grouped().projects}>
                    {(g) => (
                      <ProjectGroupRow
                        group={g}
                        onOpenProject={openProjectAndClose}
                        onOpenFile={openFileAndClose}
                      />
                    )}
                  </For>
                </Show>
                <Show when={showKnowledge()}>
                  <For each={grouped().knowledge}>
                    {(hit) => <FileResultRow hit={hit} onOpen={openFileAndClose} />}
                  </For>
                </Show>
                <Show when={showResources()}>
                  <For each={grouped().resources}>
                    {(hit) => <FileResultRow hit={hit} onOpen={openFileAndClose} />}
                  </For>
                </Show>
                <Show when={showSkills()}>
                  <For each={grouped().skills}>
                    {(hit) => <FileResultRow hit={hit} onOpen={openFileAndClose} />}
                  </For>
                </Show>
                <Show when={showLogs()}>
                  <For each={grouped().logs}>
                    {(hit) => <LogResultRow hit={hit} onOpen={openLogAndClose} />}
                  </For>
                </Show>
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
    </Modal>
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

/** Log hit row — title is derived from the rel-path so a session shows
 * as `YYYY-MM-DD HH:MM:SS` instead of a meaningless first line of the
 * transcript. Activating it sends an open-log request the Logs pane
 * reacts to. */
function LogResultRow(props: { hit: SearchHit; onOpen: (path: string) => void }) {
  const niceTitle = (): string => {
    // relPath: `.condash/logs/YYYY/MM/DD/HHMMSS-<sid>.txt(.gz)`
    const m = /\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})(\d{2})(\d{2})-/.exec(props.hit.relPath);
    if (!m) return props.hit.title;
    const [, y, mo, d, hh, mm, ss] = m;
    return `${y}-${mo}-${d} ${hh}:${mm}:${ss}`;
  };
  return (
    <li class="search-result">
      <button class="search-row" onClick={() => props.onOpen(props.hit.path)}>
        <div class="search-head">
          <span class="search-title">{niceTitle()}</span>
          <span class="badge">log</span>
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
          Terminal logs aren't in the default results — pick the <strong>Logs</strong> filter to
          search transcripts.
        </li>
        <li>
          Hits are ranked: title &gt; meta &gt; headings &gt; body, with a bonus when terms appear
          close together.
        </li>
      </ul>
    </div>
  );
}
