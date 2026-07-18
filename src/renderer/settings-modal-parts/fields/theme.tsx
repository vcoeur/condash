import { For, createEffect, createSignal, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
import type { Theme } from '@shared/types';
import { THEME_PRESETS, resolveThemePreset } from '@shared/themes';

/** Paint `theme` across the live app by poking the two `<html>` attributes
 *  `use-theme` owns. Deliberately signal-free: this is a *view* of a choice
 *  that has not been saved yet, so it must leave no state for Cancel to unwind
 *  — `restore` below puts the saved theme back, and `use-theme`'s own effect
 *  re-asserts it on the next real change either way. */
function paint(theme: Theme): void {
  const preset = resolveThemePreset(theme, matchMedia('(prefers-color-scheme: dark)').matches);
  const root = document.documentElement;
  root.setAttribute('data-theme', preset.id);
  root.setAttribute('data-theme-kind', preset.kind);
}

/**
 * Theme picker — one card per preset plus a System card, each painting its own
 * palette as a swatch. Shared between the Global and Conception tabs.
 *
 * Two levels of preview, because a swatch alone can't show what a theme does to
 * a dense UI: hovering (or keyboard-focusing) a card paints the whole app in it
 * transiently, and the *selected* card stays painted for as long as the modal
 * is open. Neither is a save — like every other settings field, the choice is
 * only persisted by Save, so closing without saving restores `applied`.
 */
export function ThemePicker(props: {
  /** The staged selection — what the modal will write on Save. */
  current: Theme;
  /** The theme actually in force (last saved). Restored when the modal closes
   *  without saving, so a previewed-but-abandoned pick never sticks. */
  applied: Theme;
  onChange: (theme: Theme) => void;
}): JSX.Element {
  const [hovered, setHovered] = createSignal<Theme | null>(null);

  createEffect(() => paint(hovered() ?? props.current));
  onCleanup(() => paint(props.applied));

  return (
    <div class="settings-field">
      <span class="settings-field-label">Theme</span>
      <div class="theme-picker" role="radiogroup" aria-label="Theme">
        <button
          type="button"
          role="radio"
          aria-checked={props.current === 'system'}
          class="theme-card"
          data-theme-id="system"
          classList={{ 'is-active': props.current === 'system' }}
          onClick={() => props.onChange('system')}
          onMouseEnter={() => setHovered('system')}
          onMouseLeave={() => setHovered(null)}
          onFocus={() => setHovered('system')}
          onBlur={() => setHovered(null)}
        >
          <span class="theme-card-swatch theme-card-swatch--system" aria-hidden="true" />
          <span class="theme-card-label">System</span>
          <span class="theme-card-desc">Follow the OS between Paper and Warm Gallery.</span>
        </button>
        <For each={THEME_PRESETS}>
          {(preset) => (
            <button
              type="button"
              role="radio"
              aria-checked={props.current === preset.id}
              class="theme-card"
              data-theme-id={preset.id}
              classList={{ 'is-active': props.current === preset.id }}
              onClick={() => props.onChange(preset.id)}
              onMouseEnter={() => setHovered(preset.id)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(preset.id)}
              onBlur={() => setHovered(null)}
            >
              <span
                class="theme-card-swatch"
                aria-hidden="true"
                style={{ background: preset.swatch[0] }}
              >
                <span class="theme-card-swatch-panel" style={{ background: preset.swatch[1] }} />
                <span class="theme-card-swatch-dot" style={{ background: preset.swatch[2] }} />
              </span>
              <span class="theme-card-label">{preset.label}</span>
              <span class="theme-card-desc">{preset.description}</span>
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
