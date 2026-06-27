import { For } from 'solid-js';
import type { JSX } from 'solid-js';
import type { CardMinWidthPrefs } from '@shared/types';
import { DEFAULT_CARD_MIN_WIDTH } from '@shared/types';

/** Card-min-width fields, one per pane — shared between tabs. */
const CARD_DENSITY_FIELDS = [
  { key: 'projects', label: 'Project cards (Projects pane)', short: 'Project' },
  { key: 'code', label: 'Code cards (Code pane)', short: 'Code' },
  { key: 'knowledge', label: 'Knowledge cards (Knowledge pane)', short: 'Knowledge' },
  { key: 'resources', label: 'Resource cards (Resources pane)', short: 'Resource' },
  { key: 'skills', label: 'Skill cards (Skills pane)', short: 'Skill' },
  { key: 'logs', label: 'Log cards (Logs pane)', short: 'Log' },
  { key: 'tasks', label: 'Task cards (Tasks pane)', short: 'Task' },
  { key: 'deliverables', label: 'Deliverable cards (Deliverables pane)', short: 'Deliverable' },
] as const;

// Compile-time guard: every CardMinWidthPrefs key must have a density field
// here. Add a pane to the type without a field and `_MissingDensityField`
// becomes that key (not `never`), so this assignment fails tsc — the Settings
// UI can no longer silently fall behind the schema (the logs/tasks/deliverables
// regression).
type _MissingDensityField = Exclude<
  keyof CardMinWidthPrefs,
  (typeof CARD_DENSITY_FIELDS)[number]['key']
>;
const _assertAllDensityFieldsPresent: _MissingDensityField extends never ? true : false = true;
void _assertAllDensityFieldsPresent;

export function CardDensityFields(props: {
  resolve: (key: keyof CardMinWidthPrefs) => number;
  onChange: (patch: CardMinWidthPrefs) => void;
}): JSX.Element {
  return (
    <>
      <CardDensityPreview resolve={props.resolve} />
      <div class="settings-grid">
        <For each={CARD_DENSITY_FIELDS}>
          {(field) => (
            <label>
              <span>{field.label}</span>
              <input
                type="number"
                min="120"
                max="2400"
                step="10"
                value={props.resolve(field.key)}
                onChange={(e) => {
                  const raw = e.currentTarget.value;
                  const parsed = raw === '' ? DEFAULT_CARD_MIN_WIDTH[field.key] : Number(raw);
                  if (!Number.isFinite(parsed)) return;
                  props.onChange({ [field.key]: parsed });
                }}
              />
              <small class="settings-field-hint">
                Min width in CSS pixels. Default {DEFAULT_CARD_MIN_WIDTH[field.key]}.
              </small>
            </label>
          )}
        </For>
      </div>
    </>
  );
}

/** Renders five fake cards, one per pane, sized to the current
 *  min-width values so the user sees the relative scale before saving. */
function CardDensityPreview(props: {
  resolve: (key: keyof CardMinWidthPrefs) => number;
}): JSX.Element {
  return (
    <div class="settings-density-preview" aria-hidden="true">
      <For each={CARD_DENSITY_FIELDS}>
        {(field) => {
          const px = (): number => props.resolve(field.key);
          // Visual is half-scale so 5 cards at default 300 px all fit
          // inside the modal viewport; the on-card label still shows the
          // real px value so the relative-size intent is unambiguous.
          return (
            <div
              class="settings-density-preview-card"
              style={{ width: `${Math.round(px() / 2)}px` }}
            >
              <span class="settings-density-preview-label">{field.short}</span>
              <span class="settings-density-preview-width">{px()}px</span>
            </div>
          );
        }}
      </For>
    </div>
  );
}
