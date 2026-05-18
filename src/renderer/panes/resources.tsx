import { createMemo, createSignal, Show } from 'solid-js';
import type { ResourceCategory, ResourceNode } from '@shared/types';
import { usePaneScrollMemory } from './pane-scroll-memory';
import {
  TreeView,
  type TreeAffordance,
  type TreeViewMutationApi,
  type TreeViewPromptApi,
} from './tree-view';
import './resources-pane.css';

const RESOURCES_AFFORDANCES: ReadonlyArray<TreeAffordance> = ['createMd', 'importFile', 'mkdir'];

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
  actions: ResourcesViewActions;
  /** Open Settings (so the user can adjust `resources_path`). */
  onOpenSettings?: () => void;
  /** Open the conception folder in the OS file manager. */
  onOpenConceptionDir?: () => void;
  expanded: () => ReadonlySet<string>;
  onToggleExpand: (relPath: string) => void;
  mutations: TreeViewMutationApi;
  prompts: TreeViewPromptApi;
  onAfterMutation: (newPath: string, kind: TreeAffordance, sourceDirRelPath: string) => void;
  onError: (message: string) => void;
}) {
  const scrollRef = usePaneScrollMemory('resources');

  // Memoise the inline file renderer so toggling one directory's expansion
  // doesn't invalidate every file card in the rest of the tree — see
  // notes/01-design.md.
  const renderFile = createMemo(() => (file: ResourceNode) => (
    <ResourceCard node={file} actions={props.actions} />
  ));

  return (
    <div class="resources-pane" ref={scrollRef}>
      <Show
        when={props.root}
        fallback={
          <div class="empty">
            <p>No resources directory yet.</p>
            <p>
              Drop any file under <code>resources/</code> at the conception root, or change{' '}
              <code>resources_path</code> in Settings.
            </p>
            <div class="empty-actions">
              <Show when={props.onOpenConceptionDir}>
                <button
                  type="button"
                  class="empty-cta"
                  onClick={() => props.onOpenConceptionDir?.()}
                >
                  Open in file manager
                </button>
              </Show>
              <Show when={props.onOpenSettings}>
                <button type="button" class="empty-cta" onClick={() => props.onOpenSettings?.()}>
                  Edit settings
                </button>
              </Show>
            </div>
          </div>
        }
      >
        {(root) => (
          <TreeView<ResourceNode>
            treeKey="resources"
            root={root()}
            expanded={props.expanded}
            onToggleExpand={props.onToggleExpand}
            affordances={RESOURCES_AFFORDANCES}
            mutations={props.mutations}
            prompts={props.prompts}
            onAfterMutation={props.onAfterMutation}
            onError={props.onError}
            renderFile={renderFile()}
          />
        )}
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
