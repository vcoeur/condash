import { For, Show, createResource, createSignal, onCleanup, onMount } from 'solid-js';
import type { Deliverable, Project, ProjectFileEntry, Step, StepMarker } from '@shared/types';
import { KNOWN_STATUSES } from '@shared/types';

const MARKER_GLYPH: Record<StepMarker, string> = {
  ' ': '☐',
  '~': '◐',
  x: '☑',
  '-': '✕',
};

const MARKER_LABEL: Record<StepMarker, string> = {
  ' ': 'todo',
  '~': 'doing',
  x: 'done',
  '-': 'dropped',
};

const STATUS_OPTIONS: readonly string[] = ['now', 'review', 'soon', 'later', 'backlog', 'done'];

function markerClass(m: StepMarker): string {
  if (m === ' ') return 'todo';
  if (m === '~') return 'doing';
  if (m === 'x') return 'done';
  return 'dropped';
}

interface FileGroup {
  label: string;
  files: ProjectFileEntry[];
}

function groupFiles(files: readonly ProjectFileEntry[]): FileGroup[] {
  const top: ProjectFileEntry[] = [];
  const subdirs = new Map<string, ProjectFileEntry[]>();
  for (const file of files) {
    const slash = file.relPath.indexOf('/');
    if (slash === -1) {
      if (file.name.toLowerCase() === 'readme.md') continue;
      top.push(file);
      continue;
    }
    const dir = file.relPath.slice(0, slash);
    let bucket = subdirs.get(dir);
    if (!bucket) {
      bucket = [];
      subdirs.set(dir, bucket);
    }
    bucket.push(file);
  }

  const groups: FileGroup[] = [];
  // Show notes/ first since it's the conventional one.
  const noteOrder = (a: string, b: string): number => {
    if (a === 'notes') return -1;
    if (b === 'notes') return 1;
    return a.localeCompare(b);
  };
  const dirNames = Array.from(subdirs.keys()).sort(noteOrder);
  for (const dir of dirNames) {
    groups.push({ label: `${dir}/`, files: subdirs.get(dir)! });
  }
  if (top.length > 0) {
    groups.push({ label: 'Other files', files: top });
  }
  return groups;
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
              <span class="modal-title">{project().title}</span>
              <span class="modal-path">{project().path}</span>
              <button
                class="modal-button"
                onClick={() => props.onOpenReadme(project())}
                title="Open README"
              >
                ✎
              </button>
              <button
                class="modal-button"
                onClick={() => props.onOpenInEditor(project().path)}
                title="Open folder in OS"
              >
                ↗
              </button>
              <button class="modal-button" onClick={props.onClose} title="Close (Esc)">
                ×
              </button>
            </header>

            <div class="preview-body">
              <div class="preview-meta">
                <Show when={project().kind !== 'unknown'}>
                  <span class="badge kind-badge" data-kind={project().kind}>
                    {project().kind}
                  </span>
                </Show>

                <span
                  class="status-chip"
                  classList={{
                    warn: !statusKnown(project().status),
                    [`status-${project().status}`]: statusKnown(project().status),
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setStatusMenu((v) => !v);
                  }}
                  title="Click to change status"
                >
                  <Show
                    when={statusKnown(project().status)}
                    fallback={<span>!? {project().status}</span>}
                  >
                    {project().status}
                  </Show>
                  <span class="status-chip-arrow">▾</span>
                  <Show when={statusMenu()}>
                    <div class="status-menu" onClick={(e) => e.stopPropagation()}>
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
                            {opt}
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                </span>

                <span class="badge slug-badge">{project().slug}</span>

                <Show when={apps().length > 0}>
                  <span class="apps-pills">
                    <For each={apps()}>{(app) => <span class="pill">{app}</span>}</For>
                  </span>
                </Show>

                <Show when={project().deliverableCount > 0}>
                  <span class="badge" title="deliverables">
                    ⬇ {project().deliverableCount}
                  </span>
                </Show>
              </div>

              <Show when={project().summary}>
                <p class="preview-summary">{project().summary}</p>
              </Show>

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
                            {MARKER_GLYPH[step.marker]}
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
                    <span class="step-toggle-placeholder">☐</span>
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

              <Show when={(files() ?? []).length > 0}>
                <section class="preview-section">
                  <h3 class="preview-section-head">
                    Files
                    <span class="preview-section-counts">{(files() ?? []).length}</span>
                  </h3>
                  <ul class="files-list">
                    <li class="file-row file-row-readme">
                      <button
                        class="file-button"
                        onClick={() => props.onOpenReadme(project())}
                        title="Open README in note modal"
                      >
                        <span class="file-icon">📄</span>
                        <span class="file-name">README.md</span>
                        <span class="file-rel">main</span>
                      </button>
                    </li>
                    <For each={groupFiles(files() ?? [])}>
                      {(group) => (
                        <>
                          <li class="file-group-head">{group.label}</li>
                          <For each={group.files}>
                            {(file) => (
                              <li class="file-row">
                                <button
                                  class="file-button"
                                  onClick={() => props.onOpenFile(file.path)}
                                  title={file.path}
                                >
                                  <span class="file-icon">
                                    {file.name.toLowerCase().endsWith('.md') ? '📝' : '📎'}
                                  </span>
                                  <span class="file-name">{file.name}</span>
                                  <span class="file-rel">{file.relPath}</span>
                                </button>
                              </li>
                            )}
                          </For>
                        </>
                      )}
                    </For>
                  </ul>
                </section>
              </Show>

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
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
