import { For } from 'solid-js';
import type { JSX } from 'solid-js';
import type { Theme } from '@shared/types';
import { THEME_PRESETS } from '@shared/themes';

interface ThemeCard {
  value: Theme;
  label: string;
  description: string;
}

const CARDS: ThemeCard[] = [
  {
    value: 'system',
    label: 'System',
    description: 'Follow the OS between Paper and Warm Gallery.',
  },
  ...THEME_PRESETS.map((preset) => ({
    value: preset.id as Theme,
    label: preset.label,
    description: preset.description,
  })),
];

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
 * `use-theme` rather than the committed theme. Two reasons, both learned the
 * hard way: writing `<html>` attributes directly restyled the CSS chrome but
 * left xterm, CodeMirror and mermaid on the old theme, while writing the
 * *committed* signal made the hovered card render as checked (`globalTheme()`
 * falls back to it) and made the restore target move while previewing. An
 * overlay is neither — and since restoring is just "clear the overlay", there is
 * no captured target to go stale against an in-modal Save.
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

  /** The card that owns the group's single tab stop. Falls back to the first
   *  card when the staged value matches none — a hand-edited or newer-build
   *  theme id would otherwise leave every card at `-1`, making the picker
   *  unreachable by keyboard, which is exactly the value you need to fix. */
  const tabStopIndex = (): number => {
    const index = CARDS.findIndex((card) => card.value === props.current);
    return index === -1 ? 0 : index;
  };

  /**
   * Arrows move focus only; Space/Enter (native button activation) selects.
   *
   * WAI-ARIA allows either this or select-on-arrow for a radiogroup. Manual
   * selection is the right one here: auto-selecting would stage a draft on
   * every keypress, so merely arrowing across the four cards to look at them
   * would mark the modal dirty and arm its unsaved-edits Esc gate.
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

  /** Drop the preview only when focus/pointer leaves the grid entirely. Per-card
   *  handlers fired on every hop between cards — crossing the 10px gap, or
   *  arrowing from one card to the next (blur-then-focus) — which round-tripped
   *  the whole app through the committed theme twice per step. */
  const onFocusOut = (event: FocusEvent): void => {
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget instanceof Node && event.currentTarget.contains(next)) return;
    props.onPreview(null);
  };

  return (
    <div class="settings-field">
      <span class="settings-field-label">Theme</span>
      <div
        class="theme-picker"
        role="radiogroup"
        aria-label="Theme"
        onMouseLeave={() => props.onPreview(null)}
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
              onFocus={() => props.onPreview(card.value)}
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
  const preset = (): (typeof THEME_PRESETS)[number] | undefined =>
    THEME_PRESETS.find((entry) => entry.id === props.value);
  return (
    <>
      {preset() ? (
        <span
          class="theme-card-swatch"
          aria-hidden="true"
          style={{ background: preset()!.swatch[0] }}
        >
          <span class="theme-card-swatch-panel" style={{ background: preset()!.swatch[1] }} />
          <span class="theme-card-swatch-dot" style={{ background: preset()!.swatch[2] }} />
        </span>
      ) : (
        <span class="theme-card-swatch theme-card-swatch--system" aria-hidden="true" />
      )}
    </>
  );
}

/** Compile-time guard: every accepted `Theme` value has a card. */
type _MissingThemeCard = Exclude<Theme, (typeof CARDS)[number]['value']>;
const _assertAllThemesHaveCards: _MissingThemeCard extends never ? true : false = true;
void _assertAllThemesHaveCards;
