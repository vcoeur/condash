import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from 'solid-js';
import type { TerminalXtermPrefs, Theme } from '@shared/types';
import type { MountedEditor } from './editor';

/**
 * Tabbed Settings modal. Replaces the previous gear-icon shortcut that opened
 * NoteModal directly on `configuration.json` — settings now live under three
 * topical tabs:
 *
 *  - **General** — theme picker (replaces the in-toolbar cycle button).
 *  - **configuration.json** — CodeMirror-backed JSON editor with parse-on-save.
 *  - **Shortcuts** — read-only display of the current `terminal.*_shortcut`
 *    values pulled from configuration.json.
 *
 * The configuration tab wires through the same note.read / note.write IPC the
 * NoteModal used so persistence behaviour and validation are unchanged.
 */
type Tab = 'general' | 'terminal' | 'config' | 'shortcuts';

interface ColorEntry {
  key: keyof NonNullable<TerminalXtermPrefs['colors']>;
  label: string;
}

const TERMINAL_COLORS: ColorEntry[] = [
  { key: 'foreground', label: 'Foreground' },
  { key: 'background', label: 'Background' },
  { key: 'cursor', label: 'Cursor' },
  { key: 'cursor_accent', label: 'Cursor accent' },
  { key: 'selection_background', label: 'Selection bg' },
  { key: 'black', label: 'ANSI black' },
  { key: 'red', label: 'ANSI red' },
  { key: 'green', label: 'ANSI green' },
  { key: 'yellow', label: 'ANSI yellow' },
  { key: 'blue', label: 'ANSI blue' },
  { key: 'magenta', label: 'ANSI magenta' },
  { key: 'cyan', label: 'ANSI cyan' },
  { key: 'white', label: 'ANSI white' },
  { key: 'bright_black', label: 'Bright black' },
  { key: 'bright_red', label: 'Bright red' },
  { key: 'bright_green', label: 'Bright green' },
  { key: 'bright_yellow', label: 'Bright yellow' },
  { key: 'bright_blue', label: 'Bright blue' },
  { key: 'bright_magenta', label: 'Bright magenta' },
  { key: 'bright_cyan', label: 'Bright cyan' },
  { key: 'bright_white', label: 'Bright white' },
];

const CURSOR_STYLES: { value: 'block' | 'underline' | 'bar'; label: string }[] = [
  { value: 'block', label: 'Block' },
  { value: 'underline', label: 'Underline' },
  { value: 'bar', label: 'Bar' },
];

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const SHORTCUT_FIELDS: { key: string; label: string; fallback: string }[] = [
  { key: 'shortcut', label: 'Toggle terminal pane', fallback: 'Ctrl+`' },
  { key: 'move_tab_left_shortcut', label: 'Move tab left', fallback: 'Ctrl+Left' },
  { key: 'move_tab_right_shortcut', label: 'Move tab right', fallback: 'Ctrl+Right' },
  { key: 'screenshot_paste_shortcut', label: 'Paste latest screenshot path', fallback: '(unset)' },
];

let editorModulePromise: Promise<typeof import('./editor')> | null = null;
function loadEditor(): Promise<typeof import('./editor')> {
  if (!editorModulePromise) editorModulePromise = import('./editor');
  return editorModulePromise;
}

export function SettingsModal(props: {
  configurationPath: string;
  theme: Theme;
  onChangeTheme: (theme: Theme) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = createSignal<Tab>('general');
  const [draft, setDraft] = createSignal('');
  const [dirty, setDirty] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [savedAt, setSavedAt] = createSignal<number | null>(null);

  const [content, { mutate: mutateContent, refetch }] = createResource(
    () => props.configurationPath,
    (path) => window.condash.readNote(path),
  );

  const handleKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      if (dirty() && !window.confirm('Unsaved changes — close anyway?')) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      props.onClose();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && tab() === 'config') {
      e.preventDefault();
      void save();
    }
  };

  onMount(() => document.addEventListener('keydown', handleKeydown, true));
  onCleanup(() => {
    document.removeEventListener('keydown', handleKeydown, true);
    if (editor) editor.destroy();
  });

  let editorParent: HTMLDivElement | undefined;
  let editor: MountedEditor | null = null;
  let mounting = false;

  createEffect(() => {
    const text = content();
    if (tab() === 'config' && editorParent && text != null && !editor && !mounting) {
      mounting = true;
      const parent = editorParent;
      const initial = text;
      void loadEditor()
        .then(({ mountEditor }) => {
          if (tab() !== 'config') {
            mounting = false;
            return;
          }
          editor = mountEditor({
            parent,
            initial,
            language: 'json',
            onSave: () => void save(),
            onChange: (next) => {
              setDraft(next);
              setDirty(next !== content());
            },
          });
          setDraft(initial);
          setDirty(false);
          mounting = false;
        })
        .catch((err) => {
          mounting = false;
          setError(`Failed to load editor: ${(err as Error).message}`);
        });
    }
    if (tab() !== 'config' && editor) {
      editor.destroy();
      editor = null;
    }
  });

  const save = async (): Promise<void> => {
    if (tab() !== 'config') return;
    const expected = content() ?? '';
    const next = draft();
    setError(null);
    try {
      JSON.parse(next);
    } catch (err) {
      setError(`Invalid JSON: ${(err as Error).message}`);
      return;
    }
    try {
      await window.condash.writeNote(props.configurationPath, expected, next);
      mutateContent(next);
      setDirty(false);
      setSavedAt(Date.now());
      setTimeout(() => setSavedAt((t) => (t && Date.now() - t > 1200 ? null : t)), 1500);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const reload = async (): Promise<void> => {
    setError(null);
    setDirty(false);
    if (editor) {
      editor.destroy();
      editor = null;
    }
    await refetch();
  };

  const handleBackdropClose = (): void => {
    if (dirty() && !window.confirm('Unsaved changes — close anyway?')) return;
    props.onClose();
  };

  // Best-effort: parse the current configuration.json (after any pending edits
  // are saved this matches disk) to surface the shortcut values. We re-run on
  // every content() change so reload picks up an external edit.
  const shortcuts = (): Record<string, string> => {
    const text = content();
    if (!text) return {};
    try {
      const parsed = JSON.parse(text) as { terminal?: Record<string, string> };
      return parsed.terminal ?? {};
    } catch {
      return {};
    }
  };

  // Parse `terminal.xterm` from the live config so the Terminal tab can edit
  // it without going through the JSON editor. Updates round-trip through the
  // same `note.write` IPC the configuration tab uses.
  const xtermPrefs = createMemo<TerminalXtermPrefs>(() => {
    const text = content();
    if (!text) return {};
    try {
      const parsed = JSON.parse(text) as { terminal?: { xterm?: TerminalXtermPrefs } };
      return parsed.terminal?.xterm ?? {};
    } catch {
      return {};
    }
  });

  /** Apply a partial update to `terminal.xterm` and persist to disk. */
  const updateXterm = async (patch: Partial<TerminalXtermPrefs>): Promise<void> => {
    const text = content() ?? '';
    let parsed: Record<string, unknown>;
    try {
      parsed = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    } catch (err) {
      setError(`Invalid JSON in configuration.json — fix it before editing terminal settings.`);
      return;
    }
    const terminal = (parsed.terminal as Record<string, unknown> | undefined) ?? {};
    const xterm = (terminal.xterm as TerminalXtermPrefs | undefined) ?? {};
    const merged: TerminalXtermPrefs = { ...xterm, ...patch };
    if (patch.colors) {
      merged.colors = { ...(xterm.colors ?? {}), ...patch.colors };
    }
    // Drop empty/undefined leaves so the JSON file stays clean.
    for (const k of Object.keys(merged) as (keyof TerminalXtermPrefs)[]) {
      const v = merged[k];
      if (v === undefined || v === '' || v === null) delete merged[k];
    }
    if (merged.colors) {
      for (const k of Object.keys(merged.colors)) {
        const v = (merged.colors as Record<string, string | undefined>)[k];
        if (v === undefined || v === '') delete (merged.colors as Record<string, unknown>)[k];
      }
      if (Object.keys(merged.colors).length === 0) delete merged.colors;
    }
    const nextTerminal = { ...terminal, xterm: merged };
    if (Object.keys(merged).length === 0) delete (nextTerminal as Record<string, unknown>).xterm;
    const next = { ...parsed, terminal: nextTerminal };
    const serialised = JSON.stringify(next, null, 2) + '\n';
    setError(null);
    try {
      await window.condash.writeNote(props.configurationPath, text, serialised);
      mutateContent(serialised);
      setSavedAt(Date.now());
      setTimeout(() => setSavedAt((t) => (t && Date.now() - t > 1200 ? null : t)), 1500);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const updateColor = (key: ColorEntry['key'], value: string) =>
    void updateXterm({ colors: { [key]: value || undefined } as never });

  return (
    <div class="modal-backdrop" onClick={handleBackdropClose}>
      <div
        class="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <header class="modal-head">
          <span class="modal-title">Settings</span>
          <span class="modal-head-spacer" />
          <Show when={dirty()}>
            <span class="modal-dirty" title="Unsaved changes">
              ●
            </span>
          </Show>
          <Show when={savedAt() !== null}>
            <span class="modal-saved" title="Saved">
              ✓
            </span>
          </Show>
          <button
            class="modal-button"
            onClick={handleBackdropClose}
            title="Close (Esc)"
            aria-label="Close"
          >
            ×
          </button>
        </header>
        <nav class="settings-tabs" role="tablist">
          <button
            class="settings-tab"
            classList={{ active: tab() === 'general' }}
            role="tab"
            aria-selected={tab() === 'general'}
            onClick={() => setTab('general')}
          >
            General
          </button>
          <button
            class="settings-tab"
            classList={{ active: tab() === 'terminal' }}
            role="tab"
            aria-selected={tab() === 'terminal'}
            onClick={() => setTab('terminal')}
          >
            Terminal
          </button>
          <button
            class="settings-tab"
            classList={{ active: tab() === 'config' }}
            role="tab"
            aria-selected={tab() === 'config'}
            onClick={() => setTab('config')}
          >
            configuration.json
          </button>
          <button
            class="settings-tab"
            classList={{ active: tab() === 'shortcuts' }}
            role="tab"
            aria-selected={tab() === 'shortcuts'}
            onClick={() => setTab('shortcuts')}
          >
            Shortcuts
          </button>
        </nav>
        <Show when={error()}>
          <div class="modal-error">{error()}</div>
        </Show>
        <div class="settings-body">
          <Show when={tab() === 'general'}>
            <section class="settings-section">
              <h3>Theme</h3>
              <div class="settings-radio-group" role="radiogroup">
                <For each={THEME_OPTIONS}>
                  {(opt) => (
                    <label class="settings-radio">
                      <input
                        type="radio"
                        name="theme"
                        checked={props.theme === opt.value}
                        onChange={() => props.onChangeTheme(opt.value)}
                      />
                      <span>{opt.label}</span>
                    </label>
                  )}
                </For>
              </div>
            </section>
          </Show>
          <Show when={tab() === 'terminal'}>
            <section class="settings-section settings-terminal">
              <p class="settings-hint">
                Live-edits the <code>terminal.xterm</code> block in configuration.json. Changes
                apply to <strong>new</strong> terminal tabs; existing tabs keep their original
                settings until they're closed and reopened.
              </p>
              <h3>Font</h3>
              <div class="settings-grid">
                <label>
                  <span>Font family</span>
                  <input
                    type="text"
                    value={xtermPrefs().font_family ?? ''}
                    placeholder="ui-monospace, Menlo, Consolas, monospace"
                    onChange={(e) => void updateXterm({ font_family: e.currentTarget.value })}
                  />
                </label>
                <label>
                  <span>Font size (px)</span>
                  <input
                    type="number"
                    min="6"
                    max="48"
                    value={xtermPrefs().font_size ?? ''}
                    placeholder="12"
                    onChange={(e) =>
                      void updateXterm({
                        font_size: e.currentTarget.value
                          ? Number(e.currentTarget.value)
                          : undefined,
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
                    value={xtermPrefs().line_height ?? ''}
                    placeholder="1.0"
                    onChange={(e) =>
                      void updateXterm({
                        line_height: e.currentTarget.value
                          ? Number(e.currentTarget.value)
                          : undefined,
                      })
                    }
                  />
                </label>
                <label>
                  <span>Letter spacing (px)</span>
                  <input
                    type="number"
                    step="0.5"
                    value={xtermPrefs().letter_spacing ?? ''}
                    placeholder="0"
                    onChange={(e) =>
                      void updateXterm({
                        letter_spacing: e.currentTarget.value
                          ? Number(e.currentTarget.value)
                          : undefined,
                      })
                    }
                  />
                </label>
                <label>
                  <span>Font weight</span>
                  <input
                    type="text"
                    value={String(xtermPrefs().font_weight ?? '')}
                    placeholder="normal | 400 | 500"
                    onChange={(e) =>
                      void updateXterm({ font_weight: e.currentTarget.value || undefined })
                    }
                  />
                </label>
                <label>
                  <span>Bold weight</span>
                  <input
                    type="text"
                    value={String(xtermPrefs().font_weight_bold ?? '')}
                    placeholder="bold | 600 | 700"
                    onChange={(e) =>
                      void updateXterm({ font_weight_bold: e.currentTarget.value || undefined })
                    }
                  />
                </label>
              </div>
              <h3>Cursor & buffer</h3>
              <div class="settings-grid">
                <label>
                  <span>Cursor style</span>
                  <select
                    value={xtermPrefs().cursor_style ?? 'block'}
                    onChange={(e) =>
                      void updateXterm({
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
                    checked={xtermPrefs().cursor_blink !== false}
                    onChange={(e) => void updateXterm({ cursor_blink: e.currentTarget.checked })}
                  />
                  <span>Cursor blink</span>
                </label>
                <label>
                  <span>Scrollback (lines)</span>
                  <input
                    type="number"
                    min="0"
                    max="100000"
                    value={xtermPrefs().scrollback ?? ''}
                    placeholder="10000"
                    onChange={(e) =>
                      void updateXterm({
                        scrollback: e.currentTarget.value
                          ? Number(e.currentTarget.value)
                          : undefined,
                      })
                    }
                  />
                </label>
                <label class="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={xtermPrefs().ligatures === true}
                    onChange={(e) =>
                      void updateXterm({ ligatures: e.currentTarget.checked || undefined })
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
                        value={xtermPrefs().colors?.[entry.key] ?? ''}
                        placeholder="—"
                        onChange={(e) => updateColor(entry.key, e.currentTarget.value)}
                      />
                    </label>
                  )}
                </For>
              </div>
            </section>
          </Show>
          <Show when={tab() === 'config'}>
            <div class="settings-config">
              <div class="settings-config-toolbar">
                <button
                  class="modal-button"
                  onClick={() => void save()}
                  disabled={!dirty()}
                  title="Save (Ctrl+S)"
                >
                  Save
                </button>
                <button class="modal-button" onClick={() => void reload()} title="Reload from disk">
                  Reload
                </button>
                <span class="settings-config-path" title={props.configurationPath}>
                  {props.configurationPath}
                </span>
              </div>
              <Show when={content.loading}>
                <div class="empty">Loading…</div>
              </Show>
              <Show when={content.error}>
                <div class="empty warn">Failed to read: {(content.error as Error).message}</div>
              </Show>
              <Show when={!content.loading && !content.error}>
                <div class="cm-host settings-cm-host" ref={(el) => (editorParent = el)} />
              </Show>
            </div>
          </Show>
          <Show when={tab() === 'shortcuts'}>
            <section class="settings-section">
              <p class="settings-hint">
                Read-only — edit them in the <code>terminal</code> section of the configuration.json
                tab.
              </p>
              <table class="settings-shortcuts">
                <tbody>
                  <For each={SHORTCUT_FIELDS}>
                    {(row) => (
                      <tr>
                        <th>{row.label}</th>
                        <td>
                          <code>{shortcuts()[row.key] ?? row.fallback}</code>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </section>
          </Show>
        </div>
      </div>
    </div>
  );
}
