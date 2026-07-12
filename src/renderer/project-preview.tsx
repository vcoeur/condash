import { For, Show, createResource, createSignal, onCleanup, onMount } from 'solid-js';
import type { ActionTemplate, Deliverable, Project, Step, StepMarker } from '@shared/types';
import { KNOWN_STATUSES } from '@shared/types';
import { KindGlyph, StepIcon } from './panes/projects';
import { ChevronDownIcon, IconClose, IconExternal } from './icons';
import { ActionDropdownButton } from './action-dropdown-button';
import { Button } from './actions';

const MARKER_LABEL: Record<StepMarker, string> = {
  ' ': 'todo',
  '~': 'doing',
  x: 'done',
  '!': 'blocked',
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
  if (m === '!') return 'blocked';
  return 'dropped';
}

interface ReadmeSection {
  heading: string;
  blocks: ContentBlock[];
}

type ContentBlock = { kind: 'p'; text: string } | { kind: 'ul'; items: string[] };

/** Split README markdown into `## ` sections, skipping the `## Goal` section
 * because the modal already shows its content as the goal banner. Returns the
 * remaining sections with their content broken into paragraphs and list blocks. */
function parseReadmeSections(content: string): ReadmeSection[] {
  const sections: ReadmeSection[] = [];
  let current: ReadmeSection | null = null;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.startsWith('## ')) {
      if (current) sections.push(current);
      current = { heading: line.slice(3).trim(), blocks: [] };
      continue;
    }
    if (!current) continue;

    const trimmed = line.trim();
    if (trimmed === '') {
      flushBlock(current);
      continue;
    }
    if (trimmed.startsWith('- ')) {
      flushParagraph(current);
      const last = current.blocks[current.blocks.length - 1];
      if (last?.kind === 'ul') {
        last.items.push(trimmed.slice(2).trim());
      } else {
        current.blocks.push({ kind: 'ul', items: [trimmed.slice(2).trim()] });
      }
      continue;
    }
    appendParagraph(current, trimmed);
  }
  if (current) {
    flushBlock(current);
    sections.push(current);
  }

  return sections.filter((s) => s.heading.toLowerCase() !== 'goal');
}

function appendParagraph(section: ReadmeSection, text: string) {
  const last = section.blocks[section.blocks.length - 1];
  if (last?.kind === 'p') {
    last.text += ' ' + text;
  } else {
    section.blocks.push({ kind: 'p', text });
  }
}

function flushParagraph(section: ReadmeSection) {
  const last = section.blocks[section.blocks.length - 1];
  if (last?.kind === 'p') {
    last.text = last.text.trim();
  }
}

function flushBlock(section: ReadmeSection) {
  flushParagraph(section);
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
  const [activityExpanded, setActivityExpanded] = createSignal(false);
  const [deliverablesExpanded, setDeliverablesExpanded] = createSignal(false);
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

  // The resident list drops `timeline[]` (G1 projection), so fetch the full
  // project for the Timeline pane. Cheap — `getProject` is served from the
  // main-process parse-cache (a hit right after `listProjects` populated it).
  const [fullProject] = createResource(
    () => props.project?.path ?? null,
    async (path) => (path ? await window.condash.getProject(path) : null),
  );

  const [readmeContent] = createResource(
    () => props.project?.path ?? null,
    async (path) => (path ? await window.condash.readNote(path) : ''),
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

              <span class="head-date" title="Project date">
                {project().slug.slice(0, 10)}
              </span>

              <ActionDropdownButton
                trigger={<IconTerminal />}
                triggerTitle={`Paste 'work on ${project().slug}' into the focused terminal`}
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
                class="work-on-button"
              />
              <Button
                variant="default"
                tone="open"
                class="btn--modal-head"
                onClick={() => props.onOpenInEditor(projectDir(project().path))}
                title="Open folder in OS"
                aria-label="Open folder in OS"
              >
                <IconExternal />
              </Button>
              <Button
                variant="default"
                tone="stop"
                class="btn--modal-head"
                onClick={props.onClose}
                title="Close (Esc)"
                aria-label="Close"
              >
                <IconClose />
              </Button>
            </header>

            <div class="preview-body revamped">
              <Show when={project().summary}>
                <div class="revamped-goal">
                  <div class="eyebrow">Goal</div>
                  <p>{project().summary}</p>
                </div>
              </Show>

              <div class="revamped-meta">
                <div class="revamped-meta-pills">
                  <Show when={apps().length > 0}>
                    <span class="apps-pills">
                      <For each={apps()}>{(app) => <span class="pill">{app}</span>}</For>
                    </span>
                  </Show>
                  <Show when={project().branch}>
                    <code class="meta-branch" title="Branch">
                      {project().branch}
                    </code>
                  </Show>
                </div>
                <div class="revamped-meta-actions">
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    tone="open"
                    onClick={() => props.onOpenInEditor(projectDir(project().path))}
                    title="Open project folder in OS"
                  >
                    Open directory
                  </Button>
                  <Button
                    type="button"
                    variant="default"
                    size="sm"
                    tone="open"
                    onClick={() => props.onOpenReadme(project())}
                    title="Open README"
                  >
                    README.md
                  </Button>
                </div>
              </div>

              <main class="revamped-main">
                <div class="revamped-grid">
                  <section class="widget">
                    <h3 class="widget-title">Steps</h3>
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
                        <Button
                          variant="ghost"
                          size="sm"
                          tone="add"
                          class="add-step-button"
                          onClick={beginAdd}
                          disabled={busy()}
                          title="Append a new step to ## Steps"
                        >
                          + Add step
                        </Button>
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
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => void commitAdd(project())}
                          disabled={busy() || addText().trim().length === 0}
                        >
                          Add
                        </Button>
                        <Show when={project().steps.length > 0}>
                          <Button variant="default" size="sm" onClick={cancelAdd} disabled={busy()}>
                            Cancel
                          </Button>
                        </Show>
                      </div>
                    </Show>
                    {(() => {
                      const c = project().stepCounts;
                      const total = c.todo + c.doing + c.done + c.blocked + c.dropped;
                      const resolved = c.done + c.dropped;
                      const ratio = total === 0 ? 0 : resolved / total;
                      return (
                        <Show when={total > 0}>
                          <div class="widget-progress">
                            <div style={{ width: `${ratio * 100}%` }} />
                          </div>
                        </Show>
                      );
                    })()}
                  </section>

                  <section class="widget">
                    <h3 class="widget-title">Files</h3>
                    <div class="widget-files">
                      <For each={(files() ?? []).filter((f) => f.relPath !== 'README.md')}>
                        {(file) => (
                          <button
                            type="button"
                            class="widget-file"
                            onClick={() => props.onOpenFile(file.path)}
                            title={file.relPath}
                          >
                            {file.name}
                          </button>
                        )}
                      </For>
                      <Show when={props.onCreateNote}>
                        <button
                          type="button"
                          class="widget-file add-note"
                          onClick={() => props.onCreateNote?.(project())}
                          title="Add a new note to this project"
                        >
                          + Add note
                        </button>
                      </Show>
                    </div>
                  </section>
                </div>

                <section class="widget">
                  <h3 class="widget-title">Activity</h3>
                  <div class="widget-activity">
                    {(() => {
                      const entries = () => (fullProject() ?? project()).timeline;
                      const visible = () =>
                        activityExpanded() || entries().length <= 3
                          ? entries()
                          : entries().slice(0, 3);
                      return (
                        <Show
                          when={entries().length > 0}
                          fallback={
                            <div class="widget-activity-entry">No timeline entries yet.</div>
                          }
                        >
                          <For each={visible()}>
                            {(entry) => (
                              <div class="widget-activity-entry">
                                <strong>{entry.date}</strong> — {entry.text}
                              </div>
                            )}
                          </For>
                          <Show when={entries().length > 3}>
                            <button
                              type="button"
                              class="activity-expand"
                              onClick={() => setActivityExpanded((v) => !v)}
                              aria-expanded={activityExpanded()}
                            >
                              {activityExpanded() ? 'Show less' : 'Show more'}
                            </button>
                          </Show>
                        </Show>
                      );
                    })()}
                  </div>
                </section>

                <Show when={project().deliverables.length > 0}>
                  <section class="widget">
                    <h3 class="widget-title">Deliverables</h3>
                    {(() => {
                      const entries = () => project().deliverables;
                      const visible = () =>
                        deliverablesExpanded() || entries().length <= 3
                          ? entries()
                          : entries().slice(0, 3);
                      return (
                        <>
                          <ul class="deliverables-list">
                            <For each={visible()}>
                              {(d) => (
                                <li class="deliverable-row">
                                  <Button
                                    variant="ghost"
                                    class="deliverable-button"
                                    onClick={() => props.onOpenDeliverable(d)}
                                    title={d.path}
                                  >
                                    <span class="deliverable-label">{d.label}</span>
                                    <Show when={d.description}>
                                      <span class="deliverable-desc">— {d.description}</span>
                                    </Show>
                                    <span class="deliverable-path">{d.path}</span>
                                  </Button>
                                </li>
                              )}
                            </For>
                          </ul>
                          <Show when={entries().length > 3}>
                            <button
                              type="button"
                              class="activity-expand"
                              onClick={() => setDeliverablesExpanded((v) => !v)}
                              aria-expanded={deliverablesExpanded()}
                            >
                              {deliverablesExpanded() ? 'Show less' : 'Show more'}
                            </button>
                          </Show>
                        </>
                      );
                    })()}
                  </section>
                </Show>

                {(() => {
                  const sections = () => parseReadmeSections(readmeContent() ?? '');
                  return (
                    <Show when={sections().length > 0}>
                      <section class="widget readme-widget">
                        <h3 class="widget-title">README</h3>
                        <div class="readme-body">
                          <For each={sections()}>
                            {(section) => (
                              <div class="readme-section">
                                <h4 class="readme-heading">{section.heading}</h4>
                                <div class="readme-content">
                                  <For each={section.blocks}>
                                    {(block) => {
                                      if (block.kind === 'ul') {
                                        return (
                                          <ul>
                                            <For each={block.items}>
                                              {(item) => <li>{item}</li>}
                                            </For>
                                          </ul>
                                        );
                                      }
                                      return <p>{block.text}</p>;
                                    }}
                                  </For>
                                </div>
                              </div>
                            )}
                          </For>
                        </div>
                      </section>
                    </Show>
                  );
                })()}
              </main>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
