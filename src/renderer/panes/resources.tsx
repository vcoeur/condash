import { createMemo, createSignal, For, Show } from 'solid-js';
import type { ResourceCategory, ResourceNode } from '@shared/types';
import { filterByQuery } from '../filter-by-query';
import './resources-pane.css';

interface FlatSection {
  /** Empty string for the root section. */
  id: string;
  label: string;
  files: ResourceNode[];
}

/**
 * Walk the resources tree and emit one section per directory (root +
 * every nested directory). Recurses to any depth — sections with no files
 * are dropped so an empty wrapper directory doesn't render an empty
 * section header.
 */
function buildSections(root: ResourceNode | null): FlatSection[] {
  if (!root) return [];
  const sections = new Map<string, ResourceNode[]>();

  const visit = (node: ResourceNode, dirRel: string): void => {
    if (node.kind !== 'directory') return;
    const fileChildren: ResourceNode[] = [];
    const dirChildren: ResourceNode[] = [];
    for (const child of node.children ?? []) {
      if (child.kind === 'directory') dirChildren.push(child);
      else fileChildren.push(child);
    }
    if (fileChildren.length > 0) {
      sections.set(dirRel, fileChildren);
    }
    for (const sub of dirChildren) {
      const childRel = dirRel ? `${dirRel}/${sub.name}` : sub.name;
      visit(sub, childRel);
    }
  };
  visit(root, '');

  const out: FlatSection[] = [];
  for (const [id, files] of sections) {
    const label = id === '' ? 'ROOT' : id.split('/').join(' · ').toUpperCase();
    out.push({
      id,
      label,
      files: files.slice().sort((a, b) => a.name.localeCompare(b.name)),
    });
  }
  out.sort((a, b) => {
    if (a.id === '') return -1;
    if (b.id === '') return 1;
    return a.id.localeCompare(b.id);
  });
  return out;
}

/** Substring filter on title + relPath for the in-pane search input. */
const filterFiles = (files: ResourceNode[], q: string): ResourceNode[] => filterByQuery(files, q);

export interface ResourcesViewActions {
  /** Open via the user's main `open_with` slot. */
  openInEditor: (path: string) => void;
  /** View an `.md` or `.txt` resource read-only. */
  viewMarkdown: (path: string, title: string) => void;
  /** View a `.txt` resource read-only. */
  viewText: (path: string, title: string) => void;
  /** View a PDF in the existing pdf-modal. */
  viewPdf: (path: string) => void;
  /** Copy a path to the system clipboard. */
  copyPath: (path: string) => void;
  /** Paste a path into the active terminal session. */
  pasteToTerm: (path: string) => Promise<void>;
}

export function ResourcesView(props: {
  root: ResourceNode | null;
  searchInput: string;
  actions: ResourcesViewActions;
}) {
  const sections = createMemo<FlatSection[]>(() => buildSections(props.root));
  const filteredSections = createMemo<FlatSection[]>(() => {
    const q = props.searchInput;
    if (q.trim().length === 0) return sections();
    return sections()
      .map((s) => ({ ...s, files: filterFiles(s.files, q) }))
      .filter((s) => s.files.length > 0);
  });

  return (
    <div class="resources-pane">
      <Show
        when={filteredSections().length > 0}
        fallback={
          <div class="empty">
            <Show
              when={props.searchInput.trim().length > 0}
              fallback={
                <p>
                  No resources directory yet — create <code>resources/</code> at the conception
                  root, or change <code>resources_path</code> in settings.
                </p>
              }
            >
              <p>No matches.</p>
            </Show>
          </div>
        }
      >
        <For each={filteredSections()}>
          {(section) => (
            <section class="resources-group">
              <h2 class="resources-section-header">
                <span class="name">{section.label}</span>
                <span class="count">{section.files.length}</span>
                <span class="rule" />
              </h2>
              <div class="resources-grid">
                <For each={section.files}>
                  {(file) => <ResourceCard node={file} actions={props.actions} />}
                </For>
              </div>
            </section>
          )}
        </For>
      </Show>
    </div>
  );
}

function ResourceCard(props: { node: ResourceNode; actions: ResourcesViewActions }) {
  const cat = (): ResourceCategory => props.node.category ?? 'other';
  // pasteToTerm is async — guard against rapid double-clicks queuing two
  // pastes that may target different terminal sessions if focus shifts
  // between them.
  const [pasting, setPasting] = createSignal(false);
  const pasteToTerm = async (): Promise<void> => {
    if (pasting()) return;
    setPasting(true);
    try {
      await props.actions.pasteToTerm(props.node.path);
    } finally {
      setPasting(false);
    }
  };

  const canViewInline = (): boolean => cat() === 'markdown' || cat() === 'pdf' || cat() === 'text';

  const handleView = (): void => {
    const c = cat();
    if (c === 'markdown') props.actions.viewMarkdown(props.node.path, props.node.title);
    else if (c === 'pdf') props.actions.viewPdf(props.node.path);
    else if (c === 'text') props.actions.viewText(props.node.path, props.node.title);
  };

  const handleCardClick = (): void => {
    if (canViewInline()) handleView();
    else props.actions.openInEditor(props.node.path);
  };

  return (
    <article class="resources-card" data-category={cat()} title={props.node.path}>
      <button
        type="button"
        class="resources-card-body"
        onClick={handleCardClick}
        title={canViewInline() ? 'View' : 'Open in main IDE'}
      >
        <span class="resources-card-glyph" aria-hidden="true">
          <CategoryGlyph category={cat()} />
        </span>
        <span class="resources-card-text">
          <span class="resources-card-title">{props.node.title}</span>
          <Show when={props.node.relPath !== props.node.title}>
            <span class="resources-card-relpath">{props.node.relPath}</span>
          </Show>
          <Show when={props.node.summary}>
            <span class="resources-card-summary">{props.node.summary}</span>
          </Show>
        </span>
      </button>
      <div class="resources-card-actions">
        <Show when={canViewInline()}>
          <button
            type="button"
            class="resources-card-action"
            onClick={(e) => {
              e.stopPropagation();
              handleView();
            }}
            title="View"
            aria-label="View"
          >
            view
          </button>
        </Show>
        <button
          type="button"
          class="resources-card-action"
          onClick={(e) => {
            e.stopPropagation();
            props.actions.openInEditor(props.node.path);
          }}
          title="Open in main IDE"
          aria-label="Open in main IDE"
        >
          open
        </button>
        <button
          type="button"
          class="resources-card-action"
          onClick={(e) => {
            e.stopPropagation();
            props.actions.copyPath(props.node.path);
          }}
          title="Copy absolute path"
          aria-label="Copy absolute path"
        >
          copy
        </button>
        <button
          type="button"
          class="resources-card-action"
          disabled={pasting()}
          onClick={(e) => {
            e.stopPropagation();
            void pasteToTerm();
          }}
          title="Paste path into the active terminal"
          aria-label="Paste path into the active terminal"
        >
          → term
        </button>
      </div>
    </article>
  );
}

function CategoryGlyph(props: { category: ResourceCategory }) {
  const label = (): string => {
    switch (props.category) {
      case 'markdown':
        return 'MD';
      case 'pdf':
        return 'PDF';
      case 'text':
        return 'TXT';
      case 'image':
        return 'IMG';
      case 'audio':
        return 'AUD';
      case 'video':
        return 'VID';
      case 'archive':
        return 'ZIP';
      case 'binary':
        return 'BIN';
      default:
        return '·';
    }
  };
  return <span class="resources-card-glyph-label">{label()}</span>;
}
