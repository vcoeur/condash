import { For, Show, createEffect, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
import type { Theme } from '@shared/types';
import { SYSTEM_PAIR, THEME_PRESETS, themePreset } from '@shared/themes';

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
 * **Selecting a theme previews it**: the staged selection is applied to the
 * running app immediately, and closing the modal without saving puts the
 * committed theme back. Save persists it like every other field here.
 *
 * There is deliberately no *hover* preview. Four attempts at one all failed the
 * same way: the overlay is renderer-global state driven by two independent
 * inputs (pointer position and focus position) whose precedence has no correct
 * answer. Making focus win stranded the hovered card's theme and stopped hover
 * previewing entirely once a click had pinned focus; making hover win cancelled
 * keyboard previews on an incidental mouse movement; and the pointer has states
 * — resting on the grid's gutter, or over a card that scrolled away — that emit
 * no event at all. Driving the preview from the one thing the user has actually
 * asserted (the selection) removes every one of those cases, and still answers
 * "let me see what this theme looks like": clicking or arrowing to a card shows
 * it across the whole app, with no commitment until Save.
 */
export function ThemePicker(props: {
  /** The staged selection — what the modal will write on Save, and what the
   *  running app is previewing meanwhile. */
  current: Theme;
  /** Stage a selection (persisted on Save). */
  onChange: (theme: Theme) => void;
  /** Overlay a theme on the running UI, or `null` to drop the overlay. */
  onPreview: (theme: Theme | null) => void;
}): JSX.Element {
  const cardRefs: HTMLButtonElement[] = [];

  // The staged selection *is* the preview. On mount it equals the theme already
  // in force, so this is a no-op until the user picks something.
  createEffect(() => props.onPreview(props.current));

  // Every way out of this component — Save, Cancel, Esc, the modal being torn
  // down from elsewhere — ends here. Dropping the overlay reveals the committed
  // theme underneath: correct after a Save (the commit already moved it) and
  // correct after a cancel (the staged pick was never persisted).
  onCleanup(() => props.onPreview(null));

  /** The card owning the group's single tab stop. Falls back to the first card
   *  when the staged value matches none — an unrecognised theme id (hand-edited,
   *  or written by a newer build) would otherwise leave every card at `-1`,
   *  making the picker unreachable by keyboard, which is exactly the state you
   *  need to get to in order to fix the bad value. */
  const tabStopIndex = (): number => {
    const selected = CARDS.findIndex((card) => card.value === props.current);
    return selected === -1 ? 0 : selected;
  };

  /** Arrow keys move focus *and* select, the standard radiogroup behaviour.
   *  Selecting is no longer a hidden cost: it is what previews the theme, so
   *  arrowing across the cards is the keyboard equivalent of looking at each
   *  one. The modal going dirty is honest — the selection really did change. */
  const onKeyDown = (event: KeyboardEvent, index: number): void => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + CARDS.length) % CARDS.length;
    cardRefs[next]?.focus();
    select(CARDS[next].value);
  };

  /** Stage a selection, but only when it actually differs. `<input
   *  type="radio">` never fired `onChange` for the already-checked option; a
   *  `<button>`'s `onClick` always fires, so without this guard re-picking the
   *  active card (a click to confirm, or arrowing away and back) stages a draft,
   *  lights the dirty pip, and makes Escape raise the "Discard and close" gate
   *  for a change that does not exist. */
  const select = (next: Theme): void => {
    if (next !== props.current) props.onChange(next);
  };

  return (
    <div class="settings-field">
      <span class="settings-field-label">Theme</span>
      <div class="theme-picker" role="radiogroup" aria-label="Theme">
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
              onClick={() => select(card.value)}
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
        Selecting a theme applies it straight away. Save to keep it — closing without saving puts
        the current theme back.
      </p>
    </div>
  );
}

/** Miniature of a theme's own surfaces. System has no palette of its own, so it
 *  renders a split of the two presets it chooses between — built from the same
 *  registry swatches as every other card, so re-colouring a preset (or
 *  repointing `SYSTEM_PAIR`) can never leave this one painting stale hexes. */
function Swatch(props: { value: Theme }): JSX.Element {
  const preset = () => themePreset(props.value);
  const systemGradient = (): string => {
    // Non-null: SYSTEM_PAIR only ever names ids that exist in THEME_PRESETS.
    const light = themePreset(SYSTEM_PAIR.light)!.swatch[0];
    const dark = themePreset(SYSTEM_PAIR.dark)!.swatch[0];
    return `linear-gradient(115deg, ${light} 0%, ${light} 50%, ${dark} 50%, ${dark} 100%)`;
  };
  return (
    <Show
      when={preset()}
      fallback={
        <span
          class="theme-card-swatch theme-card-swatch--system"
          aria-hidden="true"
          style={{ background: systemGradient() }}
        />
      }
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
