import { For, Show } from 'solid-js';
import type { Deliverable, Project } from '@shared/types';
import './outputs-pane.css';
import { usePaneScrollMemory } from './pane-scroll-memory';

const KNOWN_STATUSES = ['now', 'review', 'later', 'backlog', 'done'];

/** Coarse type tag shown next to each deliverable, derived from its target.
 *  http(s) links are URLs; everything else is keyed off the extension. */
function deliverableKind(path: string): string {
  if (/^https?:\/\//i.test(path)) return 'url';
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'].includes(ext)) return 'image';
  return 'file';
}

/**
 * Outputs pane — aggregates every project's `## Deliverables` across the whole
 * conception, grouped by project (newest first). Parse-only: it consumes the
 * already-loaded projects list rather than scanning the filesystem.
 */
export function OutputsView(props: {
  projects: Project[];
  onOpenDeliverable: (deliverable: Deliverable) => void;
}) {
  const scrollRef = usePaneScrollMemory('outputs');

  // Slug starts with the ISO date, so a descending slug sort is newest-first.
  const groups = (): Project[] =>
    props.projects
      .filter((project) => project.deliverables.length > 0)
      .slice()
      .sort((a, b) => b.slug.localeCompare(a.slug));

  const totalItems = (): number =>
    groups().reduce((sum, project) => sum + project.deliverables.length, 0);

  return (
    <div class="outputs-stack" ref={scrollRef}>
      <Show
        when={groups().length > 0}
        fallback={
          <div class="outputs-empty">
            No project outputs yet — link artifacts under a project's
            <code>## Deliverables</code>.
          </div>
        }
      >
        <div class="outputs-head">
          {groups().length} {groups().length === 1 ? 'project' : 'projects'} · {totalItems()}{' '}
          {totalItems() === 1 ? 'item' : 'items'}
        </div>
        <For each={groups()}>
          {(project) => (
            <details class="outputs-group" open>
              <summary class="outputs-group-head">
                <span class="outputs-caret" aria-hidden="true" />
                <span class="outputs-group-title">{project.title}</span>
                <span
                  class="outputs-status"
                  data-status={KNOWN_STATUSES.includes(project.status) ? project.status : '?'}
                >
                  {project.status}
                </span>
                <span class="outputs-group-date">{project.slug.slice(0, 10)}</span>
              </summary>
              <ul class="deliverables-list outputs-deliverables">
                <For each={project.deliverables}>
                  {(deliverable) => (
                    <li class="deliverable-row">
                      <button
                        class="deliverable-button"
                        onClick={() => props.onOpenDeliverable(deliverable)}
                        title={deliverable.path}
                      >
                        <span class="outputs-kind" data-kind={deliverableKind(deliverable.path)}>
                          {deliverableKind(deliverable.path)}
                        </span>
                        <span class="deliverable-label">{deliverable.label}</span>
                        <Show when={deliverable.description}>
                          <span class="deliverable-desc">— {deliverable.description}</span>
                        </Show>
                        <span class="deliverable-path">{deliverable.path}</span>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </details>
          )}
        </For>
      </Show>
    </div>
  );
}
