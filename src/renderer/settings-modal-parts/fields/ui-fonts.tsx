import { For } from 'solid-js';
import type { JSX } from 'solid-js';
import type {
  UiFont,
  UiFontCategory,
  UiFontCategoryPrefs,
  UiFontPrefs,
  UiFontSize,
  UiFontWeight,
} from '@shared/types';
import {
  UI_FONT_CATEGORY_FIELDS,
  UI_FONT_OPTIONS,
  UI_FONT_SIZE_OPTIONS,
  UI_FONT_WEIGHT_OPTIONS,
} from '../data';
import {
  UI_FONT_SIZE_SCALES,
  UI_FONT_STACKS,
  UI_FONT_WEIGHT_VALUES,
} from '../../hooks/use-ui-fonts';

/** The base face each category falls back to when its family is `default` — the
 *  same per-surface base the stylesheets use, so the preview matches the app. */
const CATEGORY_BASE: Record<UiFontCategory, string> = {
  cardTitle: 'var(--font-serif-base)',
  heading: 'var(--font-serif-base)',
  body: 'var(--font-sans-base)',
  code: 'var(--font-mono-base)',
  terminal: 'var(--font-mono-base)',
};

/** A nominal base size (px) for each category's preview line, scaled by the
 *  chosen relative size so the preview reflects the size variant too. */
const PREVIEW_BASE_PX: Record<UiFontCategory, number> = {
  cardTitle: 17,
  heading: 18,
  body: 13,
  code: 12,
  terminal: 12,
};

/** Resolve a (category, family) pair to a concrete font-family for preview. */
function faceOf(category: UiFontCategory, family: UiFont): string {
  return UI_FONT_STACKS[family] ?? CATEGORY_BASE[category];
}

/** Build the inline style that previews a category's family + weight + size. */
function previewStyle(
  category: UiFontCategory,
  prefs: Required<UiFontCategoryPrefs>,
): JSX.CSSProperties {
  const weight = UI_FONT_WEIGHT_VALUES[prefs.weight];
  const scale = UI_FONT_SIZE_SCALES[prefs.size];
  const base = PREVIEW_BASE_PX[category];
  return {
    'font-family': faceOf(category, prefs.family),
    ...(weight ? { 'font-weight': weight } : {}),
    'font-size': scale ? `calc(${base}px * ${scale})` : `${base}px`,
  };
}

/** Per-category UI-font controls plus a live sample panel — a per-machine
 *  Appearance choice. Each category has a family dropdown (each option drawn in
 *  its own face) plus weight and size dropdowns; the sample panel above
 *  re-renders in the draft family/weight/size so the pick previews before Save. */
export function UiFontsFields(props: {
  resolve: (category: UiFontCategory) => Required<UiFontCategoryPrefs>;
  onChange: (patch: UiFontPrefs) => void;
}): JSX.Element {
  return (
    <>
      <UiFontsPreview resolve={props.resolve} />
      <For each={UI_FONT_CATEGORY_FIELDS}>
        {(field) => {
          const current = (): Required<UiFontCategoryPrefs> => props.resolve(field.key);
          return (
            <div class="settings-field">
              <span class="settings-field-label">{field.label}</span>
              <div class="settings-font-row">
                {/* Family — each option rendered in the face it selects. */}
                <select
                  class="settings-font-select settings-font-family"
                  aria-label={`${field.label} font family`}
                  value={current().family}
                  onChange={(e) =>
                    props.onChange({ [field.key]: { family: e.currentTarget.value as UiFont } })
                  }
                >
                  <For each={UI_FONT_OPTIONS}>
                    {(opt) => (
                      <option
                        value={opt.value}
                        style={{ 'font-family': faceOf(field.key, opt.value) }}
                      >
                        {opt.label}
                      </option>
                    )}
                  </For>
                </select>
                <select
                  class="settings-font-select"
                  aria-label={`${field.label} weight`}
                  value={current().weight}
                  onChange={(e) =>
                    props.onChange({
                      [field.key]: { weight: e.currentTarget.value as UiFontWeight },
                    })
                  }
                >
                  <For each={UI_FONT_WEIGHT_OPTIONS}>
                    {(opt) => <option value={opt.value}>{opt.label}</option>}
                  </For>
                </select>
                <select
                  class="settings-font-select"
                  aria-label={`${field.label} size`}
                  value={current().size}
                  onChange={(e) =>
                    props.onChange({ [field.key]: { size: e.currentTarget.value as UiFontSize } })
                  }
                >
                  <For each={UI_FONT_SIZE_OPTIONS}>
                    {(opt) => <option value={opt.value}>{opt.label}</option>}
                  </For>
                </select>
              </div>
              <small class="settings-field-hint">{field.hint}</small>
            </div>
          );
        }}
      </For>
    </>
  );
}

/** A representative mini-UI — a section heading, a sample card (title, body,
 *  id line), and a terminal line — each drawn in its category's draft family,
 *  weight, and size so the whole set of choices previews together before Save. */
function UiFontsPreview(props: {
  resolve: (category: UiFontCategory) => Required<UiFontCategoryPrefs>;
}): JSX.Element {
  const style = (category: UiFontCategory): JSX.CSSProperties =>
    previewStyle(category, props.resolve(category));
  return (
    <div class="settings-fonts-preview" aria-hidden="true">
      <div class="settings-fonts-preview-heading" style={style('heading')}>
        Pane &amp; modal heading
      </div>
      <div class="settings-fonts-preview-card">
        <div class="settings-fonts-preview-title" style={style('cardTitle')}>
          Sample card title
        </div>
        <div class="settings-fonts-preview-body" style={style('body')}>
          A line of body &amp; UI text in the interface.
        </div>
        <div class="settings-fonts-preview-code" style={style('code')}>
          task-slug-123 · main
        </div>
      </div>
      <div class="settings-fonts-preview-terminal" style={style('terminal')}>
        $ condash sync run — terminal &amp; logs
      </div>
    </div>
  );
}
