import { createMemo, For, Show, type JSX } from 'solid-js';
import type { TreeRoot } from '@shared/types';
import { Caret } from '../icons';
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
  /** The directory to render. At the top level this is the pane's root —
   *  the root header is never rendered, only its children, so the pane
   *  keeps its current silhouette. For nested calls (recursion) it is the
   *  subdirectory whose header + body should render here. */
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
  /** Optional pane-specific suffix for a directory's header — kept for
   *  decoration that is *not* the special-file callout. The
   *  index.md / SKILL.md / CLAUDE.md badges no longer live here; they
   *  render inside the dir's expanded body via `renderSpecialFile`. */
  renderDirSuffix?: (dir: TFile) => JSX.Element;
  /** Predicate identifying a directory's "special file" — index.md for
   *  Knowledge, SKILL.md for sub-skill dirs, CLAUDE.md at the skills
   *  root. The first matched file per directory is pulled out of the
   *  regular file list and rendered first inside the expanded body via
   *  `renderSpecialFile`. */
  specialFile?: (file: TFile, dir: TFile) => boolean;
  /** Render the special file as a badged callout. Receives the file
   *  node and the parent directory so the badge can carry e.g.
   *  `INDEX for topics` context if the pane wants it. */
  renderSpecialFile?: (file: TFile, dir: TFile) => JSX.Element;
  /** Optional predicate that drops a file from the directory's card
   *  list (and from its file count) without removing it from the
   *  underlying tree. */
  skipFile?: (file: TFile) => boolean;
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
  /** Recursion bookkeeping — caller-side defaults are top-level. */
  depth?: number;
  isRoot?: boolean;
}

/** Render one directory: header (always visible) plus children when
 *  expanded. The top-level call (`isRoot`, default true) is what the
 *  panes invoke and adds the `<div class="tree-view">` wrapper; the
 *  recursion below re-enters the same component with `isRoot={false}`. */
export function TreeView<TFile extends TreeViewBaseNode>(props: TreeViewProps<TFile>): JSX.Element {
  const depth = (): number => props.depth ?? 0;
  const isRoot = (): boolean => props.isRoot ?? true;

  const childDirs = createMemo<TFile[]>(() => {
    const out: TFile[] = [];
    for (const child of props.root.children ?? []) {
      if (child.kind === 'directory') out.push(child as TFile);
    }
    return out;
  });
  const specialChild = createMemo<TFile | null>(() => {
    const test = props.specialFile;
    if (!test) return null;
    for (const child of props.root.children ?? []) {
      if (child.kind !== 'file') continue;
      const file = child as TFile;
      if (test(file, props.root)) return file;
    }
    return null;
  });
  const childFiles = createMemo<TFile[]>(() => {
    const out: TFile[] = [];
    const skip = props.skipFile;
    const special = specialChild();
    for (const child of props.root.children ?? []) {
      if (child.kind !== 'file') continue;
      const file = child as TFile;
      if (special && file === special) continue;
      if (skip?.(file)) continue;
      out.push(file);
    }
    return out;
  });

  const body = (): JSX.Element => (
    <section class="tree-directory" data-depth={depth()} data-root={isRoot() ? 'true' : 'false'}>
      <DirectoryHeader
        node={props.root}
        depth={depth()}
        isRoot={isRoot()}
        treeKey={props.treeKey}
        expanded={props.expanded}
        onToggleExpand={props.onToggleExpand}
        renderDirSuffix={props.renderDirSuffix}
        affordances={props.affordances}
        mutations={props.mutations}
        prompts={props.prompts}
        onAfterMutation={props.onAfterMutation}
        onError={props.onError}
        directFileCount={childFiles().length + (specialChild() ? 1 : 0)}
      />
      <Show when={isExpanded(props.expanded(), props.root.relPath, isRoot())}>
        <div class="tree-children">
          <Show when={specialChild() && props.renderSpecialFile}>
            <div class="tree-special">{props.renderSpecialFile!(specialChild()!, props.root)}</div>
          </Show>
          <For each={childDirs()}>
            {(dir) => (
              <TreeView
                root={dir}
                depth={depth() + 1}
                isRoot={false}
                treeKey={props.treeKey}
                expanded={props.expanded}
                onToggleExpand={props.onToggleExpand}
                renderFile={props.renderFile}
                renderDirSuffix={props.renderDirSuffix}
                specialFile={props.specialFile}
                renderSpecialFile={props.renderSpecialFile}
                skipFile={props.skipFile}
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

  return (
    <Show when={isRoot()} fallback={body()}>
      <div class="tree-view">{body()}</div>
    </Show>
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

  /** The whole header row toggles the directory — the disclosure target
   *  is the row, not just the chevron. Clicks on inner buttons (the
   *  affordance row, or any `<button>` a `renderDirSuffix` slot might
   *  add) are excluded so they keep their own behaviour. */
  const handleHeaderClick = (e: MouseEvent): void => {
    if (props.isRoot) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('button.tree-dir-action, button.tree-dir-suffix-action')) return;
    props.onToggleExpand(props.node.relPath);
  };

  return (
    <header
      class="tree-dir-header"
      data-root={props.isRoot ? 'true' : 'false'}
      data-open={open() ? 'true' : 'false'}
      onClick={handleHeaderClick}
    >
      <button
        type="button"
        class="tree-dir-twisty"
        aria-label={open() ? 'Collapse' : 'Expand'}
        title={open() ? 'Collapse' : 'Expand'}
        disabled={props.isRoot}
        onClick={(e) => {
          // The header row already toggles via handleHeaderClick — stop
          // here so the row handler doesn't fire a second toggle.
          e.stopPropagation();
          if (!props.isRoot) props.onToggleExpand(props.node.relPath);
        }}
      >
        <Caret expanded={open()} />
      </button>
      <span class="tree-dir-name">{label()}</span>
      <Show when={props.directFileCount > 0}>
        <span class="tree-dir-count">{props.directFileCount}</span>
      </Show>
      <Show when={props.renderDirSuffix}>
        <span class="tree-dir-suffix">{props.renderDirSuffix?.(props.node)}</span>
      </Show>
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
