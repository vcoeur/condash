import { For, Show, createSignal, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
import type { Theme } from '@shared/types';
import { THEME_PRESETS, themePreset } from '@shared/themes';

/** No `: ThemeCard[]` annotation and no `as Theme` cast — both would widen
 *  `value` back to `Theme` and make the exhaustiveness guard at the bottom of
 *  this file vacuous (`Exclude<Theme, Theme>` is always `never`). */
const CARDS = [
  {
    value: 'system',
    label: 'System',
    description: 'Follow the OS between Paper and Warm Gallery.',
  },
  ...THEME_PRESETS.map((preset) => ({
    value: preset.id,
    label: preset.label,
    description: preset.description,
  })),
] as const;

/**
 * Theme picker — one card per preset plus a System card, each painting its own
 * palette as a swatch.
 *
 * Hovering (or keyboard-focusing) a card previews that theme across the whole
 * app; leaving the picker drops the preview. Selecting a card only *stages* it —
 * like every other field here the choice is written on Save, and the hint under
 * the grid says so.
 *
 * The preview goes through `onPreview`, which sets a dedicated overlay signal in
 * `use-theme` rather than the committed theme. Two earlier attempts got this
 * wrong in instructive ways: writing `<html>` attributes directly restyled the
 * CSS chrome but left xterm and CodeMirror on the old theme, and writing the
 * *committed* signal made the hovered card render as checked (the modal reads
 * that signal back) and made the restore target go stale against a Save. An
 * overlay is neither, and restoring is just clearing it.
 *
 * The overlay is renderer-global state owned by a component that can be
 * unmounted at any moment, so **every** exit path has to clear it: pointer out,
 * focus out, and unmount (Esc-closing the modal destroys these nodes without
 * firing either DOM event).
 */
export function ThemePicker(props: {
  /** The staged selection — what the modal will write on Save. */
  current: Theme;
  /** Stage a selection (persisted on Save). */
  onChange: (theme: Theme) => void;
  /** Overlay a theme on the running UI, or `null` to drop the overlay. */
  onPreview: (theme: Theme | null) => void;
}): JSX.Element {
  const cardRefs: HTMLButtonElement[] = [];
  // Which card currently has keyboard focus, if any. Arrow keys move focus
  // without selecting, so the roving tab stop has to track this rather than the
  // staged selection — otherwise the focused card ends up `tabindex="-1"` and
  // tabbing back into the group lands somewhere else.
  const [focusedIndex, setFocusedIndex] = createSignal<number | null>(null);

  /** The card owning the group's single tab stop: the focused one while the
   *  group has focus, else the staged selection, else the first card. The last
   *  fallback matters — an unrecognised theme id (hand-edited, or written by a
   *  newer build) matches no card, and leaving every card at `-1` would make the
   *  picker unreachable by keyboard, which is exactly the state you need to get
   *  to in order to fix the bad value. */
  const tabStopIndex = (): number => {
    const focused = focusedIndex();
    if (focused !== null) return focused;
    const selected = CARDS.findIndex((card) => card.value === props.current);
    return selected === -1 ? 0 : selected;
  };

  const clearPreview = (): void => {
    setFocusedIndex(null);
    props.onPreview(null);
  };

  // Unmount is the one exit the DOM events cannot cover: removing a focused or
  // hovered node dispatches neither `focusout` nor `mouseleave`, so Esc-closing
  // the modal mid-preview would otherwise strand the whole app on a theme the
  // user never selected, with no way back except re-entering the picker.
  onCleanup(clearPreview);

  /**
   * Arrows move focus only; Space/Enter (native button activation) selects.
   *
   * WAI-ARIA allows either this or select-on-arrow for a radiogroup. Manual
   * selection is the right one here: auto-selecting would stage a draft on
   * every keypress, so merely arrowing across the cards to look at them would
   * mark the modal dirty and arm its unsaved-edits Esc gate.
   */
  const onKeyDown = (event: KeyboardEvent, index: number): void => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    cardRefs[(index + step + CARDS.length) % CARDS.length]?.focus();
  };

  /** Drop the preview only when focus leaves the grid entirely — a hop between
   *  cards (arrowing, or tabbing within) fires blur-then-focus and must not
   *  round-trip the whole app through the committed theme in between. */
  const onFocusOut = (event: FocusEvent): void => {
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget instanceof Node && event.currentTarget.contains(next)) return;
    clearPreview();
  };

  /** The pointer leaving must not cancel a *keyboard* preview: a focused card is
   *  still asserting its theme, and an incidental mouse movement across the grid
   *  would otherwise leave the focus ring on one theme and the app painted in
   *  another. */
  const onMouseLeave = (): void => {
    if (focusedIndex() !== null) return;
    clearPreview();
  };

  return (
    <div class="settings-field">
      <span class="settings-field-label">Theme</span>
      <div
        class="theme-picker"
        role="radiogroup"
        aria-label="Theme"
        onMouseLeave={onMouseLeave}
        onFocusOut={onFocusOut}
      >
        <For each={CARDS}>
          {(card, index) => (
            <button
              type="button"
              ref={(el) => (cardRefs[index()] = el)}
              role="radio"
              aria-checked={props.current === card.value}
              tabindex={tabStopIndex() === index() ? 0 : -1}
              class="theme-card"
              data-theme-id={card.value}
              classList={{ 'is-active': props.current === card.value }}
              onClick={() => props.onChange(card.value)}
              onMouseEnter={() => props.onPreview(card.value)}
              onFocus={() => {
                setFocusedIndex(index());
                props.onPreview(card.value);
              }}
              onKeyDown={(event) => onKeyDown(event, index())}
            >
              <Swatch value={card.value} />
              <span class="theme-card-label">{card.label}</span>
              <span class="theme-card-desc">{card.description}</span>
            </button>
          )}
        </For>
      </div>
      <p class="settings-field-hint">
        Hover a theme to preview it. The selected theme is applied on Save.
      </p>
    </div>
  );
}

/** Miniature of a theme's own surfaces. System has no palette of its own, so the
 *  CSS paints the two presets it chooses between. */
function Swatch(props: { value: Theme }): JSX.Element {
  const preset = () => themePreset(props.value);
  return (
    <Show
      when={preset()}
      fallback={<span class="theme-card-swatch theme-card-swatch--system" aria-hidden="true" />}
    >
      {(found) => (
        <span
          class="theme-card-swatch"
          aria-hidden="true"
          style={{ background: found().swatch[0] }}
        >
          <span class="theme-card-swatch-panel" style={{ background: found().swatch[1] }} />
          <span class="theme-card-swatch-dot" style={{ background: found().swatch[2] }} />
        </span>
      )}
    </Show>
  );
}

/** Compile-time guard: every accepted `Theme` value has a card. Load-bearing
 *  only because `CARDS` is `as const` — an annotated array would widen the
 *  literals and make this always pass. */
type _MissingThemeCard = Exclude<Theme, (typeof CARDS)[number]['value']>;
const _assertAllThemesHaveCards: _MissingThemeCard extends never ? true : false = true;
void _assertAllThemesHaveCards;
