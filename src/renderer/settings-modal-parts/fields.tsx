import { For, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import type {
  CardMinWidthPrefs,
  Platform,
  TerminalLoggingPrefs,
  TerminalPrefs,
  TerminalXtermPrefs,
  Theme,
} from '@shared/types';
import { DEFAULT_CARD_MIN_WIDTH } from '@shared/types';
import {
  type ColorEntry,
  CURSOR_STYLES,
  pick,
  type SettingsTab,
  TERMINAL_COLORS,
  TERMINAL_STRING_FIELDS,
  THEME_OPTIONS,
} from './data';
import { FieldBadgeRow, type InheritanceState } from './badges';

/** Field row that pairs a labelled control with an inheritance badge.
 *  Used on the conception tab; pass `state="inherits"` and `hide` from the
 *  global tab if it ever needs the same shape. */
export function FieldWithBadge(props: {
  label: string;
  hint?: string;
  state: InheritanceState;
  onRemove: () => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <label class="settings-field-with-badge">
      <span class="settings-field-row">
        <span class="settings-field-label">{props.label}</span>
        <FieldBadgeRow state={props.state} onRemove={props.onRemove} />
      </span>
      {props.children}
      <Show when={props.hint}>
        <span class="settings-field-hint">{props.hint}</span>
      </Show>
    </label>
  );
}

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

/** Five card-min-width fields — shared between tabs. */
export function CardDensityFields(props: {
  resolve: (key: keyof CardMinWidthPrefs) => number;
  onChange: (patch: CardMinWidthPrefs) => void;
}): JSX.Element {
  return (
    <div class="settings-grid">
      <For
        each={
          [
            { key: 'projects', label: 'Project cards (Projects pane)' },
            { key: 'code', label: 'Code cards (Code pane)' },
            { key: 'knowledge', label: 'Knowledge cards (Knowledge pane)' },
            { key: 'resources', label: 'Resource cards (Resources pane)' },
            { key: 'skills', label: 'Skill cards (Skills pane)' },
          ] as const
        }
      >
        {(field) => (
          <label>
            <span>{field.label}</span>
            <input
              type="number"
              min="120"
              max="2400"
              step="10"
              value={props.resolve(field.key)}
              onChange={(e) => {
                const raw = e.currentTarget.value;
                const parsed = raw === '' ? DEFAULT_CARD_MIN_WIDTH[field.key] : Number(raw);
                if (!Number.isFinite(parsed)) return;
                props.onChange({ [field.key]: parsed });
              }}
            />
            <small class="settings-field-hint">
              Min width in CSS pixels. Default {DEFAULT_CARD_MIN_WIDTH[field.key]}.
            </small>
          </label>
        )}
      </For>
    </div>
  );
}

/** Terminal section content — string fields, xterm font/cursor/buffer,
 *  colours. Shared between Global and Conception tabs. */
export function TerminalFields(props: {
  target: SettingsTab;
  bindText: (
    id: string,
    persisted: () => string | undefined,
    save: (value: string) => Promise<void>,
  ) => {
    value: string;
    onInput: (e: InputEvent & { currentTarget: HTMLInputElement }) => void;
    onChange: (e: Event & { currentTarget: HTMLInputElement }) => void;
  };
  prefs: () => TerminalPrefs;
  xterm: () => TerminalXtermPrefs;
  setString: (key: (typeof TERMINAL_STRING_FIELDS)[number]['key'], value: string) => Promise<void>;
  updateXterm: (patch: Partial<TerminalXtermPrefs>) => Promise<void>;
  updateColor: (key: ColorEntry['key'], value: string) => void;
  updateLogging: (patch: Partial<TerminalLoggingPrefs>) => Promise<void>;
  platform: () => Platform | undefined;
}): JSX.Element {
  const logging = (): TerminalLoggingPrefs => props.prefs().logging ?? {};
  const loggingEnabled = (): boolean => logging().enabled !== false;
  const idPrefix = `${props.target}.terminal`;
  return (
    <>
      <h3>Behaviour &amp; shortcuts</h3>
      <div class="settings-grid">
        <For each={TERMINAL_STRING_FIELDS}>
          {(field) => (
            <label>
              <span>{field.label}</span>
              <input
                type="text"
                placeholder={pick(field.placeholder, props.platform())}
                {...props.bindText(
                  `${idPrefix}.${field.key}`,
                  () => (props.prefs() as Record<string, unknown>)[field.key] as string | undefined,
                  (v) => props.setString(field.key, v),
                )}
              />
              <Show when={field.hint}>
                <small class="settings-field-hint">{field.hint}</small>
              </Show>
            </label>
          )}
        </For>
      </div>

      <h3>Font</h3>
      <div class="settings-grid">
        <label>
          <span>Font family</span>
          <input
            type="text"
            placeholder="ui-monospace, Menlo, Consolas, monospace"
            {...props.bindText(
              `${idPrefix}.xterm.font_family`,
              () => props.xterm().font_family,
              (v) => props.updateXterm({ font_family: v || undefined }),
            )}
          />
        </label>
        <label>
          <span>Font size (px)</span>
          <input
            type="number"
            min="6"
            max="48"
            value={props.xterm().font_size ?? ''}
            placeholder="12"
            onChange={(e) =>
              void props.updateXterm({
                font_size: e.currentTarget.value ? Number(e.currentTarget.value) : undefined,
              })
            }
          />
        </label>
        <label>
          <span>Line height</span>
          <input
            type="number"
            step="0.05"
            min="0.8"
            max="2"
            value={props.xterm().line_height ?? ''}
            placeholder="1.0"
            onChange={(e) =>
              void props.updateXterm({
                line_height: e.currentTarget.value ? Number(e.currentTarget.value) : undefined,
              })
            }
          />
        </label>
        <label>
          <span>Letter spacing (px)</span>
          <input
            type="number"
            step="0.5"
            value={props.xterm().letter_spacing ?? ''}
            placeholder="0"
            onChange={(e) =>
              void props.updateXterm({
                letter_spacing: e.currentTarget.value ? Number(e.currentTarget.value) : undefined,
              })
            }
          />
        </label>
        <label>
          <span>Font weight</span>
          <input
            type="text"
            placeholder="normal | 400 | 500"
            {...props.bindText(
              `${idPrefix}.xterm.font_weight`,
              () =>
                props.xterm().font_weight !== undefined
                  ? String(props.xterm().font_weight)
                  : undefined,
              (v) => props.updateXterm({ font_weight: v || undefined }),
            )}
          />
        </label>
        <label>
          <span>Bold weight</span>
          <input
            type="text"
            placeholder="bold | 600 | 700"
            {...props.bindText(
              `${idPrefix}.xterm.font_weight_bold`,
              () =>
                props.xterm().font_weight_bold !== undefined
                  ? String(props.xterm().font_weight_bold)
                  : undefined,
              (v) => props.updateXterm({ font_weight_bold: v || undefined }),
            )}
          />
        </label>
      </div>

      <h3>Cursor &amp; buffer</h3>
      <div class="settings-grid">
        <label>
          <span>Cursor style</span>
          <select
            value={props.xterm().cursor_style ?? 'block'}
            onChange={(e) =>
              void props.updateXterm({
                cursor_style: e.currentTarget.value as 'block' | 'underline' | 'bar',
              })
            }
          >
            <For each={CURSOR_STYLES}>
              {(opt) => <option value={opt.value}>{opt.label}</option>}
            </For>
          </select>
        </label>
        <label class="settings-checkbox">
          <input
            type="checkbox"
            checked={props.xterm().cursor_blink !== false}
            onChange={(e) => void props.updateXterm({ cursor_blink: e.currentTarget.checked })}
          />
          <span>Cursor blink</span>
        </label>
        <label>
          <span>Scrollback (lines)</span>
          <input
            type="number"
            min="0"
            max="100000"
            value={props.xterm().scrollback ?? ''}
            placeholder="10000"
            onChange={(e) =>
              void props.updateXterm({
                scrollback: e.currentTarget.value ? Number(e.currentTarget.value) : undefined,
              })
            }
          />
        </label>
        <label class="settings-checkbox">
          <input
            type="checkbox"
            checked={props.xterm().ligatures === true}
            onChange={(e) =>
              void props.updateXterm({ ligatures: e.currentTarget.checked || undefined })
            }
          />
          <span>Programming-font ligatures</span>
        </label>
      </div>

      <h3>Colours</h3>
      <p class="settings-hint">
        Leave a field blank to inherit the active theme. Values are CSS colours (hex, named,{' '}
        <code>color-mix(...)</code>).
      </p>
      <div class="settings-color-grid">
        <For each={TERMINAL_COLORS}>
          {(entry) => (
            <label class="settings-color">
              <span>{entry.label}</span>
              <input
                type="text"
                placeholder="—"
                {...props.bindText(
                  `${idPrefix}.xterm.colors.${entry.key}`,
                  () => props.xterm().colors?.[entry.key],
                  (v) => {
                    props.updateColor(entry.key, v);
                    return Promise.resolve();
                  },
                )}
              />
            </label>
          )}
        </For>
      </div>

      <h3>Logging</h3>
      <p class="settings-hint">
        Capture stdin / stdout for every terminal tab to{' '}
        <code>.condash/logs/YYYY/MM/DD/HHMMSS-&lt;id&gt;.jsonl</code>. The
        <code> .condash/</code> tree is gitignored by default.
      </p>
      <div class="settings-grid">
        <label class="settings-checkbox">
          <input
            type="checkbox"
            checked={loggingEnabled()}
            onChange={(e) => void props.updateLogging({ enabled: e.currentTarget.checked })}
          />
          <span>Enable terminal capture</span>
        </label>
        <label>
          <span>Retention (days)</span>
          <input
            type="number"
            min="0"
            max="3650"
            value={logging().retentionDays ?? ''}
            placeholder="14"
            onChange={(e) =>
              void props.updateLogging({
                retentionDays: e.currentTarget.value ? Number(e.currentTarget.value) : undefined,
              })
            }
          />
          <small class="settings-field-hint">
            Day-directories older than this are removed on next janitor run.
            <code> 0</code> disables age-based eviction.
          </small>
        </label>
        <label>
          <span>Max total size (MB)</span>
          <input
            type="number"
            min="0"
            value={logging().maxDirMb ?? ''}
            placeholder="500"
            onChange={(e) =>
              void props.updateLogging({
                maxDirMb: e.currentTarget.value ? Number(e.currentTarget.value) : undefined,
              })
            }
          />
          <small class="settings-field-hint">
            When over this cap, the oldest day-directory is removed first.
          </small>
        </label>
        <label>
          <span>Max per-file size (MB)</span>
          <input
            type="number"
            min="1"
            value={logging().maxFileMb ?? ''}
            placeholder="5"
            onChange={(e) =>
              void props.updateLogging({
                maxFileMb: e.currentTarget.value ? Number(e.currentTarget.value) : undefined,
              })
            }
          />
          <small class="settings-field-hint">
            Sessions over this size roll to <code>.2.jsonl</code>, <code>.3.jsonl</code>, ...
          </small>
        </label>
        <label>
          <span>ANSI escape policy</span>
          <select
            value={logging().ansiPolicy ?? 'raw'}
            onChange={(e) =>
              void props.updateLogging({
                ansiPolicy: e.currentTarget.value as 'raw' | 'stripped',
              })
            }
          >
            <option value="raw">raw — store ANSI bytes, strip at view</option>
            <option value="stripped">stripped — drop ANSI before write</option>
          </select>
        </label>
      </div>
    </>
  );
}
