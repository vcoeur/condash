import { Show, type JSX } from 'solid-js';
import type { RawRepo } from '@shared/config-types';
import type { BindTextFn, DndHandlers } from './data';
import { Button } from '../actions';

/**
 * One row in the repositories list that is a `{ section: "…" }` marker — a
 * heading that groups every following repo into a labelled bucket in the
 * Settings modal AND in the Code pane. Visually compact: a single text input
 * styled as a heading, plus the same up/down/remove controls a repo row has.
 */
export function SectionRow(props: {
  entry: { section: string };
  idPrefix: string;
  index: number;
  total: number;
  bindText: BindTextFn;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  onPatch: (next: RawRepo) => Promise<void>;
  dnd?: DndHandlers;
}): JSX.Element {
  return (
    <div
      class="settings-repo-row settings-repo-row--section"
      classList={{
        'settings-repo-row--dragging': props.dnd?.isDragging(props.index) ?? false,
        'settings-repo-row--drop-target': props.dnd?.isDropTarget(props.index) ?? false,
      }}
      draggable={props.dnd ? true : undefined}
      onDragStart={(e) => {
        if (!props.dnd) return;
        e.dataTransfer?.setData('text/plain', String(props.index));
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        props.dnd.onDragStart(props.index);
      }}
      onDragOver={(e) => {
        if (!props.dnd) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        props.dnd.onDragOver(props.index);
      }}
      onDrop={(e) => {
        if (!props.dnd) return;
        e.preventDefault();
        props.dnd.onDrop(props.index);
      }}
      onDragEnd={() => props.dnd?.onDragEnd()}
    >
      <div class="settings-repo-row-head">
        <Show when={props.dnd}>
          <span class="settings-repo-drag-handle" title="Drag to reorder" aria-hidden="true">
            ⋮⋮
          </span>
        </Show>
        <span class="settings-repo-section-marker" aria-hidden="true">
          §
        </span>
        <input
          type="text"
          class="settings-repo-section-name"
          placeholder="Section heading"
          {...props.bindText(
            `${props.idPrefix}.section`,
            () => props.entry.section,
            (v) => props.onPatch({ section: v }),
          )}
        />
        <Button
          variant="default"
          class="btn--modal-head"
          title="Move up"
          disabled={props.index === 0}
          onClick={() => props.onMove(-1)}
        >
          ↑
        </Button>
        <Button
          variant="default"
          class="btn--modal-head"
          title="Move down"
          disabled={props.index === props.total - 1}
          onClick={() => props.onMove(1)}
        >
          ↓
        </Button>
        <Button
          variant="default"
          class="btn--modal-head"
          title="Remove section"
          onClick={() => props.onRemove()}
        >
          ×
        </Button>
      </div>
    </div>
  );
}
