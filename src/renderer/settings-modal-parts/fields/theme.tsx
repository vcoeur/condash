import { For, createSignal, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
import type { Theme } from '@shared/types';
import { THEME_PRESETS, THEME_VALUES } from '@shared/themes';

/**
 * Theme picker — one card per preset plus a System card, each painting its own
 * palette as a swatch. Shared between the Global and Conception tabs.
 *
 * Hovering (or keyboard-focusing) a card previews that theme across the whole
 * app; leaving the picker restores the theme in force. Selecting a card only
 * *stages* it — like every other field here, the choice is written on Save, and
 * the hint under the grid says so.
 *
 * The preview goes through `onPreview` (the app's own theme setter) rather than
 * poking `<html>` directly. The attributes alone would restyle the CSS-driven
 * chrome while leaving every JS-side consumer behind — xterm reads its palette
 * from the computed tokens on refresh, CodeMirror takes a boolean `dark` prop,
 * and mermaid bakes its theme at init — so a "preview" would show a dark app
 * containing a white terminal and a light-themed editor.
 */
export function ThemePicker(props: {
  /** The staged selection — what the modal will write on Save. */
  current: Theme;
  /** The theme actually in force. Read once, at mount: `onPreview` moves it, so
   *  reading it live would make the restore target follow the preview. */
  applied: Theme;
  /** Stage a selection (persisted on Save). */
  onChange: (theme: Theme) => void;
  /** Apply a theme to the running UI without persisting it. */
  onPreview: (theme: Theme) => void;
}): JSX.Element {
  // The theme to put back when the pointer leaves. Captured at mount so a
  // preview can't move the target; `props.applied` is not read again.
  const inForce = props.applied;
  const [previewing, setPreviewing] = createSignal(false);

  const preview = (theme: Theme): void => {
    setPreviewing(true);
    props.onPreview(theme);
  };

  // Restoring on leave — rather than on unmount unconditionally — is what keeps
  // this race-free with Save: clicking Save means the pointer already left the
  // grid, so `previewing` is false and the saved theme is left alone.
  const restore = (): void => {
    if (!previewing()) return;
    setPreviewing(false);
    props.onPreview(inForce);
  };

  // Esc can close the modal with the pointer still resting on a card, which
  // would otherwise strand the preview as the live theme.
  onCleanup(restore);

  /** Roving tabindex: the checked card is the group's single tab stop, and the
   *  arrow keys move between cards — the semantics native radios gave for free
   *  before this became a grid of buttons. */
  const onKeyDown = (event: KeyboardEvent, index: number): void => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + THEME_VALUES.length) % THEME_VALUES.length;
    const target = event.currentTarget as HTMLElement;
    const card = target.parentElement?.children[next] as HTMLElement | undefined;
    card?.focus();
    const value = THEME_VALUES[next];
    if (value !== undefined) props.onChange(value);
  };

  const cards = (): { value: Theme; label: string; description: string; index: number }[] => [
    {
      value: 'system',
      label: 'System',
      description: 'Follow the OS between Paper and Warm Gallery.',
      index: 0,
    },
    ...THEME_PRESETS.map((preset, offset) => ({
      value: preset.id as Theme,
      label: preset.label,
      description: preset.description,
      index: offset + 1,
    })),
  ];

  const swatchFor = (value: Theme): JSX.Element => {
    const preset = THEME_PRESETS.find((entry) => entry.id === value);
    if (!preset) {
      // System has no palette of its own — the CSS paints the two it picks between.
      return <span class="theme-card-swatch theme-card-swatch--system" aria-hidden="true" />;
    }
    return (
      <span class="theme-card-swatch" aria-hidden="true" style={{ background: preset.swatch[0] }}>
        <span class="theme-card-swatch-panel" style={{ background: preset.swatch[1] }} />
        <span class="theme-card-swatch-dot" style={{ background: preset.swatch[2] }} />
      </span>
    );
  };

  return (
    <div class="settings-field">
      <span class="settings-field-label">Theme</span>
      {/* The leave handler sits on the grid, not the cards: per-card it fired
          every time the pointer crossed the 10px gap, flashing the whole app
          back to the in-force theme between each pair. */}
      <div class="theme-picker" role="radiogroup" aria-label="Theme" onMouseLeave={restore}>
        <For each={cards()}>
          {(card) => (
            <button
              type="button"
              role="radio"
              aria-checked={props.current === card.value}
              tabindex={props.current === card.value ? 0 : -1}
              class="theme-card"
              data-theme-id={card.value}
              classList={{ 'is-active': props.current === card.value }}
              onClick={() => props.onChange(card.value)}
              onMouseEnter={() => preview(card.value)}
              onFocus={() => preview(card.value)}
              onBlur={restore}
              onKeyDown={(event) => onKeyDown(event, card.index)}
            >
              {swatchFor(card.value)}
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
