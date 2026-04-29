import {
  createEffect,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from 'solid-js';
import type { Theme } from '@shared/types';
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
type Tab = 'general' | 'config' | 'shortcuts';

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
