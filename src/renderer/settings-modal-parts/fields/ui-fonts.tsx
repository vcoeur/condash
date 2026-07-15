import { For } from 'solid-js';
import type { JSX } from 'solid-js';
import type { UiFont, UiFontCategory, UiFontPrefs } from '@shared/types';
import { UI_FONT_CATEGORY_FIELDS, UI_FONT_OPTIONS } from '../data';
import { UI_FONT_STACKS } from '../../hooks/use-ui-fonts';

/** The base face each category falls back to when its choice is `default` —
 *  the same per-surface base the stylesheets use, so the preview matches what
 *  the app renders. */
const CATEGORY_BASE: Record<UiFontCategory, string> = {
  cardTitle: 'var(--font-serif-base)',
  heading: 'var(--font-serif-base)',
  body: 'var(--font-sans-base)',
  code: 'var(--font-mono-base)',
  terminal: 'var(--font-mono-base)',
};

/** Resolve a (category, choice) pair to a concrete font-family for preview.
 *  `default` maps to the category's base face; the rest reuse the hook's
 *  canonical stacks so the preview never drifts from the applied CSS. */
function faceOf(category: UiFontCategory, value: UiFont): string {
  return UI_FONT_STACKS[value] ?? CATEGORY_BASE[category];
}

/** Per-category UI-font pickers plus a live sample panel — a per-machine
 *  Appearance choice. Each category is one radio group over {@link
 *  UI_FONT_OPTIONS}; the sample panel above re-renders in the draft faces so the
 *  pick previews live before Save. */
export function UiFontsFields(props: {
  resolve: (category: UiFontCategory) => UiFont;
  onChange: (patch: UiFontPrefs) => void;
}): JSX.Element {
  return (
    <>
      <UiFontsPreview resolve={props.resolve} />
      <For each={UI_FONT_CATEGORY_FIELDS}>
        {(field) => (
          <div class="settings-field">
            <span class="settings-field-label">{field.label}</span>
            <div class="settings-radio-group" role="radiogroup">
              <For each={UI_FONT_OPTIONS}>
                {(opt) => (
                  <label class="settings-radio">
                    {/* Stable per-category name so each category is one real
                        radio group with native arrow-key navigation. */}
                    <input
                      type="radio"
                      name={`ui-font-${field.key}`}
                      checked={props.resolve(field.key) === opt.value}
                      onChange={() => props.onChange({ [field.key]: opt.value })}
                    />
                    {/* Preview the actual face this option selects. */}
                    <span style={{ 'font-family': faceOf(field.key, opt.value) }}>{opt.label}</span>
                  </label>
                )}
              </For>
            </div>
            <small class="settings-field-hint">{field.hint}</small>
          </div>
        )}
      </For>
    </>
  );
}

/** A representative mini-UI — a sample card (title, body line, id line), a
 *  section heading, and a terminal line — each drawn in its category's draft
 *  face so the whole set of choices previews together before Save. */
function UiFontsPreview(props: { resolve: (category: UiFontCategory) => UiFont }): JSX.Element {
  const face = (category: UiFontCategory): string => faceOf(category, props.resolve(category));
  return (
    <div class="settings-fonts-preview" aria-hidden="true">
      <div class="settings-fonts-preview-heading" style={{ 'font-family': face('heading') }}>
        Pane &amp; modal heading
      </div>
      <div class="settings-fonts-preview-card">
        <div class="settings-fonts-preview-title" style={{ 'font-family': face('cardTitle') }}>
          Sample card title
        </div>
        <div class="settings-fonts-preview-body" style={{ 'font-family': face('body') }}>
          A line of body &amp; UI text in the interface.
        </div>
        <div class="settings-fonts-preview-code" style={{ 'font-family': face('code') }}>
          task-slug-123 · main
        </div>
      </div>
      <div class="settings-fonts-preview-terminal" style={{ 'font-family': face('terminal') }}>
        $ condash sync run — terminal &amp; logs
      </div>
    </div>
  );
}
