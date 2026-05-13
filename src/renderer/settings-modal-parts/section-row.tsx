import type { JSX } from 'solid-js';
import type { RawRepo } from '../../main/config-schema';
import type { BindTextFn } from './data';

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
}): JSX.Element {
  return (
    <div class="settings-repo-row settings-repo-row--section">
      <div class="settings-repo-row-head">
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
        <button
          class="modal-button"
          title="Move up"
          disabled={props.index === 0}
          onClick={() => props.onMove(-1)}
        >
          ↑
        </button>
        <button
          class="modal-button"
          title="Move down"
          disabled={props.index === props.total - 1}
          onClick={() => props.onMove(1)}
        >
          ↓
        </button>
        <button class="modal-button" title="Remove section" onClick={() => props.onRemove()}>
          ×
        </button>
      </div>
    </div>
  );
}
