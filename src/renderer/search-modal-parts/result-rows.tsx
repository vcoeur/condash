// Presentational result-list rows for the search modal (invariant 12). These
// live as module-level siblings (not inline in SearchModal) so Solid sees
// stable component references — declaring them inside the modal re-creates the
// function identity on every render and trips reactive tracking. `SearchModal`
// (search-modal.tsx) owns the shell/state; these render the grouped hits.

import { For, Show, type JSX } from 'solid-js';
import type { SearchHighlight, SearchHit, SearchSnippet } from '@shared/types';
import { HighlightedText } from '../search/highlight';
import { KnowledgeIcon, LogsIcon, ProjectsIcon, ResourcesIcon, SkillsIcon } from '../icons';
import type { ProjectGroup } from '../search/grouping';

const SOURCE_ICON: Record<string, () => JSX.Element> = {
  project: ProjectsIcon,
  knowledge: KnowledgeIcon,
  resources: ResourcesIcon,
  skills: SkillsIcon,
  logs: LogsIcon,
};

const SOURCE_COLOR: Record<string, string> = {
  project: 'var(--kind-project)',
  knowledge: 'var(--col-later)',
  resources: 'var(--col-soon)',
  skills: 'var(--col-review)',
  logs: 'var(--text-muted)',
};

/** Leading source icon for a result row. */
function RowIcon(props: { source: string }) {
  const Icon = SOURCE_ICON[props.source] ?? (() => null);
  return (
    <span
      class="search-row-icon"
      style={{ '--source-color': SOURCE_COLOR[props.source] ?? 'var(--text-muted)' }}
    >
      <Icon />
    </span>
  );
}

/** A project card: the project header row (opens the project popup) plus its
 *  matching in-project files (notes, nested READMEs) as sub-rows. */
export function ProjectGroupRow(props: {
  group: ProjectGroup;
  onOpenProject: (projectPath: string) => void;
  onOpenFile: (filePath: string) => void;
}) {
  const headerTitle = (): string => {
    if (props.group.header) return props.group.header.title;
    if (props.group.projectTitle) return props.group.projectTitle;
    const leaf = props.group.projectPath.split('/').pop();
    return leaf ?? props.group.projectPath;
  };

  return (
    <li class="search-result search-project-group">
      <button
        class="search-row search-project-header"
        onClick={() => props.onOpenProject(props.group.projectPath)}
      >
        <div class="search-row-main">
          <RowIcon source="project" />
          <div class="search-row-content">
            <div class="search-head">
              <span class="search-title">{headerTitle()}</span>
              <span class="search-count">{props.group.totalScore}</span>
            </div>
            <ResultPath
              relPath={props.group.projectPath}
              pathMatches={props.group.header?.pathMatches}
            />
            <Show when={props.group.header && props.group.header.snippets.length > 0}>
              <SnippetList snippets={props.group.header!.snippets} />
            </Show>
          </div>
        </div>
        <span class="search-row-hint">Open project</span>
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
                  <div class="search-row-main">
                    <div class="search-row-content">
                      <div class="search-head">
                        <span class="search-title search-file-title">
                          {relativeToProject(file.relPath, props.group.projectPath)}
                        </span>
                        <span class="search-count">{file.score}</span>
                      </div>
                      <SnippetList snippets={file.snippets} />
                    </div>
                  </div>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </li>
  );
}

/** A single non-project file hit (knowledge / resources / skills). */
export function FileResultRow(props: { hit: SearchHit; onOpen: (path: string) => void }) {
  return (
    <li class="search-result">
      <button class="search-row" onClick={() => props.onOpen(props.hit.path)}>
        <div class="search-row-main">
          <RowIcon source={props.hit.source} />
          <div class="search-row-content">
            <div class="search-head">
              <span class="search-title">{props.hit.title}</span>
              <span class="search-count">{props.hit.score}</span>
            </div>
            <ResultPath relPath={props.hit.relPath} pathMatches={props.hit.pathMatches} />
            <SnippetList snippets={props.hit.snippets} />
          </div>
        </div>
      </button>
    </li>
  );
}

/** Log hit row — title is derived from the rel-path so a session shows
 * as `YYYY-MM-DD HH:MM:SS` instead of a meaningless first line of the
 * transcript. Activating it sends an open-log request the Logs pane
 * reacts to. */
export function LogResultRow(props: { hit: SearchHit; onOpen: (path: string) => void }) {
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
        <div class="search-row-main">
          <RowIcon source="logs" />
          <div class="search-row-content">
            <div class="search-head">
              <span class="search-title">{niceTitle()}</span>
              <span class="search-count">{props.hit.score}</span>
            </div>
            <ResultPath relPath={props.hit.relPath} pathMatches={props.hit.pathMatches} />
            <SnippetList snippets={props.hit.snippets} />
          </div>
        </div>
      </button>
    </li>
  );
}

/** The per-hit snippet list, region-tagged (meta / title / heading). */
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

/** The rel-path line under a hit's title, with any path-match segments dimmed. */
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

/** Strip the project prefix off an in-project file path so the file sub-row
 *  reads as a path relative to its project. */
function relativeToProject(relPath: string, projectAbsPath: string): string {
  const slug = projectAbsPath.split('/').pop();
  if (!slug) return relPath;
  const idx = relPath.indexOf(`/${slug}/`);
  if (idx === -1) return relPath;
  return relPath.slice(idx + slug.length + 2);
}
