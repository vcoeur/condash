import { For, Show, createEffect, createSignal, on } from 'solid-js';
import type { JSX } from 'solid-js';
import type { ProjectFileEntry } from '@shared/types';
import { Button } from '../actions';
import { Caret, FolderIcon, IconExternal } from '../icons';
import { IconNewFile, IconNewFolder } from './icons';
import { LOCAL_DIR, buildFileTree, defaultExpanded, isLocalPath, type FileTreeNode } from './data';

/** Pending inline-create input: which dir it targets ('' = project root)
 * and what it creates. */
interface CreateDraft {
  dirRelPath: string;
  kind: 'file' | 'dir';
}

/** Strip the Electron IPC wrapper ("Error invoking remote method '…': Error:
 * <msg>") down to the handler's own message. */
function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const idx = raw.lastIndexOf('Error: ');
  return idx === -1 ? raw : raw.slice(idx + 'Error: '.length);
}

const INDENT_PX = 14;

function indentStyle(depth: number): JSX.CSSProperties {
  return { 'padding-left': `${6 + depth * INDENT_PX}px` };
}

/**
 * The preview modal's Files widget: a collapsible tree of the project
 * directory (dirs + files), with per-entry open-externally affordances and
 * inline "new file" / "new folder" creation. Top-level dirs start expanded;
 * the gitignored `local/` scratch dir renders dimmed + badged, sorted last,
 * collapsed by default. Files open through the existing `onOpenFile` path.
 */
export function FilesWidget(props: {
  /** The project README path — key for the create verbs. */
  projectPath: string;
  files: () => readonly ProjectFileEntry[] | undefined;
  onOpenFile: (path: string) => void;
  /** Refetch the files resource after a successful create. */
  onRefresh: () => void;
  onCreateNote?: () => void;
}) {
  // User expand/collapse toggles, laid over `defaultExpanded`. Replaced
  // wholesale (immutably) so Solid re-renders on each toggle.
  const [overrides, setOverrides] = createSignal<ReadonlyMap<string, boolean>>(new Map());
  const [draft, setDraft] = createSignal<CreateDraft | null>(null);
  const [draftName, setDraftName] = createSignal('');
  const [draftError, setDraftError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  const cancelDraft = (): void => {
    setDraft(null);
    setDraftName('');
    setDraftError(null);
  };

  // The modal stays mounted across projects, so reset per-project UI state
  // when the previewed project changes.
  createEffect(
    on(
      () => props.projectPath,
      () => {
        setOverrides(new Map());
        cancelDraft();
      },
      { defer: true },
    ),
  );

  const tree = (): FileTreeNode[] => buildFileTree(props.files() ?? []);

  const isExpanded = (node: FileTreeNode, depth: number): boolean =>
    overrides().get(node.relPath) ?? defaultExpanded(node, depth);

  const setExpanded = (relPath: string, value: boolean): void => {
    const next = new Map(overrides());
    next.set(relPath, value);
    setOverrides(next);
  };

  const beginDraft = (dirRelPath: string, kind: 'file' | 'dir'): void => {
    setDraft({ dirRelPath, kind });
    setDraftName('');
    setDraftError(null);
    // Make sure the input's home dir is open so it's actually visible.
    if (dirRelPath !== '') setExpanded(dirRelPath, true);
  };

  const commitDraft = async (): Promise<void> => {
    const current = draft();
    if (!current || busy()) return;
    const name = draftName().trim();
    if (!name) {
      cancelDraft();
      return;
    }
    setBusy(true);
    setDraftError(null);
    try {
      if (current.kind === 'file') {
        await window.condash.createProjectFile(props.projectPath, current.dirRelPath, name);
      } else {
        await window.condash.createProjectDir(props.projectPath, current.dirRelPath, name);
      }
      cancelDraft();
      props.onRefresh();
    } catch (err) {
      setDraftError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const openExternally = (path: string): void => {
    void window.condash.openPath(path);
  };

  /** Inline name input rendered inside the dir it creates into. */
  const DraftRow = (rowProps: { depth: number }) => (
    <li>
      <div class="file-tree-row file-tree-draft" style={indentStyle(rowProps.depth)}>
        <span class="file-tree-draft-glyph" aria-hidden="true">
          {draft()?.kind === 'dir' ? <IconNewFolder /> : <IconNewFile />}
        </span>
        <input
          class="file-tree-input"
          type="text"
          placeholder={draft()?.kind === 'dir' ? 'folder name…' : 'file name…'}
          value={draftName()}
          ref={(el) => queueMicrotask(() => el?.focus())}
          onInput={(e) => setDraftName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void commitDraft();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancelDraft();
            }
          }}
          onBlur={() => {
            // Click-away cancels; a failed commit keeps focus + error.
            if (!busy()) cancelDraft();
          }}
          disabled={busy()}
        />
      </div>
      <Show when={draftError()}>
        <div class="file-tree-error" style={indentStyle(rowProps.depth)}>
          {draftError()}
        </div>
      </Show>
    </li>
  );

  const DirRow = (rowProps: { node: FileTreeNode; depth: number }) => {
    const node = () => rowProps.node;
    const expanded = () => isExpanded(node(), rowProps.depth);
    const isLocalRoot = () => rowProps.depth === 0 && node().name === LOCAL_DIR;
    return (
      <li>
        <div
          class="file-tree-row file-tree-dir"
          classList={{ 'file-tree-local': isLocalPath(node().relPath) }}
          style={indentStyle(rowProps.depth)}
        >
          <button
            type="button"
            class="file-tree-main"
            onClick={() => setExpanded(node().relPath, !expanded())}
            aria-expanded={expanded()}
            title={
              isLocalRoot()
                ? 'Scratch directory — gitignored, not committed'
                : `${expanded() ? 'Collapse' : 'Expand'} ${node().relPath}/`
            }
          >
            <Caret expanded={expanded()} />
            <span class="file-tree-glyph" aria-hidden="true">
              <FolderIcon />
            </span>
            <span class="file-tree-name">{node().name}</span>
            <Show when={isLocalRoot()}>
              <span class="gitignored-badge" title="Scratch, not committed — local/ is gitignored">
                gitignored
              </span>
            </Show>
          </button>
          <span class="file-tree-actions">
            <Button
              variant="ghost"
              tone="add"
              class="btn--icon file-tree-action"
              onClick={() => beginDraft(node().relPath, 'file')}
              title={`New file in ${node().relPath}/`}
              aria-label={`New file in ${node().relPath}`}
            >
              <IconNewFile />
            </Button>
            <Button
              variant="ghost"
              tone="add"
              class="btn--icon file-tree-action"
              onClick={() => beginDraft(node().relPath, 'dir')}
              title={`New folder in ${node().relPath}/`}
              aria-label={`New folder in ${node().relPath}`}
            >
              <IconNewFolder />
            </Button>
            <Button
              variant="ghost"
              tone="open"
              class="btn--icon file-tree-action"
              onClick={() => openExternally(node().path)}
              title="Open folder externally"
              aria-label={`Open ${node().relPath} externally`}
            >
              <IconExternal />
            </Button>
          </span>
        </div>
        <Show when={expanded()}>
          <ul class="file-tree-children">
            <Show when={draft()?.dirRelPath === node().relPath}>
              <DraftRow depth={rowProps.depth + 1} />
            </Show>
            <TreeLevel nodes={node().children} depth={rowProps.depth + 1} />
          </ul>
        </Show>
      </li>
    );
  };

  const FileRow = (rowProps: { node: FileTreeNode; depth: number }) => (
    <li>
      <div
        class="file-tree-row file-tree-file"
        classList={{ 'file-tree-local': isLocalPath(rowProps.node.relPath) }}
        style={indentStyle(rowProps.depth)}
      >
        <button
          type="button"
          class="file-tree-main"
          onClick={() => props.onOpenFile(rowProps.node.path)}
          title={rowProps.node.relPath}
        >
          <span class="file-tree-name">{rowProps.node.name}</span>
        </button>
        <span class="file-tree-actions">
          <Button
            variant="ghost"
            tone="open"
            class="btn--icon file-tree-action"
            onClick={() => openExternally(rowProps.node.path)}
            title="Open externally"
            aria-label={`Open ${rowProps.node.relPath} externally`}
          >
            <IconExternal />
          </Button>
        </span>
      </div>
    </li>
  );

  const TreeLevel = (levelProps: { nodes: FileTreeNode[]; depth: number }) => (
    <For each={levelProps.nodes}>
      {(node) =>
        node.kind === 'dir' ? (
          <DirRow node={node} depth={levelProps.depth} />
        ) : (
          <FileRow node={node} depth={levelProps.depth} />
        )
      }
    </For>
  );

  return (
    <div class="widget-files">
      <Show when={tree().length === 0 && !draft()}>
        <p class="preview-empty">No files besides README.md yet.</p>
      </Show>
      <ul class="file-tree">
        <TreeLevel nodes={tree()} depth={0} />
        <Show when={draft()?.dirRelPath === ''}>
          <DraftRow depth={0} />
        </Show>
      </ul>
      <div class="file-tree-footer">
        <Show when={props.onCreateNote}>
          <Button
            variant="ghost"
            size="sm"
            tone="add"
            class="file-tree-add"
            onClick={() => props.onCreateNote?.()}
            title="Add a new note to this project"
          >
            + Add note
          </Button>
        </Show>
        <Button
          variant="ghost"
          size="sm"
          tone="add"
          class="file-tree-add"
          onClick={() => beginDraft('', 'file')}
          title="Create an empty file at the project root"
        >
          + New file
        </Button>
        <Button
          variant="ghost"
          size="sm"
          tone="add"
          class="file-tree-add"
          onClick={() => beginDraft('', 'dir')}
          title="Create a folder at the project root"
        >
          + New folder
        </Button>
      </div>
    </div>
  );
}
