import { For, Show, createSignal } from 'solid-js';
import type { Project } from '@shared/types';
import { dateRangeLabel } from '../panes/projects';
import { Caret } from '../icons';

/** Full-width band pinned to the bottom of the popup. Collapsed by default
 * — the pane is meta information, the popup's primary job is the editable
 * fields above. Header reads `Timeline <first> – <last>` (or `Timeline
 * <date>` when first == last; `Timeline (empty)` when the README has no
 * `## Timeline` section). Expanded body lists each entry on its own row.
 * Read-only this iteration. */
export function TimelinePane(props: { project: Project }) {
  const [open, setOpen] = createSignal(false);
  const entries = (): Project['timeline'] => props.project.timeline ?? [];
  const headerLabel = (): string =>
    entries().length === 0 ? 'Timeline (empty)' : `Timeline ${dateRangeLabel(props.project)}`;
  return (
    <section class="preview-timeline" classList={{ collapsed: !open() }}>
      <button
        type="button"
        class="preview-timeline-toggle"
        onClick={() => setOpen((v) => !v)}
        title={open() ? 'Collapse timeline' : 'Expand timeline'}
        aria-expanded={open()}
      >
        <Caret expanded={open()} />
        <span class="preview-timeline-label">{headerLabel()}</span>
        <Show when={entries().length > 0}>
          <span class="preview-timeline-count">{entries().length}</span>
        </Show>
      </button>
      <Show when={open()}>
        <ul class="preview-timeline-list">
          <Show
            when={entries().length > 0}
            fallback={
              <li class="preview-timeline-empty">No `## Timeline` section in this README.</li>
            }
          >
            <For each={entries()}>
              {(entry) => (
                <li class="preview-timeline-entry">
                  <span class="preview-timeline-date">{entry.date}</span>
                  <span class="preview-timeline-text">{entry.text}</span>
                </li>
              )}
            </For>
          </Show>
        </ul>
      </Show>
    </section>
  );
}
