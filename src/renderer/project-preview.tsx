import { For, Show, createResource, createSignal, onCleanup, onMount } from 'solid-js';
import type { ActionTemplate, Deliverable, Project, Step, StepMarker } from '@shared/types';
import { KNOWN_STATUSES } from '@shared/types';
import { KindGlyph, StepIcon } from './panes/projects';
import { ChevronDownIcon, IconClose, IconExternal } from './icons';
import { ActionSplitButton } from './action-split-button';
import {
  buildFileTree,
  FileTreeRows,
  IconChevronRight,
  IconFile,
} from './project-preview-parts/file-tree';
import { TimelinePane } from './project-preview-parts/timeline';

const MARKER_LABEL: Record<StepMarker, string> = {
  ' ': 'todo',
  '~': 'doing',
  x: 'done',
  '-': 'dropped',
};

const STATUS_OPTIONS: readonly string[] = ['now', 'review', 'later', 'backlog', 'done'];

/* Modal-head terminal icon. Stroke-width 1.8 across the set; viewBox content
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
  projectActions?: ActionTemplate[];
  onProjectAction?: (project: Project, action: ActionTemplate) => void;
  onCreateNote?: (project: Project) => void;
}) {
  const [statusMenu, setStatusMenu] = createSignal(false);
  const [editingLineIndex, setEditingLineIndex] = createSignal<number | null>(null);
  const [editingText, setEditingText] = createSignal('');
  const [adding, setAdding] = createSignal(false);
  const [addText, setAddText] = createSignal('');
  const [busy, setBusy] = createSignal(false);

  // When a project has no steps yet, expose the new-step input row directly
  // instead of hiding it behind a "+ Add step" button — the empty section
  // is a strong signal the user wants to add one (#88).
  const showAddForm = () => adding() || (props.project?.steps.length ?? 0) === 0;

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

  const apps = (): string[] => props.project?.apps ?? [];

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
                  <ChevronDownIcon />
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

              <ActionSplitButton
                primary={<IconTerminal />}
                primaryTitle={`Paste 'work on ${project().slug}' into the focused terminal`}
                onPrimary={() => props.onWorkOn(project())}
                defaultLabel={`Work on ${project().slug.replace(/^\d{4}-\d{2}-\d{2}-/, '')}`}
                items={props.projectActions ?? []}
                onItem={(idx) => {
                  if (idx === -1) {
                    props.onWorkOn(project());
                  } else {
                    const action = props.projectActions?.[idx];
                    if (action) props.onProjectAction?.(project(), action);
                  }
                }}
                class="modal-button work-on-button"
              />
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

                <Show
                  when={
                    (files() ?? []).filter((f) => f.relPath !== 'README.md').length > 0 ||
                    !!props.onCreateNote
                  }
                >
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
                          { ensureNotesDir: !!props.onCreateNote },
                        )}
                        depth={0}
                        onOpenFile={(file) => props.onOpenFile(file.path)}
                        onCreateNote={
                          props.onCreateNote ? () => props.onCreateNote?.(project()) : undefined
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
                    when={showAddForm()}
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
                      <Show when={project().steps.length > 0}>
                        <button class="modal-button" onClick={cancelAdd} disabled={busy()}>
                          Cancel
                        </button>
                      </Show>
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

            <TimelinePane project={project()} />
          </div>
        </div>
      )}
    </Show>
  );
}
