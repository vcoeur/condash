import { Show } from 'solid-js';
import type { JSX } from 'solid-js';
import type { TerminalXtermPrefs } from '@shared/types';
import { type BindTextFn, type ColorEntry } from '../data';

/** Best-effort CSS colour validation. Accepts hex (`#rgb` / `#rrggbb` /
 *  `#rrggbbaa`), `color-mix(`/`rgb(`/`hsl(` functional notations, and any
 *  string that the browser confirms as a valid colour by round-tripping
 *  through `CSS.supports`. Empty strings are valid (inherit). */
function isValidCssColor(value: string | undefined): boolean {
  if (!value) return true;
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  if (/^#[0-9a-f]{3,8}$/i.test(trimmed)) return true;
  if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function') {
    return CSS.supports('color', trimmed);
  }
  // Fallback for non-browser test environments — accept named colours.
  return /^[a-z][a-z0-9-]*$/i.test(trimmed);
}

/** ANSI colour input with a live swatch and native colour-picker overlay.
 *  Replaces the plain `<input type="text">` for the 21 terminal colour
 *  fields. The swatch reflects whatever the user types (any CSS colour
 *  string). Clicking the swatch opens an invisible `<input type="color">`
 *  which writes a hex string back through the same save path. Invalid
 *  values surface a red border + inline message without blocking save. */
export function ColorField(props: {
  entry: ColorEntry;
  idPrefix: string;
  value: () => string | undefined;
  bindText: BindTextFn;
  onChange: (next: string) => void;
}): JSX.Element {
  let pickerRef: HTMLInputElement | undefined;
  const swatchColor = (): string => {
    const v = props.value();
    return v && v.trim().length > 0 && isValidCssColor(v) ? v : 'transparent';
  };
  const invalid = (): boolean => !isValidCssColor(props.value());
  return (
    <label class="settings-color">
      <span>{props.entry.label}</span>
      <span class="settings-color-input">
        <button
          type="button"
          class="settings-color-swatch"
          style={{ background: swatchColor() }}
          title={`Pick ${props.entry.label.toLowerCase()}`}
          aria-label={`Open colour picker for ${props.entry.label}`}
          onClick={() => pickerRef?.click()}
        />
        <input
          type="text"
          placeholder="—"
          classList={{ 'settings-input--invalid': invalid() }}
          aria-invalid={invalid()}
          {...props.bindText(
            `${props.idPrefix}.xterm.colors.${props.entry.key}`,
            props.value,
            (v) => {
              props.onChange(v);
              return Promise.resolve();
            },
          )}
        />
        <input
          ref={(el) => (pickerRef = el)}
          type="color"
          class="settings-color-picker"
          aria-hidden="true"
          tabIndex={-1}
          value={(() => {
            const v = props.value();
            return v && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim() : '#000000';
          })()}
          onInput={(e) => props.onChange(e.currentTarget.value)}
        />
      </span>
      <Show when={invalid()}>
        <small class="settings-field-error">Not a recognised CSS colour.</small>
      </Show>
    </label>
  );
}

/** Tiny fake terminal that picks up whatever CSS colour vars are set by
 *  the live xterm.colors values. Updates as the user types — no IPC needed
 *  because the draft tree is reactive. Useful sanity check before saving. */
export function TerminalColorPreview(props: { xterm: () => TerminalXtermPrefs }): JSX.Element {
  const styleVars = (): Record<string, string> => {
    const colors = props.xterm().colors ?? {};
    const vars: Record<string, string> = {};
    if (colors.background) vars['--preview-bg'] = colors.background;
    if (colors.foreground) vars['--preview-fg'] = colors.foreground;
    if (colors.cursor) vars['--preview-cursor'] = colors.cursor;
    if (colors.selection_background) vars['--preview-selection'] = colors.selection_background;
    if (colors.green) vars['--preview-green'] = colors.green;
    if (colors.red) vars['--preview-red'] = colors.red;
    if (colors.yellow) vars['--preview-yellow'] = colors.yellow;
    if (colors.blue) vars['--preview-blue'] = colors.blue;
    if (colors.magenta) vars['--preview-magenta'] = colors.magenta;
    if (colors.cyan) vars['--preview-cyan'] = colors.cyan;
    if (colors.bright_black) vars['--preview-muted'] = colors.bright_black;
    return vars;
  };
  return (
    <pre class="settings-terminal-preview" style={styleVars()} aria-hidden="true">
      <span class="preview-muted">$ </span>
      <span class="preview-green">ls</span> -la
      {'\n'}
      <span class="preview-blue">drwxr-xr-x</span>
      {'  '}
      <span class="preview-muted">20 alice staff</span>
      {'  640 May 19 10:23 '}
      <span class="preview-cyan">.</span>
      {'\n'}
      <span class="preview-yellow">warning:</span> 1 deprecated import (
      <span class="preview-magenta">legacy</span>){'\n'}
      <span class="preview-red">error:</span> connection refused
      {'\n'}
      <span class="preview-muted">$ </span>
      <span class="preview-cursor">█</span>
    </pre>
  );
}
