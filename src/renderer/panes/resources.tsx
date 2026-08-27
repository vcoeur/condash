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
  /** View an HTML file in the html-modal (rendered, with a source toggle). */
  viewHtml: (path: string) => void;
  /** View an image (raster or SVG) in the image-modal. */
  viewImage: (path: string) => void;
  /** View a plan/review `.mdx` in the block viewer. */
  viewMdx: (path: string) => void;
  /** Reveal the file in the OS file manager. */
  reveal: (path: string) => void;
  /** Copy a path to the system clipboard. */
  copyPath: (path: string) => void;
  /** Paste a path into the active terminal session. */
  pasteToTerm: (path: string) => Promise<void>;
}

export function ResourcesView(props: {
  root: ResourceNode | null;
  actions: ResourcesViewActions;
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
          <div class="empty pane-empty">
            <p>No resources directory yet.</p>
            <p>
              Drop any file under <code>resources/</code> at the conception root.
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

/** Path of the resource card whose paste is in flight, or null.
 *
 *  Module-level rather than owned by the view: on an empty pane a paste waits
 *  for a shell to spawn and its tab to arrive — up to a few seconds — and the
 *  view is mounted behind a `Show` on the working pane, so switching pane and
 *  back inside that window would remount it with a fresh, empty guard and let a
 *  second click open a second shell. Pane-wide rather than per-card because the
 *  spawn it waits on is pane-wide; the path rather than a flag so only the card
 *  that was clicked shows itself busy — a whole tree of "…" buttons reads as
 *  the pane having hung.
 *
 *  Read directly rather than threaded through props: both components live in
 *  this module, and passing it down would make deliberately module-scoped state
 *  read as though it belonged to a component instance. Nothing else can reset
 *  it, so the bridge call it waits on must always settle — see
 *  `waitForTerminalHandle`, which races its frame wait against a timer for
 *  exactly that reason. */
const [pastingPath, setPastingPath] = createSignal<string | null>(null);

function ResourceCard(props: { node: ResourceNode; actions: ResourcesViewActions }) {
  const cat = (): ResourceCategory => props.node.category ?? 'other';
  const anyPasting = (): boolean => pastingPath() !== null;
  const thisPasting = (): boolean => pastingPath() === props.node.path;
  const pasteToTerm = async (): Promise<void> => {
    if (anyPasting()) return;
    setPastingPath(props.node.path);
    try {
      await props.actions.pasteToTerm(props.node.path);
    } finally {
      setPastingPath(null);
    }
  };

  const canViewInline = (): boolean => {
    const c = cat();
    return (
      c === 'markdown' ||
      c === 'pdf' ||
      c === 'text' ||
      c === 'html' ||
      c === 'image' ||
      c === 'mdx'
    );
  };

  const handleView = (): void => {
    const c = cat();
    if (c === 'markdown') props.actions.viewMarkdown(props.node.path, props.node.title);
    else if (c === 'pdf') props.actions.viewPdf(props.node.path);
    else if (c === 'html') props.actions.viewHtml(props.node.path);
    else if (c === 'image') props.actions.viewImage(props.node.path);
    else if (c === 'mdx') props.actions.viewMdx(props.node.path);
    else if (c === 'text') props.actions.viewText(props.node.path, props.node.title);
  };

  const handleCardClick = (): void => {
    if (canViewInline()) handleView();
    else props.actions.openInEditor(props.node.path);
  };

  return (
    <article class="resources-card card" data-category={cat()} title={props.node.path}>
      <button
        type="button"
        class="resources-card-body"
        onClick={handleCardClick}
        title={canViewInline() ? 'View' : 'Open in main IDE'}
      >
        <span class="resources-card-glyph file-glyph" data-cat={cat()} aria-hidden="true">
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
            props.actions.reveal(props.node.path);
          }}
          title="Reveal in file manager"
          aria-label="Reveal in file manager"
        >
          reveal
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
          disabled={anyPasting()}
          onClick={(e) => {
            e.stopPropagation();
            void pasteToTerm();
          }}
          title="Paste path into the terminal — opens a shell if none is live"
          aria-label="Paste path into the terminal — opens a shell if none is live"
        >
          {/* On an empty pane the paste now waits for a shell to spawn and its
              tab to arrive — up to a few seconds. Without a pending label the
              button just looks dead. */}
          {thisPasting() ? '…' : '→ term'}
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
      case 'mdx':
        return 'MDX';
      case 'pdf':
        return 'PDF';
      case 'html':
        return 'WEB';
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
