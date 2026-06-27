import { For } from 'solid-js';
import type { JSX } from 'solid-js';
import type { Theme } from '@shared/types';
import { THEME_OPTIONS } from '../data';

/** Theme radios — shared between the Global and Conception tabs. */
export function ThemePicker(props: {
  current: Theme;
  onChange: (theme: Theme) => void;
}): JSX.Element {
  return (
    <div class="settings-field">
      <span class="settings-field-label">Theme</span>
      <div class="settings-radio-group" role="radiogroup">
        <For each={THEME_OPTIONS}>
          {(opt) => (
            <label class="settings-radio">
              <input
                type="radio"
                name={`theme-${Math.random().toString(36).slice(2, 8)}`}
                checked={props.current === opt.value}
                onChange={() => props.onChange(opt.value)}
              />
              <span>{opt.label}</span>
            </label>
          )}
        </For>
      </div>
    </div>
  );
}
