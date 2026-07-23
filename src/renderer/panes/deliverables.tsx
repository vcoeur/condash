import { For, Show } from 'solid-js';
import type { Deliverable, Project } from '@shared/types';
import './deliverables-pane.css';
import { Caret } from '../icons';
import { usePaneScrollMemory } from './pane-scroll-memory';

const KNOWN_STATUSES = ['now', 'review', 'later', 'backlog', 'done'];

/** Coarse type tag shown next to each deliverable. Wikilinks and URLs key off
 *  `kind`; local files key off the extension. */
function deliverableKind(deliverable: Deliverable): string {
  if (deliverable.kind === 'wikilink') return 'wiki';
  if (deliverable.kind === 'url') return 'url';
  const ext = deliverable.path.slice(deliverable.path.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'].includes(ext)) return 'image';
  return 'file';
}

/** Kind → shared `.file-glyph` colour category (primitives.css), so a pdf
 *  deliverable wears the same colour as a pdf resource. */
function glyphCategory(kind: string): string {
  return kind === 'md' ? 'markdown' : kind;
}

/**
 * Deliverables pane — aggregates every project's `## Deliverables` across the
 * whole conception, grouped by project (newest first). Parse-only: it consumes
 * the already-loaded projects list rather than scanning the filesystem.
 */
export function DeliverablesView(props: {
  projects: Project[];
  onOpenDeliverable: (deliverable: Deliverable) => void;
  /** Reveal a local-file deliverable in the OS file manager. */
  onReveal: (path: string) => void;
}) {
  const scrollRef = usePaneScrollMemory('deliverables');

  // Slug starts with the ISO date, so a descending slug sort is newest-first.
  const groups = (): Project[] =>
    props.projects
      .filter((project) => project.deliverables.length > 0)
      .slice()
      .sort((a, b) => b.slug.localeCompare(a.slug));

  const totalItems = (): number =>
    groups().reduce((sum, project) => sum + project.deliverables.length, 0);

  return (
    <div class="deliverables-stack" ref={scrollRef}>
      <Show
        when={groups().length > 0}
        fallback={
          <div class="deliverables-empty pane-empty">
            No deliverables yet — link artifacts under a project's
            <code>## Deliverables</code>.
          </div>
        }
      >
        <div class="deliverables-head">
          {groups().length} {groups().length === 1 ? 'project' : 'projects'} · {totalItems()}{' '}
          {totalItems() === 1 ? 'item' : 'items'}
        </div>
        <For each={groups()}>
          {(project) => (
            <details class="deliverables-group" open>
              <summary class="deliverables-group-head">
                <Caret />
                <span class="deliverables-group-title">{project.title}</span>
                <span
                  class="status-pill"
                  data-status={KNOWN_STATUSES.includes(project.status) ? project.status : '?'}
                >
                  {project.status}
                </span>
                <span class="deliverables-group-date">{project.slug.slice(0, 10)}</span>
              </summary>
              <ul class="deliverables-rows card-grid">
                <For each={project.deliverables}>
                  {(deliverable) => {
                    const kind = deliverableKind(deliverable);
                    return (
                      <li class="deliverable-row card">
                        <button
                          class="deliverable-button"
                          onClick={() => props.onOpenDeliverable(deliverable)}
                          title={deliverable.path}
                        >
                          <span class="deliverable-head">
                            <span
                              class="deliverables-kind file-glyph"
                              data-kind={kind}
                              data-cat={glyphCategory(kind)}
                            >
                              {kind}
                            </span>
                            <span class="deliverable-label">{deliverable.label}</span>
                          </span>
                          <Show when={deliverable.description}>
                            <span class="deliverable-desc">{deliverable.description}</span>
                          </Show>
                          <span class="deliverable-path">
                            {deliverable.kind === 'wikilink'
                              ? `[[${deliverable.path}]]`
                              : deliverable.path}
                          </span>
                        </button>
                        <Show when={deliverable.kind === 'file'}>
                          <button
                            type="button"
                            class="deliverable-reveal card-reveal"
                            title="Reveal in file manager"
                            aria-label="Reveal in file manager"
                            onClick={() => props.onReveal(deliverable.path)}
                          >
                            ⤷
                          </button>
                        </Show>
                      </li>
                    );
                  }}
                </For>
              </ul>
            </details>
          )}
        </For>
      </Show>
    </div>
  );
}
