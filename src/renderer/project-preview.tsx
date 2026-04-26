import { For, Show, createSignal, onCleanup, onMount } from 'solid-js';
import type { Deliverable, Project, Step, StepMarker } from '@shared/types';
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

export function ProjectPreview(props: {
  project: Project | null;
  onClose: () => void;
  onToggleStep: (project: Project, step: Step) => void;
  onChangeStatus: (project: Project, status: string) => void;
  onOpenReadme: (project: Project) => void;
  onOpenInEditor: (path: string) => void;
  onOpenDeliverable: (deliverable: Deliverable) => void;
}) {
  const [statusMenu, setStatusMenu] = createSignal(false);

  const handleKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
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

              <Show when={project().steps.length > 0}>
                <section class="preview-section">
                  <h3 class="preview-section-head">
                    Steps
                    <span class="preview-section-counts">
                      {project().stepCounts.done}/{project().steps.length}
                    </span>
                  </h3>
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
                          <span class="step-text">{step.text}</span>
                        </li>
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
