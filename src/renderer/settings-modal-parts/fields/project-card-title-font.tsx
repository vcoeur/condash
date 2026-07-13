import { For } from 'solid-js';
import type { JSX } from 'solid-js';
import type { ProjectCardTitleFont } from '@shared/types';
import { PROJECT_CARD_TITLE_FONT_OPTIONS } from '../data';
import { PROJECT_CARD_TITLE_FONT_STACKS } from '../../hooks/use-project-card-title-font';

/** Project-card title-font radios — a per-machine Appearance choice. Each
 *  option label is rendered in the typeface it selects, so the pick previews
 *  live before Save. */
export function ProjectCardTitleFontPicker(props: {
  current: ProjectCardTitleFont;
  onChange: (font: ProjectCardTitleFont) => void;
}): JSX.Element {
  return (
    <div class="settings-field">
      <span class="settings-field-label">Project card title font</span>
      <div class="settings-radio-group" role="radiogroup">
        <For each={PROJECT_CARD_TITLE_FONT_OPTIONS}>
          {(opt) => (
            <label class="settings-radio">
              <input
                type="radio"
                name={`pctf-${Math.random().toString(36).slice(2, 8)}`}
                checked={props.current === opt.value}
                onChange={() => props.onChange(opt.value)}
              />
              {/* Preview the actual face; `default` maps to null → the theme's
                  editorial `--font-display`. */}
              <span
                style={{
                  'font-family': PROJECT_CARD_TITLE_FONT_STACKS[opt.value] ?? 'var(--font-display)',
                }}
              >
                {opt.label}
              </span>
            </label>
          )}
        </For>
      </div>
      <small class="settings-field-hint">
        Typeface for project-card titles on the Projects pane. Default keeps the theme's editorial
        face.
      </small>
    </div>
  );
}
