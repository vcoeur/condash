import { createMemo, For, Show, type JSX } from 'solid-js';
import type { TreeRoot } from '@shared/types';
import { formatSectionLabel } from './pane-utils';
import './tree-view.css';

/**
 * Generic collapsible directory tree shared by the Knowledge, Resources,
 * and Skills panes (issue #89). Each pane normalises its own node shape
 * down to the `TreeViewBaseNode` shape below — the recursion only needs
 * `relPath`, `name`, `kind`, and `children` to walk the tree. The
 * pane-specific bits (file card, INDEX/SKILL header badge, bucket
 * coloring) come back through the `renderFile` and `renderDirSuffix` slots.
 *
 * State conventions:
 * - The expansion `Set<string>` carries directory `relPath`s. The root's
 *   `relPath` is the empty string and is always treated as expanded;
 *   every other directory starts collapsed (#89 req 3).
 * - `onAfterMutation` fires after a successful create / import / mkdir,
 *   carrying the absolute path that was just written so the caller can
 *   bump its refresh key and (optionally) open the new file.
 */

export interface TreeViewBaseNode {
  /** Path relative to the pane's on-disk root. Empty string for the root. */
  relPath: string;
  /** Last segment of relPath, or the pane's name for the root. */
  name: string;
  kind: 'directory' | 'file';
  children?: ReadonlyArray<TreeViewBaseNode>;
}

export type TreeAffordance = 'createMd' | 'mkdir' | 'importFile';

export interface TreeViewMutationApi {
  createMd: (root: TreeRoot, dirRelPath: string, filename: string) => Promise<string>;
  mkdir: (root: TreeRoot, dirRelPath: string, name: string) => Promise<string>;
  importFile: (root: TreeRoot, dirRelPath: string) => Promise<string | null>;
}

export interface TreeViewPromptApi {
  prompt: (init: {
    title: string;
    message?: string;
    placeholder?: string;
    confirmLabel?: string;
  }) => Promise<string | null>;
}

export interface TreeViewProps<TFile extends TreeViewBaseNode> {
  treeKey: TreeRoot;
  /** The pane's root node. The root header is never rendered — its
   *  children render directly so the pane keeps its current top-level
   *  silhouette and the affordance buttons sit on every nested directory
   *  (and on a synthetic ROOT chip when the root needs them). */
  root: TFile;
  /** Read-only accessor for the set of currently-expanded directory
   *  relPaths. Solid signal so the tree re-renders on toggle. */
  expanded: () => ReadonlySet<string>;
  /** Toggle a single directory's expanded state. The component never
   *  writes the set itself — the parent owns persistence. */
  onToggleExpand: (relPath: string) => void;
  /** Render a single file leaf. The pane keeps full control of card
   *  layout, click handling, and badges. */
  renderFile: (file: TFile) => JSX.Element;
  /** Optional pane-specific suffix for a directory's header — the
   *  Knowledge `INDEX` badge or the Skills `SKILL` badge live here. */
  renderDirSuffix?: (dir: TFile) => JSX.Element;
  /** Which affordance buttons sit on every directory header. */
  affordances: ReadonlyArray<TreeAffordance>;
  /** Bridge to `window.condash.tree*` — passed in so the component is
   *  trivially testable without an IPC stub. */
  mutations: TreeViewMutationApi;
  prompts: TreeViewPromptApi;
  /** Fires after a successful mutation with the new file/dir absolute
   *  path, the kind of mutation, and the `relPath` of the directory
   *  where the action originated (so the pane can auto-expand it so the
   *  newly-created child is visible). The pane uses this to refetch its
   *  tree and (for createMd / importFile) open the result. */
  onAfterMutation: (newPath: string, kind: TreeAffordance, sourceDirRelPath: string) => void;
  /** Fires when an IPC verb rejects so the pane can surface a toast. */
  onError: (message: string) => void;
}

export function TreeView<TFile extends TreeViewBaseNode>(props: TreeViewProps<TFile>): JSX.Element {
  return (
    <div class="tree-view">
      <DirectoryBody
        node={props.root}
        depth={0}
        isRoot={true}
        treeKey={props.treeKey}
        expanded={props.expanded}
        onToggleExpand={props.onToggleExpand}
        renderFile={props.renderFile}
        renderDirSuffix={props.renderDirSuffix}
        affordances={props.affordances}
        mutations={props.mutations}
        prompts={props.prompts}
        onAfterMutation={props.onAfterMutation}
        onError={props.onError}
      />
    </div>
  );
}

interface DirectoryBodyProps<TFile extends TreeViewBaseNode> {
  node: TFile;
  depth: number;
  isRoot: boolean;
  treeKey: TreeRoot;
  expanded: () => ReadonlySet<string>;
  onToggleExpand: (relPath: string) => void;
  renderFile: (file: TFile) => JSX.Element;
  renderDirSuffix?: (dir: TFile) => JSX.Element;
  affordances: ReadonlyArray<TreeAffordance>;
  mutations: TreeViewMutationApi;
  prompts: TreeViewPromptApi;
  onAfterMutation: (newPath: string, kind: TreeAffordance, sourceDirRelPath: string) => void;
  onError: (message: string) => void;
}

/** Render one directory: header (always visible) plus children when
 *  expanded. Root is always rendered expanded so an all-collapsed pane
 *  still shows its top-level entries. */
function DirectoryBody<TFile extends TreeViewBaseNode>(
  props: DirectoryBodyProps<TFile>,
): JSX.Element {
  const childDirs = createMemo<TFile[]>(() => {
    const out: TFile[] = [];
    for (const child of props.node.children ?? []) {
      if (child.kind === 'directory') out.push(child as TFile);
    }
    return out;
  });
  const childFiles = createMemo<TFile[]>(() => {
    const out: TFile[] = [];
    for (const child of props.node.children ?? []) {
      if (child.kind === 'file') out.push(child as TFile);
    }
    return out;
  });

  return (
    <section
      class="tree-directory"
      data-depth={props.depth}
      data-root={props.isRoot ? 'true' : 'false'}
    >
      <DirectoryHeader
        node={props.node}
        depth={props.depth}
        isRoot={props.isRoot}
        treeKey={props.treeKey}
        expanded={props.expanded}
        onToggleExpand={props.onToggleExpand}
        renderDirSuffix={props.renderDirSuffix}
        affordances={props.affordances}
        mutations={props.mutations}
        prompts={props.prompts}
        onAfterMutation={props.onAfterMutation}
        onError={props.onError}
        directFileCount={childFiles().length}
      />
      <Show when={isExpanded(props.expanded(), props.node.relPath, props.isRoot)}>
        <div class="tree-children">
          <For each={childDirs()}>
            {(dir) => (
              <DirectoryBody
                node={dir}
                depth={props.depth + 1}
                isRoot={false}
                treeKey={props.treeKey}
                expanded={props.expanded}
                onToggleExpand={props.onToggleExpand}
                renderFile={props.renderFile}
                renderDirSuffix={props.renderDirSuffix}
                affordances={props.affordances}
                mutations={props.mutations}
                prompts={props.prompts}
                onAfterMutation={props.onAfterMutation}
                onError={props.onError}
              />
            )}
          </For>
          <Show when={childFiles().length > 0}>
            <div class="tree-files">
              <For each={childFiles()}>{(file) => props.renderFile(file)}</For>
            </div>
          </Show>
        </div>
      </Show>
    </section>
  );
}

interface DirectoryHeaderProps<TFile extends TreeViewBaseNode> {
  node: TFile;
  depth: number;
  isRoot: boolean;
  treeKey: TreeRoot;
  expanded: () => ReadonlySet<string>;
  onToggleExpand: (relPath: string) => void;
  renderDirSuffix?: (dir: TFile) => JSX.Element;
  affordances: ReadonlyArray<TreeAffordance>;
  mutations: TreeViewMutationApi;
  prompts: TreeViewPromptApi;
  onAfterMutation: (newPath: string, kind: TreeAffordance, sourceDirRelPath: string) => void;
  onError: (message: string) => void;
  directFileCount: number;
}

function DirectoryHeader<TFile extends TreeViewBaseNode>(
  props: DirectoryHeaderProps<TFile>,
): JSX.Element {
  const open = (): boolean => isExpanded(props.expanded(), props.node.relPath, props.isRoot);
  const label = (): string =>
    props.isRoot ? props.treeKey.toUpperCase() : formatSectionLabel(props.node.relPath);

  const handleCreateMd = async (): Promise<void> => {
    const filename = await props.prompts.prompt({
      title: `New markdown in ${label()}`,
      message: 'Filename (extension optional). Lowercase, hyphens.',
      placeholder: 'my-new-note',
      confirmLabel: 'Create',
    });
    if (filename === null || filename.trim().length === 0) return;
    try {
      const newPath = await props.mutations.createMd(
        props.treeKey,
        props.node.relPath,
        filename.trim(),
      );
      props.onAfterMutation(newPath, 'createMd', props.node.relPath);
    } catch (err) {
      props.onError((err as Error).message ?? 'Could not create markdown file.');
    }
  };

  const handleMkdir = async (): Promise<void> => {
    const name = await props.prompts.prompt({
      title: `New directory in ${label()}`,
      message: 'Directory name. Lowercase, hyphens.',
      placeholder: 'subdir',
      confirmLabel: 'Create',
    });
    if (name === null || name.trim().length === 0) return;
    try {
      const newPath = await props.mutations.mkdir(props.treeKey, props.node.relPath, name.trim());
      props.onAfterMutation(newPath, 'mkdir', props.node.relPath);
    } catch (err) {
      props.onError((err as Error).message ?? 'Could not create directory.');
    }
  };

  const handleImport = async (): Promise<void> => {
    try {
      const newPath = await props.mutations.importFile(props.treeKey, props.node.relPath);
      if (newPath !== null) props.onAfterMutation(newPath, 'importFile', props.node.relPath);
    } catch (err) {
      props.onError((err as Error).message ?? 'Could not import file.');
    }
  };

  return (
    <header
      class="tree-dir-header"
      data-root={props.isRoot ? 'true' : 'false'}
      data-open={open() ? 'true' : 'false'}
    >
      <button
        type="button"
        class="tree-dir-twisty"
        aria-label={open() ? 'Collapse' : 'Expand'}
        title={open() ? 'Collapse' : 'Expand'}
        disabled={props.isRoot}
        onClick={() => {
          if (!props.isRoot) props.onToggleExpand(props.node.relPath);
        }}
      >
        <span class="tree-dir-twisty-glyph" data-open={open() ? 'true' : 'false'}>
          {/* Visible chevron — rotated via CSS rather than swapped out so the
           * collapse/expand transition can animate.*/}
          ▸
        </span>
      </button>
      <span class="tree-dir-name">{label()}</span>
      <Show when={props.directFileCount > 0}>
        <span class="tree-dir-count">{props.directFileCount}</span>
      </Show>
      <Show when={props.renderDirSuffix}>{props.renderDirSuffix?.(props.node)}</Show>
      <span class="tree-dir-rule" />
      <div class="tree-dir-actions">
        <Show when={props.affordances.includes('createMd')}>
          <button
            type="button"
            class="tree-dir-action"
            title="Create new markdown file in this directory"
            aria-label="Create new markdown file"
            onClick={() => void handleCreateMd()}
          >
            + md
          </button>
        </Show>
        <Show when={props.affordances.includes('importFile')}>
          <button
            type="button"
            class="tree-dir-action"
            title="Import an existing file into this directory"
            aria-label="Import file"
            onClick={() => void handleImport()}
          >
            + file
          </button>
        </Show>
        <Show when={props.affordances.includes('mkdir')}>
          <button
            type="button"
            class="tree-dir-action"
            title="Create new subdirectory"
            aria-label="Create new subdirectory"
            onClick={() => void handleMkdir()}
          >
            + dir
          </button>
        </Show>
      </div>
    </header>
  );
}

function isExpanded(set: ReadonlySet<string>, relPath: string, isRoot: boolean): boolean {
  if (isRoot) return true;
  return set.has(relPath);
}
