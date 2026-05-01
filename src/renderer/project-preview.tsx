import { For, Show, createResource, createSignal, onCleanup, onMount } from 'solid-js';
import type { Deliverable, Project, ProjectFileEntry, Step, StepMarker } from '@shared/types';
import { KNOWN_STATUSES } from '@shared/types';
import { KindGlyph, StepIcon } from './tabs/projects';

const MARKER_LABEL: Record<StepMarker, string> = {
  ' ': 'todo',
  '~': 'doing',
  x: 'done',
  '-': 'dropped',
};

const STATUS_OPTIONS: readonly string[] = ['now', 'review', 'later', 'backlog', 'done'];

/* Popup icons mirror the shapes in src/renderer/tabs/projects.tsx (Terminal,
 * external link, plus, chevron-down, close). Stroke-width 1.5 across the
 * board to match the rest of the icon system. KindGlyph and StepIcon are
 * imported directly from the card so there is one source of truth. */

/* Modal-head icons. Stroke-width 1.8 across the set; viewBox content
 * fills the box generously so the icon content reads at proper size
 * inside the 32 px button. */

function IconTerminal() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="1.25" y="2.25" width="13.5" height="11.5" rx="1.75" />
      <path d="M3.75 6L6.5 8 3.75 10" />
      <rect x="8" y="9.25" width="4" height="1.75" rx="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconExternal() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M5 2.5H2.5v11h11V11" />
      <path d="M9 2.5h4.5V7" />
      <path d="M13.5 2.5L7 9" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M3 3l10 10M13 3l-10 10" />
    </svg>
  );
}

function IconChevronDown() {
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
      <path d="M4 6.5l4 4 4-4" />
    </svg>
  );
}

function IconPlus() {
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
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

/** Project.path is the README path; the directory is its parent. */
function projectDir(readmePath: string): string {
  return readmePath.replace(/\/README\.md$/i, '');
}

function markerClass(m: StepMarker): string {
  if (m === ' ') return 'todo';
  if (m === '~') return 'doing';
  if (m === 'x') return 'done';
  return 'dropped';
}

/* File tree — recursive directory structure built from the flat
 * ProjectFileEntry list. README.md sits at the root with the rest of
 * the top-level files (no special "main" treatment). Each directory
 * carries its direct file children plus nested subdirectories. */
interface FileTreeDir {
  name: string;
  path: string;
  files: ProjectFileEntry[];
  subdirs: FileTreeDir[];
}

interface FileTree {
  rootFiles: ProjectFileEntry[];
  dirs: FileTreeDir[];
}

/** notes/ comes first; other dirs are alphabetical. */
function compareDirNames(a: string, b: string): number {
  if (a === 'notes') return -1;
  if (b === 'notes') return 1;
  return a.localeCompare(b);
}

function buildFileTree(files: readonly ProjectFileEntry[]): FileTree {
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
function IconFile() {
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

function IconFolder() {
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

function IconChevronRight() {
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
function FileTreeRows(props: {
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
            <button class="file-button" onClick={() => props.onOpenFile(file)} title={file.name}>
              <span class="file-row-icon">
                <IconFile />
              </span>
              <span class="file-name">{file.name}</span>
            </button>
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
        <button type="button" class="file-group-toggle" onClick={() => setOpen((v) => !v)}>
          <span class="file-group-chevron" classList={{ open: open() }}>
            <IconChevronRight />
          </span>
          <span class="file-row-icon">
            <IconFolder />
          </span>
          <span class="file-group-label">{props.dir.name}/</span>
        </button>
        <Show when={props.dir.name === 'notes' && props.onCreateNote && props.depth === 0}>
          <button
            class="file-group-add"
            onClick={props.onCreateNote}
            title="Add a new note to this project"
            aria-label="Add note"
          >
            <IconPlus />
          </button>
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

export function ProjectPreview(props: {
  project: Project | null;
  onClose: () => void;
  onToggleStep: (project: Project, step: Step) => void;
  onEditStepText: (project: Project, step: Step, newText: string) => Promise<void> | void;
  onAddStep: (project: Project, text: string) => Promise<void> | void;
  onChangeStatus: (project: Project, status: string) => void;
  onOpenReadme: (project: Project) => void;
  onOpenFile: (path: string) => void;
  onOpenInEditor: (path: string) => void;
  onOpenDeliverable: (deliverable: Deliverable) => void;
  onWorkOn: (project: Project) => void;
  onCreateNote?: (project: Project) => void;
}) {
  const [statusMenu, setStatusMenu] = createSignal(false);
  const [editingLineIndex, setEditingLineIndex] = createSignal<number | null>(null);
  const [editingText, setEditingText] = createSignal('');
  const [adding, setAdding] = createSignal(false);
  const [addText, setAddText] = createSignal('');
  const [busy, setBusy] = createSignal(false);

  const [files] = createResource(
    () => props.project?.path ?? null,
    async (path) => (path ? await window.condash.listProjectFiles(path) : []),
  );

  const handleKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      // Let the local edit/add inputs swallow Escape themselves.
      const target = event.target as HTMLElement | null;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;
      event.preventDefault();
      props.onClose();
    }
  };

  onMount(() => {
    document.addEventListener('keydown', handleKey, true);
  });
  onCleanup(() => {
    document.removeEventListener('keydown', handleKey, true);
  });

  const apps = (): string[] => {
    const raw = props.project?.apps?.trim();
    if (!raw) return [];
    return raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  };

  const statusKnown = (s: string): boolean => (KNOWN_STATUSES as readonly string[]).includes(s);

  const beginEdit = (step: Step) => {
    setEditingLineIndex(step.lineIndex);
    setEditingText(step.text);
  };

  const cancelEdit = () => {
    setEditingLineIndex(null);
    setEditingText('');
  };

  const commitEdit = async (project: Project, step: Step) => {
    const next = editingText().trim();
    if (!next || next === step.text.trim()) {
      cancelEdit();
      return;
    }
    setBusy(true);
    try {
      await props.onEditStepText(project, step, next);
    } finally {
      setBusy(false);
      cancelEdit();
    }
  };

  const beginAdd = () => {
    setAdding(true);
    setAddText('');
  };

  const cancelAdd = () => {
    setAdding(false);
    setAddText('');
  };

  const commitAdd = async (project: Project) => {
    const text = addText().trim();
    if (!text) {
      cancelAdd();
      return;
    }
    setBusy(true);
    try {
      await props.onAddStep(project, text);
    } finally {
      setBusy(false);
      cancelAdd();
    }
  };

  return (
    <Show when={props.project}>
      {(project) => (
        <div class="modal-backdrop" onClick={props.onClose}>
          <div
            class="modal project-preview"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <header class="modal-head">
              {/* Lead group: kind glyph + status select. Status is the
                  most-changed property for active projects, so it earns
                  a prominent spot at the very start of the head. */}
              <Show when={project().kind !== 'unknown'}>
                <KindGlyph kind={project().kind} />
              </Show>
              <button
                type="button"
                class="status-select"
                classList={{
                  warn: !statusKnown(project().status),
                  [`status-${project().status}`]: statusKnown(project().status),
                  open: statusMenu(),
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  setStatusMenu((v) => !v);
                }}
                title="Click to change status"
                aria-haspopup="listbox"
                aria-expanded={statusMenu()}
              >
                <Show
                  when={statusKnown(project().status)}
                  fallback={<span>!? {project().status}</span>}
                >
                  <span class="status-select-dot" aria-hidden="true" />
                  <span class="status-select-label">{project().status}</span>
                </Show>
                <span class="status-select-chevron" aria-hidden="true">
                  <IconChevronDown />
                </span>
                <Show when={statusMenu()}>
                  <div class="status-menu" role="listbox" onClick={(e) => e.stopPropagation()}>
                    <For each={STATUS_OPTIONS}>
                      {(opt) => (
                        <button
                          class="status-menu-item"
                          classList={{
                            active: project().status === opt,
                            [`status-${opt}`]: true,
                          }}
                          onClick={() => {
                            setStatusMenu(false);
                            if (project().status !== opt) props.onChangeStatus(project(), opt);
                          }}
                        >
                          <span class="status-menu-dot" aria-hidden="true" />
                          <span class="status-menu-label">{opt}</span>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </button>

              <span class="modal-title">{project().title}</span>
              <span class="modal-head-spacer" />

              {/* Steps progress mini — at-a-glance bar + X/Y, sits next
                  to the status select so the project's overall state is
                  scannable from one look at the head. Resolved =
                  done + dropped. */}
              <Show when={project().steps.length > 0}>
                {(() => {
                  const c = project().stepCounts;
                  const total = c.todo + c.doing + c.done + c.dropped;
                  const resolved = c.done + c.dropped;
                  const ratio = total === 0 ? 0 : Math.min(1, resolved / total);
                  return (
                    <span
                      class="head-progress"
                      data-complete={
                        total > 0 && c.todo === 0 && c.doing === 0 ? 'true' : undefined
                      }
                      title={`${resolved} of ${total} steps resolved`}
                    >
                      <span class="head-progress-text">
                        {resolved}/{total}
                      </span>
                      <span class="head-progress-track">
                        <span class="head-progress-fill" style={{ width: `${ratio * 100}%` }} />
                      </span>
                    </span>
                  );
                })()}
              </Show>

              <span class="head-date" title="Project date">
                {project().slug.slice(0, 10)}
              </span>

              <button
                class="modal-button work-on-button"
                onClick={() => props.onWorkOn(project())}
                title={`Paste 'work on ${project().slug}' into the focused terminal`}
                aria-label="Paste work-on command into focused terminal"
              >
                <IconTerminal />
              </button>
              <button
                class="modal-button"
                onClick={() => props.onOpenInEditor(projectDir(project().path))}
                title="Open folder in OS"
                aria-label="Open folder in OS"
              >
                <IconExternal />
              </button>
              <button
                class="modal-button modal-close"
                onClick={props.onClose}
                title="Close (Esc)"
                aria-label="Close"
              >
                <IconClose />
              </button>
            </header>

            <div class="preview-body">
              <aside class="preview-sidebar">
                <Show when={apps().length > 0}>
                  <div class="sidebar-row">
                    <span class="apps-pills">
                      <For each={apps()}>{(app) => <span class="pill">{app}</span>}</For>
                    </span>
                  </div>
                </Show>

                <Show when={project().summary}>
                  <p class="preview-summary sidebar-block">{project().summary}</p>
                </Show>

                <Show when={(files() ?? []).some((f) => f.relPath === 'README.md')}>
                  <button
                    type="button"
                    class="preview-readme-link"
                    onClick={() => props.onOpenReadme(project())}
                    title="Open README"
                  >
                    <span class="preview-readme-link-icon">
                      <IconFile />
                    </span>
                    <span class="preview-readme-link-label">README.md</span>
                    <span class="preview-readme-link-arrow" aria-hidden="true">
                      <IconChevronRight />
                    </span>
                  </button>
                </Show>

                <Show when={(files() ?? []).filter((f) => f.relPath !== 'README.md').length > 0}>
                  <section class="preview-section sidebar-block">
                    <h3 class="preview-section-head">
                      Files
                      <span class="preview-section-counts">
                        {(files() ?? []).filter((f) => f.relPath !== 'README.md').length}
                      </span>
                    </h3>
                    <ul class="files-list">
                      <FileTreeRows
                        tree={buildFileTree(
                          (files() ?? []).filter((f) => f.relPath !== 'README.md'),
                        )}
                        depth={0}
                        onOpenFile={(file) => props.onOpenFile(file.path)}
                        onCreateNote={
                          props.onCreateNote && project().kind === 'project'
                            ? () => props.onCreateNote?.(project())
                            : undefined
                        }
                      />
                    </ul>
                  </section>
                </Show>
              </aside>

              <main class="preview-main">
                <section class="preview-section">
                  <h3 class="preview-section-head">
                    Steps
                    <span class="preview-section-counts">
                      {project().stepCounts.done}/{project().steps.length}
                    </span>
                  </h3>
                  <Show
                    when={project().steps.length > 0}
                    fallback={<p class="preview-empty">No steps yet.</p>}
                  >
                    <ul class="steps-list preview-steps">
                      <For each={project().steps}>
                        {(step) => (
                          <li class={`step step-marker-${markerClass(step.marker)}`}>
                            <button
                              class="step-toggle"
                              onClick={(e) => {
                                e.stopPropagation();
                                props.onToggleStep(project(), step);
                              }}
                              title={MARKER_LABEL[step.marker]}
                            >
                              <StepIcon marker={step.marker} />
                            </button>
                            <Show
                              when={editingLineIndex() === step.lineIndex}
                              fallback={
                                <span
                                  class="step-text step-text-editable"
                                  title="Click to edit step text"
                                  onClick={() => beginEdit(step)}
                                >
                                  {step.text}
                                </span>
                              }
                            >
                              <input
                                class="step-edit-input"
                                type="text"
                                value={editingText()}
                                ref={(el) => queueMicrotask(() => el?.focus())}
                                onInput={(e) => setEditingText(e.currentTarget.value)}
                                onBlur={() => void commitEdit(project(), step)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.preventDefault();
                                    void commitEdit(project(), step);
                                  } else if (e.key === 'Escape') {
                                    e.preventDefault();
                                    cancelEdit();
                                  }
                                }}
                                disabled={busy()}
                              />
                            </Show>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                  <Show
                    when={adding()}
                    fallback={
                      <button
                        class="add-step-button"
                        onClick={beginAdd}
                        disabled={busy()}
                        title="Append a new step to ## Steps"
                      >
                        + Add step
                      </button>
                    }
                  >
                    <div class="add-step-form">
                      <span class="step-toggle-placeholder" aria-hidden="true">
                        <StepIcon marker={' '} />
                      </span>
                      <input
                        class="step-edit-input"
                        type="text"
                        placeholder="New step…"
                        value={addText()}
                        ref={(el) => queueMicrotask(() => el?.focus())}
                        onInput={(e) => setAddText(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void commitAdd(project());
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            cancelAdd();
                          }
                        }}
                        disabled={busy()}
                      />
                      <button
                        class="modal-button"
                        onClick={() => void commitAdd(project())}
                        disabled={busy() || addText().trim().length === 0}
                      >
                        Add
                      </button>
                      <button class="modal-button" onClick={cancelAdd} disabled={busy()}>
                        Cancel
                      </button>
                    </div>
                  </Show>
                </section>

                <Show when={project().deliverables.length > 0}>
                  <section class="preview-section">
                    <h3 class="preview-section-head">Deliverables</h3>
                    <ul class="deliverables-list">
                      <For each={project().deliverables}>
                        {(d) => (
                          <li class="deliverable-row">
                            <button
                              class="deliverable-button"
                              onClick={() => props.onOpenDeliverable(d)}
                              title={d.path}
                            >
                              <span class="deliverable-label">{d.label}</span>
                              <Show when={d.description}>
                                <span class="deliverable-desc">— {d.description}</span>
                              </Show>
                              <span class="deliverable-path">{d.path}</span>
                            </button>
                          </li>
                        )}
                      </For>
                    </ul>
                  </section>
                </Show>
              </main>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
