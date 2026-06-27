import { createContext, createMemo, createSignal, For, Show, useContext } from 'solid-js';
import type { JSX } from 'solid-js';
import { Caret } from '../icons';
import type {
  ActionTemplate,
  CardMinWidthPrefs,
  Platform,
  TerminalLoggingPrefs,
  TerminalPrefs,
  TerminalXtermPrefs,
  Theme,
} from '@shared/types';
import { DEFAULT_CARD_MIN_WIDTH } from '@shared/types';
import {
  type BindTextFn,
  type ColorEntry,
  CURSOR_STYLES,
  pick,
  type SettingsTab,
  TERMINAL_COLORS,
  TERMINAL_STRING_FIELDS,
  THEME_OPTIONS,
} from './data';

// --- Search context ---------------------------------------------------

interface SearchContextValue {
  /** Active query (already trimmed externally). Empty string = no filter. */
  query: () => string;
  /** Returns true when the haystack matches the active query OR when the
   *  query is empty. Case-insensitive substring match. */
  hasMatch: (haystack: string) => boolean;
}

const FALLBACK_SEARCH: SearchContextValue = {
  query: () => '',
  hasMatch: () => true,
};

const SearchContext = createContext<SearchContextValue>(FALLBACK_SEARCH);

/** Hook for descendants that want to filter their own rendering on the
 *  active query. Returns the noop context when no provider is mounted, so
 *  components can be reused outside the Settings modal. */
export function useSearch(): SearchContextValue {
  return useContext(SearchContext);
}

/** Mounts the search context. The modal owns the query signal and wraps
 *  every section in this provider. */
export function SearchProvider(props: { query: () => string; children: JSX.Element }): JSX.Element {
  const value: SearchContextValue = {
    query: props.query,
    hasMatch: (haystack) => {
      const q = props.query().trim().toLowerCase();
      if (!q) return true;
      return haystack.toLowerCase().includes(q);
    },
  };
  return <SearchContext.Provider value={value}>{props.children}</SearchContext.Provider>;
}

// --- Subgroup (collapsible) ------------------------------------------

const SUBGROUP_OPEN_KEY = 'condash:settings-modal:subgroup-open';

function readSubgroupOpen(id: string, defaultOpen: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(SUBGROUP_OPEN_KEY);
    if (!raw) return defaultOpen;
    const map = JSON.parse(raw) as Record<string, boolean>;
    return typeof map[id] === 'boolean' ? map[id] : defaultOpen;
  } catch {
    return defaultOpen;
  }
}

function writeSubgroupOpen(id: string, open: boolean): void {
  try {
    const raw = window.localStorage.getItem(SUBGROUP_OPEN_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    map[id] = open;
    window.localStorage.setItem(SUBGROUP_OPEN_KEY, JSON.stringify(map));
  } catch {
    // Private-mode browsers throw on localStorage writes; the subgroup
    // simply forgets its open state across reloads — acceptable.
  }
}

/** Collapsible subgroup with a `<h3>` heading. Participates in search:
 *  when the active query matches neither the title nor `keywords`, the
 *  subgroup hides entirely. When a query is active and the subgroup
 *  matches, it force-opens so the user can see what matched without an
 *  extra click. */
export function Subgroup(props: {
  id: string;
  title: string;
  /** Extra match text (label and hint strings from descendants). When
   *  omitted, only the title participates in search matching. */
  keywords?: string;
  defaultOpen?: boolean;
  children: JSX.Element;
}): JSX.Element {
  const search = useSearch();
  const matchesSearch = createMemo(() => search.hasMatch(`${props.title} ${props.keywords ?? ''}`));
  const [userOpen, setUserOpen] = createSignal(
    readSubgroupOpen(props.id, props.defaultOpen ?? false),
  );
  const open = createMemo(() => (search.query().trim().length > 0 ? matchesSearch() : userOpen()));
  return (
    <Show when={matchesSearch()}>
      <details
        class="settings-subgroup"
        open={open()}
        data-subgroup-id={props.id}
        onToggle={(e) => {
          if (search.query().trim().length > 0) return;
          const isOpen = e.currentTarget.open;
          setUserOpen(isOpen);
          writeSubgroupOpen(props.id, isOpen);
        }}
      >
        <summary class="settings-subgroup-summary">
          <Caret expanded={open()} />
          <h3>{props.title}</h3>
        </summary>
        <div class="settings-subgroup-body">{props.children}</div>
      </details>
    </Show>
  );
}

/** Labelled control row with an optional `[abs]`/`[rel]` path chip. */
export function LabeledField(props: {
  label: string;
  hint?: string;
  /** Path-scope tag: 'abs' shows an [abs] chip, 'rel' shows [rel]. Omit
   *  for non-path fields. */
  pathScope?: 'abs' | 'rel';
  children: JSX.Element;
}): JSX.Element {
  return (
    <label class="settings-field-with-badge">
      <span class="settings-field-row">
        <span class="settings-field-label">
          {props.label}
          <Show when={props.pathScope}>
            {(scope) => (
              <span
                class="settings-path-chip"
                classList={{ 'settings-path-chip--rel': scope() === 'rel' }}
                title={scope() === 'abs' ? 'Absolute path' : 'Relative to conception root'}
              >
                {scope()}
              </span>
            )}
          </Show>
        </span>
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

/** Card-min-width fields, one per pane — shared between tabs. */
const CARD_DENSITY_FIELDS = [
  { key: 'projects', label: 'Project cards (Projects pane)', short: 'Project' },
  { key: 'code', label: 'Code cards (Code pane)', short: 'Code' },
  { key: 'knowledge', label: 'Knowledge cards (Knowledge pane)', short: 'Knowledge' },
  { key: 'resources', label: 'Resource cards (Resources pane)', short: 'Resource' },
  { key: 'skills', label: 'Skill cards (Skills pane)', short: 'Skill' },
  { key: 'logs', label: 'Log cards (Logs pane)', short: 'Log' },
  { key: 'tasks', label: 'Task cards (Tasks pane)', short: 'Task' },
  { key: 'deliverables', label: 'Deliverable cards (Deliverables pane)', short: 'Deliverable' },
] as const;

// Compile-time guard: every CardMinWidthPrefs key must have a density field
// here. Add a pane to the type without a field and `_MissingDensityField`
// becomes that key (not `never`), so this assignment fails tsc — the Settings
// UI can no longer silently fall behind the schema (the logs/tasks/deliverables
// regression).
type _MissingDensityField = Exclude<
  keyof CardMinWidthPrefs,
  (typeof CARD_DENSITY_FIELDS)[number]['key']
>;
const _assertAllDensityFieldsPresent: _MissingDensityField extends never ? true : false = true;
void _assertAllDensityFieldsPresent;

export function CardDensityFields(props: {
  resolve: (key: keyof CardMinWidthPrefs) => number;
  onChange: (patch: CardMinWidthPrefs) => void;
}): JSX.Element {
  return (
    <>
      <CardDensityPreview resolve={props.resolve} />
      <div class="settings-grid">
        <For each={CARD_DENSITY_FIELDS}>
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
    </>
  );
}

/** Renders five fake cards, one per pane, sized to the current
 *  min-width values so the user sees the relative scale before saving. */
function CardDensityPreview(props: {
  resolve: (key: keyof CardMinWidthPrefs) => number;
}): JSX.Element {
  return (
    <div class="settings-density-preview" aria-hidden="true">
      <For each={CARD_DENSITY_FIELDS}>
        {(field) => {
          const px = (): number => props.resolve(field.key);
          // Visual is half-scale so 5 cards at default 300 px all fit
          // inside the modal viewport; the on-card label still shows the
          // real px value so the relative-size intent is unambiguous.
          return (
            <div
              class="settings-density-preview-card"
              style={{ width: `${Math.round(px() / 2)}px` }}
            >
              <span class="settings-density-preview-label">{field.short}</span>
              <span class="settings-density-preview-width">{px()}px</span>
            </div>
          );
        }}
      </For>
    </div>
  );
}

function ActionTemplateSection(props: {
  title: string;
  hint: string;
  idPrefix: string;
  /** Stable subgroup id (e.g. "global.terminal.project-actions"). When
   *  set, the section renders inside a collapsible Subgroup that also
   *  participates in search. */
  subgroupId?: string;
  /** Extra search keywords (e.g. "project action template launcher"). */
  keywords?: string;
  bindText: (
    id: string,
    persisted: () => string | undefined,
    save: (value: string) => Promise<void>,
  ) => {
    value: string;
    onInput: (e: InputEvent & { currentTarget: HTMLInputElement }) => void;
    onChange: (e: Event & { currentTarget: HTMLInputElement }) => void;
  };
  items: () => ActionTemplate[];
  patch: (index: number, patch: Partial<ActionTemplate>) => Promise<void>;
  add: () => Promise<void>;
  remove: (index: number) => Promise<void>;
  move: (index: number, delta: -1 | 1) => Promise<void>;
}): JSX.Element {
  const body = (): JSX.Element => (
    <>
      <p class="settings-field-hint">{props.hint}</p>
      <For each={props.items()}>
        {(action, idx) => (
          <div class="settings-launcher-row">
            <label>
              <span>Label</span>
              <input
                type="text"
                placeholder="Claude review"
                {...props.bindText(
                  `${props.idPrefix}.${idx()}.label`,
                  () => action.label || undefined,
                  (v) => props.patch(idx(), { label: v }),
                )}
              />
            </label>
            <label>
              <span>Template</span>
              <input
                type="text"
                placeholder='claude "review project {shortSlug}"'
                {...props.bindText(
                  `${props.idPrefix}.${idx()}.template`,
                  () => action.template || undefined,
                  (v) => props.patch(idx(), { template: v }),
                )}
              />
            </label>
            <label>
              <span>Agent</span>
              <input
                type="text"
                placeholder="claude-deepseek-v4-pro (blank = focused tab)"
                {...props.bindText(
                  `${props.idPrefix}.${idx()}.agent`,
                  () => action.agent || undefined,
                  (v) => props.patch(idx(), { agent: v || undefined }),
                )}
              />
            </label>
            <label class="settings-checkbox">
              <input
                type="checkbox"
                checked={action.submit === true}
                onChange={(e) => void props.patch(idx(), { submit: e.currentTarget.checked })}
              />
              <span>Submit (press Enter after pasting)</span>
            </label>
            <div class="settings-launcher-actions">
              <button type="button" title="Remove" onClick={() => props.remove(idx())}>
                ×
              </button>
              <button
                type="button"
                title="Move up"
                disabled={idx() === 0}
                onClick={() => props.move(idx(), -1)}
              >
                ↑
              </button>
              <button
                type="button"
                title="Move down"
                disabled={idx() === props.items().length - 1}
                onClick={() => props.move(idx(), 1)}
              >
                ↓
              </button>
            </div>
          </div>
        )}
      </For>
      <button type="button" class="settings-add-launcher" onClick={() => props.add()}>
        + Add action
      </button>
    </>
  );
  return (
    <Show
      when={props.subgroupId}
      fallback={
        <>
          <h3>{props.title}</h3>
          {body()}
        </>
      }
    >
      <Subgroup
        id={props.subgroupId!}
        title={props.title}
        keywords={`${props.hint} ${props.keywords ?? ''}`}
      >
        {body()}
      </Subgroup>
    </Show>
  );
}

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
function ColorField(props: {
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

/** Serialise a keyboard event to the modifier-chained string format the
 *  rest of condash uses (`Ctrl+Shift+V`, `Cmd+Left`, etc.). Returns null
 *  for events that produced no key character (modifier-only press, IME). */
function serializeShortcut(e: KeyboardEvent): string | null {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.metaKey) parts.push('Cmd');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  const k = e.key;
  // Don't accept a bare modifier as the final key — the user is still
  // composing.
  if (k === 'Control' || k === 'Meta' || k === 'Alt' || k === 'Shift') return null;
  if (k.length === 1) {
    parts.push(k.toUpperCase());
  } else {
    // Named keys: pass-through, capitalising. e.g. 'ArrowLeft' → 'Left',
    // 'Backquote' is unlikely as e.key, but if so leave it. Browsers emit
    // 'ArrowLeft' on arrow keys — strip the 'Arrow' prefix for legibility.
    parts.push(k.replace(/^Arrow/, ''));
  }
  return parts.join('+');
}

/** Click-to-capture keyboard shortcut input. When idle, renders the stored
 *  shortcut as a chip-like button; when capturing, listens for the next
 *  full key combination and stores its serialisation. Esc aborts;
 *  Backspace clears. */
function ShortcutCapture(props: {
  id: string;
  value: () => string | undefined;
  placeholder: string;
  onChange: (next: string) => void;
}): JSX.Element {
  const [capturing, setCapturing] = createSignal(false);
  const handleKey = (e: KeyboardEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      setCapturing(false);
      return;
    }
    if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      props.onChange('');
      setCapturing(false);
      return;
    }
    const serial = serializeShortcut(e);
    if (!serial) return;
    props.onChange(serial);
    setCapturing(false);
  };
  return (
    <button
      type="button"
      class="settings-shortcut"
      classList={{ 'settings-shortcut--capturing': capturing() }}
      onClick={() => setCapturing((c) => !c)}
      onKeyDown={(e) => {
        if (!capturing()) return;
        handleKey(e);
      }}
      title={
        capturing()
          ? 'Press a key combination (Esc to cancel, Backspace to clear)'
          : 'Click to rebind'
      }
    >
      {capturing()
        ? 'Press a key combination…'
        : props.value() && props.value()!.trim().length > 0
          ? props.value()
          : props.placeholder}
    </button>
  );
}

/** Tiny fake terminal that picks up whatever CSS colour vars are set by
 *  the live xterm.colors values. Updates as the user types — no IPC needed
 *  because the draft tree is reactive. Useful sanity check before saving. */
function TerminalColorPreview(props: { xterm: () => TerminalXtermPrefs }): JSX.Element {
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
  projectActions: () => ActionTemplate[];
  patchProjectAction: (index: number, patch: Partial<ActionTemplate>) => Promise<void>;
  addProjectAction: () => Promise<void>;
  removeProjectAction: (index: number) => Promise<void>;
  moveProjectAction: (index: number, delta: -1 | 1) => Promise<void>;
  newProjectActions: () => ActionTemplate[];
  patchNewProjectAction: (index: number, patch: Partial<ActionTemplate>) => Promise<void>;
  addNewProjectAction: () => Promise<void>;
  removeNewProjectAction: (index: number) => Promise<void>;
  moveNewProjectAction: (index: number, delta: -1 | 1) => Promise<void>;
  updateXterm: (patch: Partial<TerminalXtermPrefs>) => Promise<void>;
  updateColor: (key: ColorEntry['key'], value: string) => void;
  updateLogging: (patch: Partial<TerminalLoggingPrefs>) => Promise<void>;
  platform: () => Platform | undefined;
}): JSX.Element {
  const logging = (): TerminalLoggingPrefs => props.prefs().logging ?? {};
  // Opt-in by default: only treat the checkbox as on when the user has
  // explicitly set the flag. `undefined` and `false` both render unchecked.
  const loggingEnabled = (): boolean => logging().enabled === true;
  const idPrefix = `${props.target}.terminal`;
  const subgroupId = (suffix: string): string => `${props.target}.terminal.${suffix}`;
  // Static keyword strings drive search matching. Concatenating field
  // labels keeps the index in sync with the rendered content — when a
  // field is renamed, the search behaviour updates with it.
  const behaviourKeywords = TERMINAL_STRING_FIELDS.map((f) => f.label).join(' ');
  return (
    <>
      <Subgroup
        id={subgroupId('behaviour')}
        title="Behaviour & shortcuts"
        keywords={`shell screenshot shortcut keybinding ${behaviourKeywords}`}
        defaultOpen
      >
        <div class="settings-grid">
          <For each={TERMINAL_STRING_FIELDS}>
            {(field) => (
              <label>
                <span class="settings-field-label-row">
                  <span>{field.label}</span>
                  <Show when={field.kind === 'path'}>
                    <span class="settings-path-chip" title="Absolute path">
                      abs
                    </span>
                  </Show>
                </span>
                <Show
                  when={field.kind === 'shortcut'}
                  fallback={
                    <input
                      type="text"
                      placeholder={pick(field.placeholder, props.platform())}
                      {...props.bindText(
                        `${idPrefix}.${field.key}`,
                        () =>
                          (props.prefs() as Record<string, unknown>)[field.key] as
                            | string
                            | undefined,
                        (v) => props.setString(field.key, v),
                      )}
                    />
                  }
                >
                  <ShortcutCapture
                    id={`${idPrefix}.${field.key}`}
                    value={() =>
                      (props.prefs() as Record<string, unknown>)[field.key] as string | undefined
                    }
                    placeholder={pick(field.placeholder, props.platform())}
                    onChange={(v) => void props.setString(field.key, v)}
                  />
                </Show>
                <Show when={field.hint}>
                  <small class="settings-field-hint">{field.hint}</small>
                </Show>
              </label>
            )}
          </For>
        </div>
      </Subgroup>

      <ActionTemplateSection
        title="Project actions"
        subgroupId={subgroupId('project-actions')}
        keywords="project action template agent submit work-on"
        hint="Each entry appears in the dropdown next to the project's Work-on button. Templates accept {slug}, {title}, {branch}, {apps}, … (see Help). Agent (when set) spawns a fresh tab running that agent instead of typing into the focused tab."
        idPrefix={`${idPrefix}.projectActions`}
        bindText={props.bindText}
        items={props.projectActions}
        patch={props.patchProjectAction}
        add={props.addProjectAction}
        remove={props.removeProjectAction}
        move={props.moveProjectAction}
      />

      <ActionTemplateSection
        title="New project actions"
        subgroupId={subgroupId('new-project-actions')}
        keywords="new project action agent template start"
        hint="Each entry appears in the dropdown next to the + New project button. Templates accept {today}, {conception}, {conceptionPath}. Agent (when set) spawns a fresh tab — e.g. bind 'Start new project' to claude-deepseek-v4-pro to get a fresh agent shell on every click."
        idPrefix={`${idPrefix}.newProjectActions`}
        bindText={props.bindText}
        items={props.newProjectActions}
        patch={props.patchNewProjectAction}
        add={props.addNewProjectAction}
        remove={props.removeNewProjectAction}
        move={props.moveNewProjectAction}
      />

      <Subgroup
        id={subgroupId('font')}
        title="Font"
        keywords="font family size line height letter spacing weight bold"
      >
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
      </Subgroup>

      <Subgroup
        id={subgroupId('cursor-buffer')}
        title="Cursor & buffer"
        keywords="cursor blink style scrollback ligatures buffer"
      >
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
              placeholder="5000"
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
      </Subgroup>

      <Subgroup
        id={subgroupId('colours')}
        title="Colours"
        keywords="colour color ansi foreground background cursor selection palette hex theme"
      >
        <p class="settings-hint">
          Leave a field blank to inherit the active theme. Values are CSS colours (hex, named,{' '}
          <code>color-mix(...)</code>).
        </p>
        <div class="settings-color-grid">
          <For each={TERMINAL_COLORS}>
            {(entry) => (
              <ColorField
                entry={entry}
                idPrefix={idPrefix}
                value={() => props.xterm().colors?.[entry.key]}
                bindText={props.bindText}
                onChange={(v) => props.updateColor(entry.key, v)}
              />
            )}
          </For>
        </div>
        <TerminalColorPreview xterm={props.xterm} />
      </Subgroup>

      <Subgroup
        id={subgroupId('logging')}
        title="Logging"
        keywords="logging record session transcript retention disk size scrollback privacy timestamp interval marker"
      >
        <p class="settings-hint">
          Off by default for privacy. When enabled, every terminal tab records its rendered output
          to <code>.condash/logs/YYYY/MM/DD/HHMMSS-&lt;id&gt;.txt</code> with sidecar
          <code> .meta.json</code>. The <code> .condash/</code> tree is gitignored by default.
          Toggling off does not delete past transcripts — the Logs pane keeps browsing them.
        </p>
        <div class="settings-grid">
          <label class="settings-checkbox">
            <input
              type="checkbox"
              checked={loggingEnabled()}
              onChange={(e) => void props.updateLogging({ enabled: e.currentTarget.checked })}
            />
            <span>Record terminal sessions to disk</span>
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
            <span>Scrollback (lines)</span>
            <input
              type="number"
              min="100"
              value={logging().scrollback ?? ''}
              placeholder="5000"
              onChange={(e) =>
                void props.updateLogging({
                  scrollback: e.currentTarget.value ? Number(e.currentTarget.value) : undefined,
                })
              }
            />
            <small class="settings-field-hint">
              How many lines the headless xterm retains per session. Larger → bigger
              <code> .txt</code> files; smaller → older output rolls off the top.
            </small>
          </label>
          <label>
            <span>Timestamp interval (seconds)</span>
            <input
              type="number"
              min="0"
              value={logging().markerIntervalSec ?? ''}
              placeholder="60"
              onChange={(e) =>
                void props.updateLogging({
                  markerIntervalSec: e.currentTarget.value
                    ? Number(e.currentTarget.value)
                    : undefined,
                })
              }
            />
            <small class="settings-field-hint">
              How often a <code>&lt;!-- timestamp --&gt;</code> marker is written, but only when new
              output has arrived since the last one — an idle session is never stamped.
              <code> 0</code> disables periodic markers.
            </small>
          </label>
        </div>
      </Subgroup>
    </>
  );
}
