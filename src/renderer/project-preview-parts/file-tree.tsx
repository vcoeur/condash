import { For, Show, createSignal } from 'solid-js';
import type { ProjectFileEntry } from '@shared/types';
import { IconPlus } from '../icons';
import { Button, IconButton } from '../actions';

/* File tree — recursive directory structure built from the flat
 * ProjectFileEntry list. README.md sits at the root with the rest of
 * the top-level files (no special "main" treatment). Each directory
 * carries its direct file children plus nested subdirectories. */
export interface FileTreeDir {
  name: string;
  path: string;
  files: ProjectFileEntry[];
  subdirs: FileTreeDir[];
}

export interface FileTree {
  rootFiles: ProjectFileEntry[];
  dirs: FileTreeDir[];
}

/** notes/ comes first; other dirs are alphabetical. */
function compareDirNames(a: string, b: string): number {
  if (a === 'notes') return -1;
  if (b === 'notes') return 1;
  return a.localeCompare(b);
}

export function buildFileTree(
  files: readonly ProjectFileEntry[],
  options?: { ensureNotesDir?: boolean },
): FileTree {
  const rootFiles: ProjectFileEntry[] = [];
  const subBuckets = new Map<string, ProjectFileEntry[]>();
  for (const file of files) {
    const slash = file.relPath.indexOf('/');
    if (slash === -1) {
      rootFiles.push(file);
      continue;
    }
    const head = file.relPath.slice(0, slash);
    let bucket = subBuckets.get(head);
    if (!bucket) {
      bucket = [];
      subBuckets.set(head, bucket);
    }
    bucket.push({ ...file, relPath: file.relPath.slice(slash + 1) });
  }

  rootFiles.sort((a, b) => a.name.localeCompare(b.name));

  // Surface a synthetic empty notes/ dir when the caller wants the
  // "+ Add note" affordance available even on projects that haven't
  // had their notes/ folder created on disk yet.
  if (options?.ensureNotesDir && !subBuckets.has('notes')) {
    subBuckets.set('notes', []);
  }

  const dirs: FileTreeDir[] = [];
  const dirNames = Array.from(subBuckets.keys()).sort(compareDirNames);
  for (const name of dirNames) {
    const sub = buildFileTree(subBuckets.get(name)!);
    dirs.push({
      name,
      path: name,
      files: sub.rootFiles,
      subdirs: sub.dirs.map((d) => ({ ...d, path: `${name}/${d.path}` })),
    });
  }
  return { rootFiles, dirs };
}

/** SVG icons for the file tree — sized to match the rest of the icon
 * system (16 × 16 viewBox, stroke-width 1.5, currentColor). Replaces
 * the emoji glyphs that didn't sit well alongside the kind/step icons. */
export function IconFile() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 1.75h6L13 5.25v9H3.5z" />
      <path d="M9.5 1.75v3.5H13" />
    </svg>
  );
}

export function IconFolder() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M2 4.5a1 1 0 0 1 1-1h3.25l1.5 1.75H13a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
    </svg>
  );
}

export function IconChevronRight() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M6.25 4l4 4-4 4" />
    </svg>
  );
}

/* Recursive file-tree renderer. Reads a FileTree, outputs a flat
 * sequence of <li> rows (file rows + collapsible folder rows) into the
 * surrounding <ul class="files-list">. depth controls indent; notes/
 * at depth 0 starts open by default, every other folder starts
 * collapsed. */
export function FileTreeRows(props: {
  tree: FileTree;
  depth: number;
  onOpenFile: (file: ProjectFileEntry) => void;
  onCreateNote?: () => void;
}) {
  return (
    <>
      <For each={props.tree.rootFiles}>
        {(file) => (
          <li class="file-row" style={{ '--tree-depth': props.depth }}>
            <Button
              variant="ghost"
              class="file-button"
              onClick={() => props.onOpenFile(file)}
              title={file.name}
            >
              <span class="file-row-icon">
                <IconFile />
              </span>
              <span class="file-name">{file.name}</span>
            </Button>
          </li>
        )}
      </For>
      <For each={props.tree.dirs}>
        {(dir) => (
          <FileTreeDirRow
            dir={dir}
            depth={props.depth}
            onOpenFile={props.onOpenFile}
            onCreateNote={props.onCreateNote}
          />
        )}
      </For>
    </>
  );
}

function FileTreeDirRow(props: {
  dir: FileTreeDir;
  depth: number;
  onOpenFile: (file: ProjectFileEntry) => void;
  onCreateNote?: () => void;
}) {
  const [open, setOpen] = createSignal(props.depth === 0 && props.dir.name === 'notes');
  return (
    <>
      <li class="file-group-head" style={{ '--tree-depth': props.depth }}>
        <Button
          type="button"
          variant="ghost"
          class="file-group-toggle"
          onClick={() => setOpen((v) => !v)}
        >
          <span class="file-group-chevron" classList={{ open: open() }}>
            <IconChevronRight />
          </span>
          <span class="file-row-icon">
            <IconFolder />
          </span>
          <span class="file-group-label">{props.dir.name}/</span>
        </Button>
        <Show when={props.dir.name === 'notes' && props.onCreateNote && props.depth === 0}>
          <IconButton
            variant="ghost"
            tone="add"
            class="file-group-add"
            onClick={props.onCreateNote}
            title="Add a new note to this project"
            label="Add note"
          >
            <IconPlus />
          </IconButton>
        </Show>
      </li>
      <Show when={open()}>
        <FileTreeRows
          tree={{ rootFiles: props.dir.files, dirs: props.dir.subdirs }}
          depth={props.depth + 1}
          onOpenFile={props.onOpenFile}
          onCreateNote={props.onCreateNote}
        />
      </Show>
    </>
  );
}
