import { Show, type JSX } from 'solid-js';
import type { RawConfig } from './data';

export type InheritanceState = 'inherits' | 'overridden' | 'matches';

/**
 * Compute the inheritance state of a top-level conception key relative to
 * the global settings.json value. Three states drive the badge label and
 * the Remove-override button visibility on the conception tab:
 *
 *   - `inherits`  — key is absent from `condash.json`. The effective value
 *     comes straight from `settings.json`.
 *   - `overridden` — key is present and the value differs from the global
 *     one. The override is doing real work.
 *   - `matches` — key is present but the value is identical to the global
 *     one. The override is redundant; surface a "Remove override" button.
 *
 * Comparison uses `JSON.stringify` over a key-sorted object — sufficient
 * for the conception-overridable shapes (strings, numbers, arrays of
 * strings, repository entries, simple objects). For deep-nested
 * `terminal.xterm.colors` we still compare the whole `terminal` object as
 * one unit, which matches the schema's "objects replace whole" rule.
 */
export function inheritanceState<K extends keyof RawConfig>(
  key: K,
  global: RawConfig,
  conception: RawConfig,
): InheritanceState {
  const conceptionHas = Object.prototype.hasOwnProperty.call(conception, key);
  if (!conceptionHas) return 'inherits';
  const globalValue = global[key];
  const conceptionValue = conception[key];
  return stableEqual(globalValue, conceptionValue) ? 'matches' : 'overridden';
}

/** Stable JSON-based deep equality. Object keys are sorted recursively so
 *  the same logical shape always serialises identically. */
export function stableEqual(a: unknown, b: unknown): boolean {
  return canonicalise(a) === canonicalise(b);
}

function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalise).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(',')}}`;
}

/**
 * Pill rendered next to a conception-tab field showing whether the
 * conception is inheriting, overriding, or redundantly matching the global
 * value. Three CSS variants — see `modals.css` `.settings-badge--*`.
 */
export function InheritanceBadge(props: { state: InheritanceState }): JSX.Element {
  return (
    <span
      class="settings-badge"
      classList={{
        'settings-badge--inherits': props.state === 'inherits',
        'settings-badge--overridden': props.state === 'overridden',
        'settings-badge--matches': props.state === 'matches',
      }}
      aria-label={badgeAriaLabel(props.state)}
      title={badgeTitle(props.state)}
    >
      {badgeLabel(props.state)}
    </span>
  );
}

function badgeLabel(state: InheritanceState): string {
  switch (state) {
    case 'inherits':
      return 'Inherits';
    case 'overridden':
      return 'Overridden';
    case 'matches':
      return 'Matches global';
  }
}

function badgeAriaLabel(state: InheritanceState): string {
  switch (state) {
    case 'inherits':
      return 'Inheriting the global value from settings.json';
    case 'overridden':
      return 'Overriding the global value';
    case 'matches':
      return 'Override matches the global value — redundant';
  }
}

function badgeTitle(state: InheritanceState): string {
  switch (state) {
    case 'inherits':
      return 'No override in condash.json — value comes from settings.json.';
    case 'overridden':
      return 'condash.json overrides settings.json for this key.';
    case 'matches':
      return 'condash.json sets this key to the same value as settings.json — the override is redundant. Remove it to fall back to inheritance.';
  }
}

/**
 * Inline button surfaced on the conception tab when a field is in the
 * `overridden` or `matches` state. Clicking it deletes the key from
 * `condash.json`, dropping back to inheritance.
 */
export function RemoveOverrideButton(props: {
  state: InheritanceState;
  onRemove: () => void;
  /** Optional one-line override of the default tooltip. */
  title?: string;
}): JSX.Element {
  return (
    <Show when={props.state !== 'inherits'}>
      <button
        type="button"
        class="modal-button settings-remove-override"
        onClick={props.onRemove}
        title={props.title ?? defaultRemoveTitle(props.state)}
      >
        {props.state === 'matches' ? 'Remove override' : 'Reset to global'}
      </button>
    </Show>
  );
}

function defaultRemoveTitle(state: InheritanceState): string {
  return state === 'matches'
    ? 'Remove the redundant override from condash.json'
    : 'Drop this override and inherit the global value';
}

/**
 * Composite header used at the top of every conception-tab field group:
 * label + badge + (optional) Remove-override button laid out on one row.
 */
export function FieldBadgeRow(props: {
  state: InheritanceState;
  onRemove: () => void;
  /** Set to true on the global tab where badges are not rendered. */
  hide?: boolean;
}): JSX.Element {
  return (
    <Show when={!props.hide}>
      <span class="settings-field-badges">
        <InheritanceBadge state={props.state} />
        <RemoveOverrideButton state={props.state} onRemove={props.onRemove} />
      </span>
    </Show>
  );
}
