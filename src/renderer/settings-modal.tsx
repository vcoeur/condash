import { createMemo, createResource, createSignal, For, Show } from 'solid-js';
import { onMount, onCleanup } from 'solid-js';
import type { Platform, TerminalPrefs, TerminalXtermPrefs, Theme } from '@shared/types';
import type { RawRepo } from '../main/config-schema';

/**
 * Full-viewport Settings modal. Every persisted preference has its own
 * editable control — there is no in-modal JSON editor. Power users get a
 * single "Open configuration.json externally" button in the header that
 * shells out via `window.condash.openPath`.
 *
 * Writes are funnelled through `patchConfig`, which parses the live file,
 * applies a mutator, drops empty leaves, and round-trips through the
 * `note.write` IPC's atomic CAS so the schema-validation path stays the
 * same.
 */
type Section = 'workspace' | 'repositories' | 'open-with' | 'terminal' | 'appearance';

type SectionGroup = 'config' | 'machine';

interface SectionMeta {
  id: Section;
  label: string;
  group: SectionGroup;
}

const SECTIONS: SectionMeta[] = [
  { id: 'appearance', label: 'Appearance', group: 'machine' },
  { id: 'terminal', label: 'Terminal', group: 'machine' },
  { id: 'workspace', label: 'Workspace', group: 'config' },
  { id: 'repositories', label: 'Repositories', group: 'config' },
  { id: 'open-with', label: 'Open with', group: 'config' },
];

interface GroupMeta {
  id: SectionGroup;
  label: string;
  file: string;
  hint: string;
}

const GROUPS: GroupMeta[] = [
  {
    id: 'machine',
    label: 'Global Condash Settings',
    file: 'settings.json',
    hint: 'Stored in ~/.config/condash/ on this machine only — not synced.',
  },
  {
    id: 'config',
    label: 'Conception Configuration',
    file: 'configuration.json',
    hint: 'Lives in the conception repo and is shared across machines.',
  },
];

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

const OPEN_WITH_SLOTS: { key: 'main_ide' | 'secondary_ide' | 'terminal'; label: string }[] = [
  { key: 'main_ide', label: 'Main IDE' },
  { key: 'secondary_ide', label: 'Secondary IDE' },
  { key: 'terminal', label: 'Terminal' },
];

type TerminalStringFieldKey =
  | 'shell'
  | 'shortcut'
  | 'screenshot_dir'
  | 'screenshot_paste_shortcut'
  | 'launcher_command'
  | 'move_tab_left_shortcut'
  | 'move_tab_right_shortcut';

interface TerminalStringField {
  key: TerminalStringFieldKey;
  label: string;
  /** Per-OS placeholder. `default` is used when the platform is unknown. */
  placeholder: Partial<Record<Platform | 'default', string>>;
  hint?: string;
}

const TERMINAL_STRING_FIELDS: TerminalStringField[] = [
  {
    key: 'shell',
    label: 'Shell',
    placeholder: { linux: '/bin/bash', darwin: '/bin/zsh', win32: 'cmd.exe', default: '/bin/bash' },
  },
  {
    key: 'launcher_command',
    label: 'Launcher command',
    placeholder: { default: 'claude' },
    hint: 'Run on terminal-tab open before any user input.',
  },
  {
    key: 'screenshot_dir',
    label: 'Screenshot directory',
    placeholder: {
      linux: '/home/you/Pictures/Screenshots',
      darwin: '~/Pictures/Screenshots',
      win32: 'C:\\Users\\you\\Pictures\\Screenshots',
      default: '~/Pictures/Screenshots',
    },
  },
  { key: 'shortcut', label: 'Toggle terminal pane', placeholder: { default: 'Ctrl+`' } },
  {
    key: 'screenshot_paste_shortcut',
    label: 'Paste latest screenshot path',
    placeholder: { default: 'Ctrl+Shift+V' },
  },
  { key: 'move_tab_left_shortcut', label: 'Move tab left', placeholder: { default: 'Ctrl+Left' } },
  {
    key: 'move_tab_right_shortcut',
    label: 'Move tab right',
    placeholder: { default: 'Ctrl+Right' },
  },
];

const WORKSPACE_PLACEHOLDER: Partial<Record<Platform | 'default', string>> = {
  linux: '/home/you/src/vcoeur',
  darwin: '~/src/vcoeur',
  win32: 'C:\\Users\\you\\src\\vcoeur',
  default: '~/src/vcoeur',
};

const WORKTREES_PLACEHOLDER: Partial<Record<Platform | 'default', string>> = {
  linux: '/home/you/src/worktrees',
  darwin: '~/src/worktrees',
  win32: 'C:\\Users\\you\\src\\worktrees',
  default: '~/src/worktrees',
};

function pick(
  table: Partial<Record<Platform | 'default', string>>,
  platform: Platform | undefined,
): string {
  if (platform && table[platform]) return table[platform] as string;
  return table.default ?? '';
}

interface RawConfig {
  $schema_doc?: string;
  workspace_path?: string;
  worktrees_path?: string;
  repositories?: { primary?: RawRepo[]; secondary?: RawRepo[] };
  open_with?: Record<string, { label?: string; command?: string }>;
}

/**
 * Repository entries that carry only `{ name }` (no label / run / force_stop /
 * submodules) collapse back to the bare-string shape on save. The full
 * editor renders both shapes the same way, but configuration.json keeps its
 * compact form for entries that don't need extra fields.
 */
function compactRepos(repos: RawRepo[]): RawRepo[] {
  return repos.map((entry) => {
    if (typeof entry === 'string') return entry;
    const copy: Exclude<RawRepo, string> = { ...entry };
    if (copy.submodules) {
      copy.submodules = compactRepos(copy.submodules);
      if (copy.submodules.length === 0) delete copy.submodules;
    }
    const extras = (Object.keys(copy) as (keyof typeof copy)[]).filter(
      (k) => k !== 'name' && copy[k] !== undefined && copy[k] !== '',
    );
    if (extras.length === 0) return copy.name;
    return copy;
  });
}

/** Strip undefined / empty-string / null leaves so the JSON file stays clean. */
function pruneEmpty(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(pruneEmpty).filter((v) => v !== undefined);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const pruned = pruneEmpty(v);
      if (pruned === undefined || pruned === '' || pruned === null) continue;
      if (typeof pruned === 'object' && !Array.isArray(pruned)) {
        if (Object.keys(pruned as Record<string, unknown>).length === 0) continue;
      }
      out[k] = pruned;
    }
    return out;
  }
  return value;
}

export function SettingsModal(props: {
  configurationPath: string;
  theme: Theme;
  onChangeTheme: (theme: Theme) => void;
  onClose: () => void;
}) {
  const [section, setSection] = createSignal<Section>('appearance');
  const [error, setError] = createSignal<string | null>(null);
  const [savedAt, setSavedAt] = createSignal<number | null>(null);
  const [pending, setPending] = createSignal(false);

  // Buffered text-input drafts. Each text field updates a draft on `onInput`
  // and commits on `onChange` (blur / Enter). The dirty signal drives the
  // back-arrow confirm dialog: drafts present means there are typed-but-
  // unblurred edits that haven't reached disk yet.
  const [drafts, setDrafts] = createSignal<Record<string, string>>({});
  const [closeConfirm, setCloseConfirm] = createSignal(false);

  const isDirty = (): boolean => Object.keys(drafts()).length > 0;

  const [content, { mutate: mutateContent }] = createResource(
    () => props.configurationPath,
    (path) => window.condash.readNote(path),
  );

  // Used to pick OS-appropriate placeholder text for path / shell fields.
  // Falls back to "default" entries until the IPC resolves.
  const [appInfo] = createResource(
    () => true,
    () => window.condash.getAppInfo(),
  );
  const platform = (): Platform | undefined => appInfo()?.platform;

  const attemptClose = (): void => {
    if (isDirty()) {
      setCloseConfirm(true);
      return;
    }
    props.onClose();
  };

  const handleKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (closeConfirm()) {
        setCloseConfirm(false);
        return;
      }
      attemptClose();
    }
  };

  onMount(() => document.addEventListener('keydown', handleKeydown, true));
  onCleanup(() => document.removeEventListener('keydown', handleKeydown, true));

  const parsed = createMemo<RawConfig>(() => {
    const text = content();
    if (!text) return {};
    try {
      return JSON.parse(text) as RawConfig;
    } catch {
      return {};
    }
  });

  const parseError = createMemo<string | null>(() => {
    const text = content();
    if (!text) return null;
    try {
      JSON.parse(text);
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  });

  /**
   * Apply `mutator` to the parsed configuration, drop empty leaves, and
   * persist via the same atomic CAS path the JSON-editor tab used.
   */
  const patchConfig = async (mutator: (config: RawConfig) => void): Promise<void> => {
    const text = content() ?? '';
    let parsedConfig: RawConfig;
    try {
      parsedConfig = (text ? JSON.parse(text) : {}) as RawConfig;
    } catch (err) {
      setError(
        `configuration.json is invalid: ${(err as Error).message}. Open it externally to repair.`,
      );
      return;
    }
    mutator(parsedConfig);
    const pruned = pruneEmpty(parsedConfig) as RawConfig;
    if (pruned.repositories?.primary) {
      pruned.repositories.primary = compactRepos(pruned.repositories.primary);
    }
    if (pruned.repositories?.secondary) {
      pruned.repositories.secondary = compactRepos(pruned.repositories.secondary);
    }
    const next = JSON.stringify(pruned, null, 2) + '\n';
    if (next === text) return;
    setError(null);
    setPending(true);
    try {
      // configuration.json is canonicalised through the Zod schema on the
      // main side, so the bytes that reach disk can differ from `next`
      // (e.g. Zod reorders new keys into schema order). Cache the actual
      // written content so the next save's CAS baseline matches disk.
      const written = await window.condash.writeNote(props.configurationPath, text, next);
      mutateContent(written);
      setSavedAt(Date.now());
      setTimeout(() => setSavedAt((t) => (t && Date.now() - t > 1200 ? null : t)), 1500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  };

  const openConfigExternally = (): void => {
    void window.condash.openPath(props.configurationPath);
  };

  const [settingsPath] = createResource(() => window.condash.getSettingsPath());

  const openSettingsExternally = (): void => {
    const path = settingsPath();
    if (path) void window.condash.openPath(path);
  };

  // --- Draft-buffered text input -------------------------------------

  // Maps each text-field id to its current commit handler so that the
  // close-confirm "Save and close" path can flush all uncommitted drafts
  // in one go without re-deriving each field's save logic.
  const draftSavers = new Map<string, (value: string) => Promise<void>>();

  /**
   * Bind a text input to the draft buffer + commit-on-blur flow.
   * Returns the props an `<input>` should spread: value, onInput, onChange.
   */
  const bindText = (
    id: string,
    persisted: () => string | undefined,
    save: (value: string) => Promise<void>,
  ): {
    value: string;
    onInput: (e: InputEvent & { currentTarget: HTMLInputElement }) => void;
    onChange: (e: Event & { currentTarget: HTMLInputElement }) => void;
  } => {
    draftSavers.set(id, save);
    return {
      value: drafts()[id] ?? persisted() ?? '',
      onInput: (e) => {
        const next = e.currentTarget.value;
        setDrafts((d) => ({ ...d, [id]: next }));
      },
      onChange: (e) => {
        const next = e.currentTarget.value;
        setDrafts((d) => {
          const copy = { ...d };
          delete copy[id];
          return copy;
        });
        void save(next);
      },
    };
  };

  /** Flush every draft to disk in parallel; resolve once all writes settle. */
  const flushDrafts = async (): Promise<void> => {
    const snapshot = drafts();
    const ids = Object.keys(snapshot);
    if (ids.length === 0) return;
    setDrafts({});
    await Promise.all(
      ids.map((id) => {
        const saver = draftSavers.get(id);
        return saver ? saver(snapshot[id]) : Promise.resolve();
      }),
    );
  };

  const handleSaveAndClose = async (): Promise<void> => {
    setCloseConfirm(false);
    await flushDrafts();
    props.onClose();
  };

  const handleDiscardAndClose = (): void => {
    setDrafts({});
    setCloseConfirm(false);
    props.onClose();
  };

  // --- Workspace -------------------------------------------------------

  const setWorkspacePath = (value: string): Promise<void> =>
    patchConfig((c) => {
      c.workspace_path = value || undefined;
    });

  const setWorktreesPath = (value: string): Promise<void> =>
    patchConfig((c) => {
      c.worktrees_path = value || undefined;
    });

  // --- Repositories ----------------------------------------------------

  type RepoBucket = 'primary' | 'secondary';

  const repos = (bucket: RepoBucket): RawRepo[] => parsed().repositories?.[bucket] ?? [];

  const updateRepos = (
    bucket: RepoBucket,
    mutate: (entries: RawRepo[]) => RawRepo[],
  ): Promise<void> =>
    patchConfig((c) => {
      const repositories = (c.repositories ?? {}) as {
        primary?: RawRepo[];
        secondary?: RawRepo[];
      };
      const current = (repositories[bucket] ?? []).slice();
      repositories[bucket] = mutate(current);
      c.repositories = repositories;
    });

  const addRepo = (bucket: RepoBucket): Promise<void> =>
    updateRepos(bucket, (entries) => [...entries, { name: '' }]);

  const removeRepo = (bucket: RepoBucket, index: number): Promise<void> =>
    updateRepos(bucket, (entries) => entries.filter((_, i) => i !== index));

  const moveRepo = (bucket: RepoBucket, index: number, delta: -1 | 1): Promise<void> =>
    updateRepos(bucket, (entries) => {
      const target = index + delta;
      if (target < 0 || target >= entries.length) return entries;
      const next = entries.slice();
      const [removed] = next.splice(index, 1);
      next.splice(target, 0, removed);
      return next;
    });

  const updateRepoEntry = (
    bucket: RepoBucket,
    index: number,
    patch: (entry: RawRepo) => RawRepo,
  ): Promise<void> =>
    updateRepos(bucket, (entries) => entries.map((e, i) => (i === index ? patch(e) : e)));

  // --- Open with -------------------------------------------------------

  const updateOpenWithSlot = (
    key: 'main_ide' | 'secondary_ide' | 'terminal',
    patch: { label?: string; command?: string },
  ): Promise<void> =>
    patchConfig((c) => {
      const openWith = (c.open_with ?? {}) as Record<string, { label?: string; command?: string }>;
      const current = openWith[key] ?? {};
      const merged = { ...current, ...patch };
      if (!merged.command) {
        delete openWith[key];
      } else {
        openWith[key] = merged;
      }
      c.open_with = openWith;
    });

  // --- Terminal (settings.json — per-machine) -------------------------

  const [terminalRes, { mutate: mutateTerminal }] = createResource<TerminalPrefs>(() =>
    window.condash.termGetPrefs(),
  );

  const terminalPrefs = (): TerminalPrefs => terminalRes() ?? {};

  /**
   * Apply `mutator` to the persisted terminal prefs in settings.json,
   * drop empty leaves, and round-trip through `term.setPrefs`.
   */
  const patchTerminal = async (mutator: (prefs: TerminalPrefs) => TerminalPrefs): Promise<void> => {
    const next = mutator({ ...terminalPrefs() });
    const pruned = (pruneEmpty(next) as TerminalPrefs) ?? {};
    setError(null);
    setPending(true);
    try {
      await window.condash.termSetPrefs(pruned);
      mutateTerminal(pruned);
      setSavedAt(Date.now());
      setTimeout(() => setSavedAt((t) => (t && Date.now() - t > 1200 ? null : t)), 1500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  };

  const setTerminalString = (
    key: (typeof TERMINAL_STRING_FIELDS)[number]['key'],
    value: string,
  ): Promise<void> =>
    patchTerminal((p) => {
      const next = { ...p } as Record<string, unknown>;
      next[key] = value || undefined;
      return next as TerminalPrefs;
    });

  const xtermPrefs = createMemo<TerminalXtermPrefs>(() => terminalPrefs().xterm ?? {});

  const updateXterm = (patch: Partial<TerminalXtermPrefs>): Promise<void> =>
    patchTerminal((p) => {
      const xterm = (p.xterm ?? {}) as TerminalXtermPrefs;
      const merged: TerminalXtermPrefs = { ...xterm, ...patch };
      if (patch.colors) {
        merged.colors = { ...(xterm.colors ?? {}), ...patch.colors };
      }
      return { ...p, xterm: merged };
    });

  const updateColor = (key: ColorEntry['key'], value: string): void =>
    void updateXterm({ colors: { [key]: value || undefined } as never });

  const scrollToSection = (id: Section): void => {
    setSection(id);
    const el = document.getElementById(`settings-section-${id}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div class="modal-backdrop settings-modal-backdrop" onClick={attemptClose}>
      <div
        class="modal settings-modal settings-modal--full"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <header class="modal-head settings-head">
          <button class="settings-back" onClick={attemptClose} title="Back (Esc)" aria-label="Back">
            <span class="settings-back-arrow" aria-hidden="true">
              ←
            </span>
            <span>Back</span>
          </button>
          <span class="modal-title">Settings</span>
          <Show when={pending()}>
            <span class="modal-saving" title="Saving">
              …
            </span>
          </Show>
          <Show when={savedAt() !== null && !pending()}>
            <span class="modal-saved" title="Saved">
              ✓
            </span>
          </Show>
          <Show when={isDirty() && !pending()}>
            <span class="modal-dirty" title="Unsaved edits in a focused field">
              ●
            </span>
          </Show>
          <span class="settings-head-spacer" />
        </header>
        <Show when={parseError()}>
          <div class="modal-error">
            configuration.json failed to parse — {parseError()}. Edit it externally to repair.
          </div>
        </Show>
        <Show when={error()}>
          <div class="modal-error">{error()}</div>
        </Show>
        <div class="settings-shell">
          <nav class="settings-rail" aria-label="Settings sections">
            <For each={GROUPS}>
              {(g) => (
                <div class="settings-rail-group">
                  <div class="settings-rail-group-heading">
                    <span class="settings-rail-group-label">{g.label}</span>
                    <code>{g.file}</code>
                  </div>
                  <ul class="settings-rail-list">
                    <For each={SECTIONS.filter((s) => s.group === g.id)}>
                      {(s) => (
                        <li>
                          <button
                            class="settings-rail-item"
                            classList={{ active: section() === s.id }}
                            onClick={() => scrollToSection(s.id)}
                          >
                            {s.label}
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              )}
            </For>
          </nav>
          <div
            class="settings-scroll"
            onScroll={(e) => {
              const top = e.currentTarget.scrollTop + 8;
              let active: Section = 'appearance';
              for (const s of SECTIONS) {
                const el = document.getElementById(`settings-section-${s.id}`);
                if (el && el.offsetTop - e.currentTarget.offsetTop <= top) {
                  active = s.id;
                }
              }
              if (active !== section()) setSection(active);
            }}
          >
            {/* Group: settings.json (machine, first) -------------------- */}
            <header class="settings-group-divider">
              <h2>Global Condash Settings</h2>
              <code>settings.json</code>
              <span class="settings-group-divider-actions">
                <button
                  class="modal-button"
                  onClick={() => void flushDrafts()}
                  disabled={!isDirty()}
                  title="Flush any focused-but-unblurred edits to disk"
                >
                  Save
                </button>
                <button
                  class="modal-button"
                  onClick={openSettingsExternally}
                  title="Open settings.json with the OS default editor"
                >
                  Open externally
                </button>
              </span>
              <span class="settings-group-divider-hint">
                Stored in <code>~/.config/condash/</code>; per-machine, not synced.
              </span>
            </header>

            {/* Appearance ----------------------------------------------- */}
            <section id="settings-section-appearance" class="settings-section">
              <h2>Appearance</h2>
              <div class="settings-field">
                <span class="settings-field-label">Theme</span>
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
              </div>
            </section>

            {/* Terminal (settings.json — per-machine) ------------------ */}
            <section id="settings-section-terminal" class="settings-section">
              <h2>Terminal</h2>
              <h3>Behaviour &amp; shortcuts</h3>
              <div class="settings-grid">
                <For each={TERMINAL_STRING_FIELDS}>
                  {(field) => (
                    <label>
                      <span>{field.label}</span>
                      <input
                        type="text"
                        placeholder={pick(field.placeholder, platform())}
                        {...bindText(
                          `terminal.${field.key}`,
                          () =>
                            (terminalPrefs() as Record<string, unknown>)[field.key] as
                              | string
                              | undefined,
                          (v) => setTerminalString(field.key, v),
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
                    {...bindText(
                      'xterm.font_family',
                      () => xtermPrefs().font_family,
                      (v) => updateXterm({ font_family: v || undefined }),
                    )}
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
                    placeholder="normal | 400 | 500"
                    {...bindText(
                      'xterm.font_weight',
                      () =>
                        xtermPrefs().font_weight !== undefined
                          ? String(xtermPrefs().font_weight)
                          : undefined,
                      (v) => updateXterm({ font_weight: v || undefined }),
                    )}
                  />
                </label>
                <label>
                  <span>Bold weight</span>
                  <input
                    type="text"
                    placeholder="bold | 600 | 700"
                    {...bindText(
                      'xterm.font_weight_bold',
                      () =>
                        xtermPrefs().font_weight_bold !== undefined
                          ? String(xtermPrefs().font_weight_bold)
                          : undefined,
                      (v) => updateXterm({ font_weight_bold: v || undefined }),
                    )}
                  />
                </label>
              </div>
              <h3>Cursor &amp; buffer</h3>
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
                        placeholder="—"
                        {...bindText(
                          `xterm.colors.${entry.key}`,
                          () => xtermPrefs().colors?.[entry.key],
                          (v) => {
                            updateColor(entry.key, v);
                            return Promise.resolve();
                          },
                        )}
                      />
                    </label>
                  )}
                </For>
              </div>
            </section>

            {/* Group: configuration.json (conception, second) ----------- */}
            <header class="settings-group-divider">
              <h2>Conception Configuration</h2>
              <code>configuration.json</code>
              <span class="settings-group-divider-actions">
                <button
                  class="modal-button"
                  onClick={() => void flushDrafts()}
                  disabled={!isDirty()}
                  title="Flush any focused-but-unblurred edits to disk"
                >
                  Save
                </button>
                <button
                  class="modal-button"
                  onClick={openConfigExternally}
                  title="Open configuration.json with the OS default editor"
                >
                  Open externally
                </button>
              </span>
              <span class="settings-group-divider-hint">
                Lives in the conception repo; shared across machines.
              </span>
            </header>

            {/* Workspace ------------------------------------------------ */}
            <section id="settings-section-workspace" class="settings-section">
              <h2>Workspace</h2>
              <div class="settings-grid settings-grid--wide">
                <label>
                  <span>Workspace path</span>
                  <input
                    type="text"
                    placeholder={pick(WORKSPACE_PLACEHOLDER, platform())}
                    {...bindText('workspace_path', () => parsed().workspace_path, setWorkspacePath)}
                  />
                </label>
                <label>
                  <span>Worktrees path</span>
                  <input
                    type="text"
                    placeholder={pick(WORKTREES_PLACEHOLDER, platform())}
                    {...bindText('worktrees_path', () => parsed().worktrees_path, setWorktreesPath)}
                  />
                </label>
              </div>
            </section>

            {/* Repositories -------------------------------------------- */}
            <section id="settings-section-repositories" class="settings-section">
              <h2>Repositories</h2>
              <p class="settings-hint">
                Each entry is either just a name (resolved against <code>workspace_path</code>) or
                an object with optional <code>label</code>, <code>run</code>,{' '}
                <code>force_stop</code>, and <code>submodules</code>.
              </p>
              <For each={['primary', 'secondary'] as const}>
                {(bucket) => (
                  <div class="settings-bucket">
                    <h3>{bucket === 'primary' ? 'Primary' : 'Secondary'}</h3>
                    <For each={repos(bucket)}>
                      {(entry, index) => (
                        <RepoRow
                          entry={entry}
                          idPrefix={`repo.${bucket}[${index()}]`}
                          index={index()}
                          total={repos(bucket).length}
                          bindText={bindText}
                          onMove={(delta) => void moveRepo(bucket, index(), delta)}
                          onRemove={() => void removeRepo(bucket, index())}
                          onPatch={(next) => updateRepoEntry(bucket, index(), () => next)}
                        />
                      )}
                    </For>
                    <div class="settings-list-actions">
                      <button class="modal-button" onClick={() => void addRepo(bucket)}>
                        + Add repo
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </section>

            {/* Open with ----------------------------------------------- */}
            <section id="settings-section-open-with" class="settings-section">
              <h2>Open with</h2>
              <p class="settings-hint">
                Three slots used by the per-folder &quot;Open in…&quot; menu.{' '}
                <code>{'{path}'}</code> is substituted with the absolute path. Clear the command to
                remove the slot.
              </p>
              <div class="settings-grid settings-grid--wide">
                <For each={OPEN_WITH_SLOTS}>
                  {(slot) => {
                    const current = (): { label?: string; command?: string } =>
                      parsed().open_with?.[slot.key] ?? {};
                    return (
                      <div class="settings-open-with">
                        <span class="settings-field-label">{slot.label}</span>
                        <input
                          type="text"
                          placeholder={`Open in ${slot.label.toLowerCase()}`}
                          {...bindText(
                            `open_with.${slot.key}.label`,
                            () => current().label,
                            (v) => updateOpenWithSlot(slot.key, { label: v }),
                          )}
                        />
                        <input
                          type="text"
                          placeholder="idea {path}"
                          {...bindText(
                            `open_with.${slot.key}.command`,
                            () => current().command,
                            (v) => updateOpenWithSlot(slot.key, { command: v }),
                          )}
                        />
                      </div>
                    );
                  }}
                </For>
              </div>
            </section>
          </div>
        </div>
        <Show when={closeConfirm()}>
          <div class="settings-confirm-backdrop" onClick={() => setCloseConfirm(false)}>
            <div
              class="settings-confirm"
              role="dialog"
              aria-modal="true"
              aria-label="Unsaved edits"
              onClick={(e) => e.stopPropagation()}
            >
              <h3>Save before closing?</h3>
              <p>You have edits in a focused field that haven't been written yet.</p>
              <div class="settings-confirm-actions">
                <button class="modal-button" onClick={() => setCloseConfirm(false)}>
                  Cancel
                </button>
                <button class="modal-button" onClick={handleDiscardAndClose}>
                  Discard
                </button>
                <button class="modal-button" onClick={() => void handleSaveAndClose()}>
                  Save and close
                </button>
              </div>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}

type BindTextFn = (
  id: string,
  persisted: () => string | undefined,
  save: (value: string) => Promise<void>,
) => {
  value: string;
  onInput: (e: InputEvent & { currentTarget: HTMLInputElement }) => void;
  onChange: (e: Event & { currentTarget: HTMLInputElement }) => void;
};

function moveItem<T>(arr: T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (target < 0 || target >= arr.length) return arr;
  const next = arr.slice();
  const [removed] = next.splice(index, 1);
  next.splice(target, 0, removed);
  return next;
}

/**
 * One row in a repositories list. Always shows the full editable surface
 * (name, label, run, force_stop, sub repos) regardless of how the entry
 * is currently serialized — string-form entries are coerced to object on
 * render. The recursive `submodules` UI lets a parent repo carry its own
 * nested list with the same shape.
 */
function RepoRow(props: {
  entry: RawRepo;
  idPrefix: string;
  index: number;
  total: number;
  bindText: BindTextFn;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  onPatch: (next: RawRepo) => Promise<void>;
}) {
  const obj = (): Exclude<RawRepo, string> =>
    typeof props.entry === 'string' ? { name: props.entry } : props.entry;

  const patchObj = (patch: Partial<Exclude<RawRepo, string>>): Promise<void> =>
    props.onPatch({ ...obj(), ...patch });

  const submodules = (): RawRepo[] => obj().submodules ?? [];

  const updateSubmodules = (mutate: (subs: RawRepo[]) => RawRepo[]): Promise<void> =>
    patchObj({ submodules: mutate(submodules()) });

  return (
    <div class="settings-repo-row">
      <div class="settings-repo-row-head">
        <input
          type="text"
          class="settings-repo-name"
          placeholder="repo-name"
          {...props.bindText(
            `${props.idPrefix}.name`,
            () => obj().name,
            (v) => patchObj({ name: v }),
          )}
        />
        <button
          class="modal-button"
          title="Move up"
          disabled={props.index === 0}
          onClick={() => props.onMove(-1)}
        >
          ↑
        </button>
        <button
          class="modal-button"
          title="Move down"
          disabled={props.index === props.total - 1}
          onClick={() => props.onMove(1)}
        >
          ↓
        </button>
        <button class="modal-button" title="Remove" onClick={() => props.onRemove()}>
          ×
        </button>
      </div>
      <div class="settings-repo-row-detail">
        <label>
          <span>Label</span>
          <input
            type="text"
            placeholder="Friendly subtitle"
            {...props.bindText(
              `${props.idPrefix}.label`,
              () => obj().label,
              (v) => patchObj({ label: v || undefined }),
            )}
          />
        </label>
        <label>
          <span>Run command</span>
          <input
            type="text"
            placeholder="make dev"
            {...props.bindText(
              `${props.idPrefix}.run`,
              () => obj().run,
              (v) => patchObj({ run: v || undefined }),
            )}
          />
        </label>
        <label>
          <span>Force stop</span>
          <input
            type="text"
            placeholder="fuser -k 5600/tcp"
            {...props.bindText(
              `${props.idPrefix}.force_stop`,
              () => obj().force_stop,
              (v) => patchObj({ force_stop: v || undefined }),
            )}
          />
        </label>
      </div>
      <Show when={submodules().length > 0}>
        <div class="settings-repo-submodules">
          <span class="settings-field-label">Sub repos</span>
          <For each={submodules()}>
            {(sub, idx) => (
              <RepoRow
                entry={sub}
                idPrefix={`${props.idPrefix}.sub[${idx()}]`}
                index={idx()}
                total={submodules().length}
                bindText={props.bindText}
                onMove={(delta) => void updateSubmodules((all) => moveItem(all, idx(), delta))}
                onRemove={() => void updateSubmodules((all) => all.filter((_, i) => i !== idx()))}
                onPatch={(next) =>
                  updateSubmodules((all) => all.map((e, i) => (i === idx() ? next : e)))
                }
              />
            )}
          </For>
        </div>
      </Show>
      <div class="settings-list-actions">
        <button
          class="modal-button"
          onClick={() => void updateSubmodules((all) => [...all, { name: '' }])}
        >
          + Add sub repo
        </button>
      </div>
    </div>
  );
}
