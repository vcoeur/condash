import { createMemo, createResource, createSignal, For, Show } from 'solid-js';
import { onMount, onCleanup } from 'solid-js';
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
  addActionTemplate,
  addLauncher,
  buildSavePayload,
  type ColorEntry,
  moveActionTemplate,
  moveLauncher,
  patchActionTemplate,
  patchLauncher,
  pruneEmpty,
  type RawConfig,
  removeActionTemplate,
  removeLauncher,
  type Section,
  SECTIONS,
  type SettingsTab,
  TABS,
  TERMINAL_STRING_FIELDS,
} from './settings-modal-parts/data';
import { inheritanceState } from './settings-modal-parts/badges';
import type { InheritanceState } from './settings-modal-parts/badges';
import { parseErrorOf, parseRawConfig } from './settings-modal-parts/parse';
import {
  AppearanceSection,
  TerminalSection,
} from './settings-modal-parts/sections-appearance-and-terminal';
import { WorkspaceSection } from './settings-modal-parts/sections-workspace';
import {
  OpenWithSection,
  RepositoriesSection,
} from './settings-modal-parts/sections-repos-and-open-with';
import { RecentConceptionsSection } from './settings-modal-parts/section-recent-conceptions';
import './settings-modal.css';

/** Persisted last-active settings tab. Stored in localStorage so opening
 *  the modal a second time lands on whichever tab the user was on. Per-
 *  machine UI state — not a vault-wide preference. */
const LAST_TAB_STORAGE_KEY = 'condash:settings-modal:last-tab';

function loadLastTab(): SettingsTab {
  try {
    const raw = window.localStorage.getItem(LAST_TAB_STORAGE_KEY);
    return raw === 'conception' ? 'conception' : 'global';
  } catch {
    return 'global';
  }
}

function persistLastTab(tab: SettingsTab): void {
  try {
    window.localStorage.setItem(LAST_TAB_STORAGE_KEY, tab);
  } catch {
    // localStorage may throw in private-mode tests; the active-tab default
    // gracefully degrades to "global" on next open.
  }
}

/**
 * Full-viewport Settings modal. Two-tab layout: Global (writes to per-
 * machine `settings.json`) and This conception (writes to
 * `<conception>/condash.json`). Inheritable keys (theme, cardMinWidth,
 * terminal) appear on both tabs; the conception tab carries inheritance
 * badges per top-level key.
 *
 * Writes are funnelled through `patchConfig` (condash.json) and
 * `patchSettings` (settings.json), each of which parses the live file,
 * applies a mutator, drops empty leaves, and round-trips through the
 * `writeNote` / `writeGlobalSettings` IPC's atomic CAS so the schema-
 * validation path stays consistent across the two files.
 *
 * Module shape: types, constants, helpers, and the recursive `RepoRow`
 * row component live in ./settings-modal-parts/. This file owns the
 * SettingsModal shell — every persisted-state closure (drafts, patches,
 * bindText, scrollToSection, flushDrafts) lives here so the inline section
 * markup can call them without prop-drilling.
 */

export function SettingsModal(props: {
  conceptionPath: string;
  theme: Theme;
  onChangeTheme: (theme: Theme) => void;
  /** Resolved card-min-width prefs (every key filled). Drives the live
   *  values shown in the Appearance subsection. */
  cardMinWidth: Required<CardMinWidthPrefs>;
  /** Commit a partial card-min-width patch. The renderer applies the new
   *  CSS variables and persists. */
  onChangeCardMinWidth: (patch: CardMinWidthPrefs) => void;
  onClose: () => void;
}) {
  // Read path: the existing `.condash/settings.json` (canonical) or one of
  // the two legacy fallbacks (`condash.json` / `configuration.json`).
  // Resolved on mount so we surface the right file even when the conception
  // still has only a legacy filename. Write path: always
  // `.condash/settings.json` — the first save in a legacy tree creates the
  // new canonical alongside the legacy file, and the auto-migrator
  // tombstones the legacy on next conception-open.
  const writePath = `${props.conceptionPath}/.condash/settings.json`;
  const [readPath, { mutate: mutateReadPath }] = createResource(
    () => props.conceptionPath,
    () => window.condash.getConceptionConfigPath(),
  );
  const configurationPath = (): string => readPath() ?? writePath;

  const [tab, setTab] = createSignal<SettingsTab>(loadLastTab());
  const switchTab = (next: SettingsTab): void => {
    if (next === tab()) return;
    setTab(next);
    persistLastTab(next);
    // Pin the section signal to whichever section heads the new tab so
    // the rail's "active" highlight points at the visible panel before
    // the user has scrolled.
    const first = SECTIONS.find((s) => s.tab === next);
    if (first) setSection(first.id);
  };
  const [section, setSection] = createSignal<Section>(
    (SECTIONS.find((s) => s.tab === loadLastTab()) ?? SECTIONS[0]).id,
  );
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
    () => configurationPath(),
    (path) => window.condash.readNote(path),
  );

  // Raw text contents of `settings.json`. Used for the Global-tab editor +
  // for the conception tab's badge comparisons. Empty string means the
  // file doesn't exist yet on this machine — the modal still renders, the
  // first save creates it.
  const [globalContent, { mutate: mutateGlobalContent }] = createResource(() =>
    window.condash.getGlobalSettingsRaw(),
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
      e.stopPropagation();
      if (closeConfirm()) {
        setCloseConfirm(false);
        return;
      }
      attemptClose();
    }
  };

  let backButtonRef: HTMLButtonElement | undefined;
  // rAF guard for the scroller's onScroll → SECTIONS layout-read loop. See
  // the onScroll handler below.
  let rafScheduled = false;
  onMount(() => {
    document.addEventListener('keydown', handleKeydown, true);
    // Focus the Back button on open so Tab order starts inside the modal —
    // without this Tab walks back into whatever button triggered Settings.
    queueMicrotask(() => backButtonRef?.focus());
  });
  onCleanup(() => document.removeEventListener('keydown', handleKeydown, true));

  // Saved-at indicator timer — shared by patchConfig + patchSettings so we
  // only ever have one pending clear in-flight, and so closing the modal
  // mid-grace doesn't fire setSavedAt on a disposed scope.
  let savedAtTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSavedAtClear = (): void => {
    if (savedAtTimer !== null) clearTimeout(savedAtTimer);
    savedAtTimer = setTimeout(() => {
      setSavedAt((t) => (t && Date.now() - t > 1200 ? null : t));
      savedAtTimer = null;
    }, 1500);
  };
  onCleanup(() => {
    if (savedAtTimer !== null) clearTimeout(savedAtTimer);
  });

  // --- Parsed memos ---------------------------------------------------

  const parsed = createMemo<RawConfig>(() => parseRawConfig(content() ?? ''));
  const globalParsed = createMemo<RawConfig>(() => parseRawConfig(globalContent() ?? ''));

  const parseError = createMemo<string | null>(() => parseErrorOf(content() ?? ''));
  const globalParseError = createMemo<string | null>(() => parseErrorOf(globalContent() ?? ''));

  // --- patchFile factory ----------------------------------------------

  /** Apply `mutator` to a parsed JSON file, drop empty leaves, and
   *  persist via the caller-supplied write IPC's atomic CAS. Wraps the
   *  shared parse → mutate → stringify → write flow that both
   *  patchConfig (condash.json) and patchSettings (settings.json) need —
   *  the two files differ only in where they read from and how they
   *  write, captured by `read` / `write`. */
  const patchFile = async (
    fileLabel: string,
    read: () => string,
    write: (text: string, next: string) => Promise<string>,
    onWritten: (written: string) => void,
    mutator: (config: RawConfig) => void,
  ): Promise<void> => {
    const text = read();
    let parsed: RawConfig;
    try {
      parsed = (text ? (JSON.parse(text) as RawConfig) : {}) as RawConfig;
    } catch (err) {
      setError(`${fileLabel} is invalid: ${(err as Error).message}. Open it externally to repair.`);
      return;
    }
    mutator(parsed);
    const next = JSON.stringify(buildSavePayload(parsed), null, 2) + '\n';
    if (next === text) return;
    setError(null);
    setPending(true);
    try {
      const written = await write(text, next);
      onWritten(written);
      setSavedAt(Date.now());
      scheduleSavedAtClear();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  };

  /** Apply `mutator` to the parsed condash.json, drop empty leaves, and
   *  persist via the same atomic CAS path used by every other note write.
   *  Path swap: read from configurationPath() (which may be the legacy
   *  configuration.json) and always write to writePath (canonical
   *  condash.json). On the first write to a fresh condash.json the file
   *  doesn't yet exist, so writeNote's drift check sees `''` on disk —
   *  pass `''` as the expected baseline when writing to a new path.
   *  After a successful write, the canonical condash.json now exists
   *  (or has been updated) — re-point the read resource so the next
   *  refresh round-trip lands on the right file. The conception config
   *  is canonicalised through the Zod schema on the main side, so the
   *  bytes that reach disk can differ from `next` (e.g. Zod reorders new
   *  keys into schema order). Cache the actual written content so the
   *  next save's CAS baseline matches disk. */
  const patchConfig = (mutator: (config: RawConfig) => void): Promise<void> => {
    const readFrom = configurationPath();
    return patchFile(
      'condash.json',
      () => content() ?? '',
      (text, next) => {
        const expected = readFrom === writePath ? text : '';
        return window.condash.writeNote(writePath, expected, next);
      },
      (written) => {
        mutateContent(written);
        if (readFrom !== writePath) mutateReadPath(writePath);
      },
      mutator,
    );
  };

  /** Apply `mutator` to the parsed settings.json, drop empty leaves, and
   *  persist via writeGlobalSettings' atomic CAS. Mirrors patchConfig but
   *  writes to the per-machine file. Every Global-tab editor goes through
   *  this; the long-standing setTheme / setLayout / termSetPrefs IPC verbs
   *  continue to write here too for the rest of the app. */
  const patchSettings = (mutator: (settings: RawConfig) => void): Promise<void> =>
    patchFile(
      'settings.json',
      () => globalContent() ?? '',
      (text, next) => window.condash.writeGlobalSettings(text, next),
      mutateGlobalContent,
      mutator,
    );

  /** Patch the right file based on `target`. */
  const patchFor = (target: SettingsTab) => (target === 'global' ? patchSettings : patchConfig);

  /** Read the parsed source-of-truth for the given target. */
  const parsedFor = (target: SettingsTab): RawConfig =>
    target === 'global' ? globalParsed() : parsed();

  // --- Inheritance state helpers --------------------------------------

  const stateOf = <K extends keyof RawConfig>(key: K): InheritanceState =>
    inheritanceState(key, globalParsed(), parsed());

  /** Drop a top-level key from condash.json. Used by the "Remove
   *  override" / "Reset to global" buttons. */
  const removeOverride = <K extends keyof RawConfig>(key: K): Promise<void> =>
    patchConfig((c) => {
      delete (c as Record<string, unknown>)[key as string];
    });

  // --- External openers ----------------------------------------------

  const openConfigExternally = (): void => {
    void window.condash.openPath(configurationPath());
  };

  const [settingsPathRes] = createResource(() => window.condash.getSettingsPath());

  const openSettingsExternally = (): void => {
    const path = settingsPathRes();
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

  // --- Card min width (inheritable) ----------------------------------
  //
  // The Global-tab control writes to settings.json AND fires the existing
  // `setCardMinWidth` IPC so the live CSS variables in the rest of the app
  // pick up the change immediately. The Conception-tab control writes to
  // condash.json only; the rest of the app (re-routed in this PR to read
  // through the effective resolver) picks up the conception override on
  // its next refresh.

  const setGlobalCardMinWidth = async (patch: CardMinWidthPrefs): Promise<void> => {
    await patchSettings((c) => {
      const merged: CardMinWidthPrefs = { ...(c.cardMinWidth ?? {}), ...patch };
      // Drop the entry when the user types an empty string — the prop
      // change comes through as the bundled default, which the prune
      // step handles.
      for (const k of Object.keys(merged) as (keyof CardMinWidthPrefs)[]) {
        if (merged[k] === undefined) delete merged[k];
      }
      c.cardMinWidth = Object.keys(merged).length > 0 ? merged : undefined;
    });
    // Notify the rest of the app via the existing prop callback so the
    // CSS variables update without a re-mount.
    props.onChangeCardMinWidth(patch);
  };

  const setConceptionCardMinWidth = (patch: CardMinWidthPrefs): Promise<void> =>
    patchConfig((c) => {
      const merged: CardMinWidthPrefs = { ...(c.cardMinWidth ?? {}), ...patch };
      for (const k of Object.keys(merged) as (keyof CardMinWidthPrefs)[]) {
        if (merged[k] === undefined) delete merged[k];
      }
      c.cardMinWidth = Object.keys(merged).length > 0 ? merged : undefined;
    });

  /** Effective per-tab card-min-width snapshot. The Global tab shows
   *  whatever settings.json carries (or the bundled default); the
   *  Conception tab shows condash.json's own value when overridden,
   *  otherwise the global one. */
  const cardMinWidthFor =
    (target: SettingsTab) =>
    (key: keyof CardMinWidthPrefs): number => {
      if (target === 'global') {
        return globalParsed().cardMinWidth?.[key] ?? DEFAULT_CARD_MIN_WIDTH[key];
      }
      return (
        parsed().cardMinWidth?.[key] ??
        globalParsed().cardMinWidth?.[key] ??
        DEFAULT_CARD_MIN_WIDTH[key]
      );
    };

  // --- Theme (inheritable) -------------------------------------------

  const setGlobalTheme = async (next: Theme): Promise<void> => {
    await patchSettings((c) => {
      c.theme = next;
    });
    // Keep the live theme prop in lock-step with settings.json.
    props.onChangeTheme(next);
  };

  const setConceptionTheme = (next: Theme): Promise<void> =>
    patchConfig((c) => {
      c.theme = next;
    });

  /** Effective theme for the given tab. */
  const themeFor = (target: SettingsTab): Theme => {
    if (target === 'global') return globalParsed().theme ?? props.theme ?? 'system';
    return parsed().theme ?? globalParsed().theme ?? props.theme ?? 'system';
  };

  // --- Terminal prefs (inheritable) ----------------------------------

  const terminalPrefsFor = (target: SettingsTab): TerminalPrefs =>
    (parsedFor(target).terminal as TerminalPrefs | undefined) ?? {};

  /** Mutate the `terminal` block on the given file via its patch fn.
   *  Hold the dynamic-row arrays (`launchers`, `projectActions`,
   *  `newProjectActions`) aside while `pruneEmpty` cleans the scalar keys —
   *  otherwise pruneEmpty strips required `label`/`command`/`template`
   *  fields whose value is '' (blank-row placeholders just added via the
   *  "+ Add" buttons) and leaves `{}` rows that the schema rejects with
   *  "expected string, received undefined". `buildSavePayload` runs the
   *  matching bypass at serialise time. */
  const patchTerminal = (
    target: SettingsTab,
    mutator: (prefs: TerminalPrefs) => TerminalPrefs,
  ): Promise<void> =>
    patchFor(target)((c) => {
      const next = mutator({ ...((c.terminal as TerminalPrefs | undefined) ?? {}) });
      const { launchers, projectActions, newProjectActions, ...rest } = next;
      const cleaned = (pruneEmpty(rest) as TerminalPrefs) ?? {};
      if (launchers !== undefined && launchers.length > 0) cleaned.launchers = launchers;
      if (projectActions !== undefined && projectActions.length > 0) {
        cleaned.projectActions = projectActions;
      }
      if (newProjectActions !== undefined && newProjectActions.length > 0) {
        cleaned.newProjectActions = newProjectActions;
      }
      c.terminal = Object.keys(cleaned).length > 0 ? cleaned : undefined;
    });

  const setTerminalString = (
    target: SettingsTab,
    key: (typeof TERMINAL_STRING_FIELDS)[number]['key'],
    value: string,
  ): Promise<void> =>
    patchTerminal(target, (p) => {
      const next = { ...p } as Record<string, unknown>;
      next[key] = value || undefined;
      return next as TerminalPrefs;
    });

  const patchLauncherField = (
    target: SettingsTab,
    index: number,
    patch: Partial<import('@shared/types').LauncherConfig>,
  ): Promise<void> =>
    patchTerminal(target, (p) => ({
      ...p,
      launchers: patchLauncher(p.launchers, index, patch),
    }));

  const addLauncherField = (target: SettingsTab): Promise<void> =>
    patchTerminal(target, (p) => ({
      ...p,
      launchers: addLauncher(p.launchers),
    }));

  const removeLauncherField = (target: SettingsTab, index: number): Promise<void> =>
    patchTerminal(target, (p) => ({
      ...p,
      launchers: removeLauncher(p.launchers, index),
    }));

  const moveLauncherField = (target: SettingsTab, index: number, delta: -1 | 1): Promise<void> =>
    patchTerminal(target, (p) => ({
      ...p,
      launchers: moveLauncher(p.launchers, index, delta),
    }));

  const patchProjectActionField = (
    target: SettingsTab,
    index: number,
    patch: Partial<import('@shared/types').ActionTemplate>,
  ): Promise<void> =>
    patchTerminal(target, (p) => ({
      ...p,
      projectActions: patchActionTemplate(p.projectActions, index, patch),
    }));

  const addProjectActionField = (target: SettingsTab): Promise<void> =>
    patchTerminal(target, (p) => ({
      ...p,
      projectActions: addActionTemplate(p.projectActions),
    }));

  const removeProjectActionField = (target: SettingsTab, index: number): Promise<void> =>
    patchTerminal(target, (p) => ({
      ...p,
      projectActions: removeActionTemplate(p.projectActions, index),
    }));

  const moveProjectActionField = (
    target: SettingsTab,
    index: number,
    delta: -1 | 1,
  ): Promise<void> =>
    patchTerminal(target, (p) => ({
      ...p,
      projectActions: moveActionTemplate(p.projectActions, index, delta),
    }));

  const patchNewProjectActionField = (
    target: SettingsTab,
    index: number,
    patch: Partial<import('@shared/types').ActionTemplate>,
  ): Promise<void> =>
    patchTerminal(target, (p) => ({
      ...p,
      newProjectActions: patchActionTemplate(p.newProjectActions, index, patch),
    }));

  const addNewProjectActionField = (target: SettingsTab): Promise<void> =>
    patchTerminal(target, (p) => ({
      ...p,
      newProjectActions: addActionTemplate(p.newProjectActions),
    }));

  const removeNewProjectActionField = (target: SettingsTab, index: number): Promise<void> =>
    patchTerminal(target, (p) => ({
      ...p,
      newProjectActions: removeActionTemplate(p.newProjectActions, index),
    }));

  const moveNewProjectActionField = (
    target: SettingsTab,
    index: number,
    delta: -1 | 1,
  ): Promise<void> =>
    patchTerminal(target, (p) => ({
      ...p,
      newProjectActions: moveActionTemplate(p.newProjectActions, index, delta),
    }));

  const xtermPrefsFor = (target: SettingsTab): TerminalXtermPrefs =>
    terminalPrefsFor(target).xterm ?? {};

  const updateXterm = (target: SettingsTab, patch: Partial<TerminalXtermPrefs>): Promise<void> =>
    patchTerminal(target, (p) => {
      const xterm = (p.xterm ?? {}) as TerminalXtermPrefs;
      const merged: TerminalXtermPrefs = { ...xterm, ...patch };
      if (patch.colors) {
        merged.colors = { ...(xterm.colors ?? {}), ...patch.colors };
      }
      return { ...p, xterm: merged };
    });

  const updateColor = (target: SettingsTab, key: ColorEntry['key'], value: string): void =>
    void updateXterm(target, { colors: { [key]: value || undefined } as never });

  const updateLogging = (
    target: SettingsTab,
    patch: Partial<TerminalLoggingPrefs>,
  ): Promise<void> =>
    patchTerminal(target, (p) => {
      const logging = (p.logging ?? {}) as TerminalLoggingPrefs;
      const merged: TerminalLoggingPrefs = { ...logging };
      // Apply the patch field-by-field so `undefined` clears a key (lets
      // a user re-default by clearing an input) and explicit values
      // overwrite.
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) {
          delete (merged as Record<string, unknown>)[k];
        } else {
          (merged as Record<string, unknown>)[k] = v;
        }
      }
      return { ...p, logging: merged };
    });

  // --- Scroll-to-section ---------------------------------------------

  const scrollToSection = (id: Section): void => {
    setSection(id);
    const el = document.getElementById(`settings-section-${id}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // --- Keyboard nav for the tablist ----------------------------------

  const handleTabKey = (e: KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const order: SettingsTab[] = ['global', 'conception'];
    const idx = order.indexOf(tab());
    const next =
      e.key === 'ArrowLeft'
        ? order[(idx + order.length - 1) % order.length]
        : order[(idx + 1) % order.length];
    switchTab(next);
    // Move focus to the newly active tab button so screen readers
    // announce the active state.
    queueMicrotask(() => {
      const el = document.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`);
      el?.focus();
    });
  };

  // --- Render --------------------------------------------------------

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
          <button
            ref={(el) => (backButtonRef = el)}
            class="settings-back"
            onClick={attemptClose}
            title="Back (Esc)"
            aria-label="Back"
          >
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
          <button
            class="modal-button"
            onClick={attemptClose}
            title="Close (Esc)"
            aria-label="Close settings"
          >
            ×
          </button>
        </header>

        {/* Tablist — switches between the Global and This-conception panels. */}
        <div class="settings-tablist" role="tablist" aria-label="Settings scope">
          <For each={TABS}>
            {(meta) => (
              <button
                type="button"
                role="tab"
                data-tab={meta.id}
                class="settings-tab"
                classList={{ active: tab() === meta.id }}
                aria-selected={tab() === meta.id}
                aria-controls={`settings-panel-${meta.id}`}
                tabIndex={tab() === meta.id ? 0 : -1}
                onClick={() => switchTab(meta.id)}
                onKeyDown={handleTabKey}
              >
                <span class="settings-tab-label">{meta.label}</span>
                <code class="settings-tab-file">{meta.file}</code>
              </button>
            )}
          </For>
        </div>

        <Show when={parseError()}>
          <div class="modal-error">
            condash.json failed to parse — {parseError()}. Edit it externally to repair.
          </div>
        </Show>
        <Show when={globalParseError()}>
          <div class="modal-error">
            settings.json failed to parse — {globalParseError()}. Edit it externally to repair.
          </div>
        </Show>
        <Show when={error()}>
          <div class="modal-error">{error()}</div>
        </Show>

        <div class="settings-shell">
          <nav class="settings-rail" aria-label="Settings sections">
            <p class="settings-rail-hint">{TABS.find((t) => t.id === tab())?.hint}</p>
            <ul class="settings-rail-list">
              <For each={SECTIONS.filter((s) => s.tab === tab())}>
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
            <div class="settings-rail-actions">
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
                onClick={() => {
                  if (tab() === 'global') openSettingsExternally();
                  else openConfigExternally();
                }}
                title={`Open ${TABS.find((t) => t.id === tab())?.file} with the OS default editor`}
              >
                Open externally
              </button>
            </div>
          </nav>

          <div
            class="settings-scroll"
            onScroll={(e) => {
              if (rafScheduled) return;
              rafScheduled = true;
              const scroller = e.currentTarget;
              requestAnimationFrame(() => {
                rafScheduled = false;
                const scrollerOffsetTop = scroller.offsetTop;
                const top = scroller.scrollTop + 8;
                const sectionsForTab = SECTIONS.filter((s) => s.tab === tab());
                if (sectionsForTab.length === 0) return;
                let active: Section = sectionsForTab[0].id;
                for (const s of sectionsForTab) {
                  const el = document.getElementById(`settings-section-${s.id}`);
                  if (el && el.offsetTop - scrollerOffsetTop <= top) {
                    active = s.id;
                  }
                }
                if (active !== section()) setSection(active);
              });
            }}
          >
            {/* Global tabpanel ----------------------------------------- */}
            <div
              role="tabpanel"
              id="settings-panel-global"
              aria-labelledby="settings-tab-global"
              class="settings-tabpanel"
              classList={{ 'settings-tabpanel--hidden': tab() !== 'global' }}
            >
              <RecentConceptionsSection />

              <AppearanceSection
                target="global"
                themeFor={themeFor}
                setTheme={setGlobalTheme}
                cardMinWidthFor={cardMinWidthFor}
                setCardMinWidth={setGlobalCardMinWidth}
              />

              <TerminalSection
                target="global"
                bindText={bindText}
                prefs={() => terminalPrefsFor('global')}
                xterm={() => xtermPrefsFor('global')}
                setString={(k, v) => setTerminalString('global', k, v)}
                launchers={() => terminalPrefsFor('global').launchers ?? []}
                patchLauncher={(i, p) => patchLauncherField('global', i, p)}
                addLauncher={() => addLauncherField('global')}
                removeLauncher={(i) => removeLauncherField('global', i)}
                moveLauncher={(i, d) => moveLauncherField('global', i, d)}
                projectActions={() => terminalPrefsFor('global').projectActions ?? []}
                patchProjectAction={(i, p) => patchProjectActionField('global', i, p)}
                addProjectAction={() => addProjectActionField('global')}
                removeProjectAction={(i) => removeProjectActionField('global', i)}
                moveProjectAction={(i, d) => moveProjectActionField('global', i, d)}
                newProjectActions={() => terminalPrefsFor('global').newProjectActions ?? []}
                patchNewProjectAction={(i, p) => patchNewProjectActionField('global', i, p)}
                addNewProjectAction={() => addNewProjectActionField('global')}
                removeNewProjectAction={(i) => removeNewProjectActionField('global', i)}
                moveNewProjectAction={(i, d) => moveNewProjectActionField('global', i, d)}
                updateXterm={(p) => updateXterm('global', p)}
                updateColor={(k, v) => updateColor('global', k, v)}
                updateLogging={(p) => updateLogging('global', p)}
                platform={platform}
              />
            </div>

            {/* Conception tabpanel ----------------------------------- */}
            <div
              role="tabpanel"
              id="settings-panel-conception"
              aria-labelledby="settings-tab-conception"
              class="settings-tabpanel"
              classList={{ 'settings-tabpanel--hidden': tab() !== 'conception' }}
            >
              <WorkspaceSection
                bindText={bindText}
                parsed={parsed}
                stateOf={stateOf}
                removeOverride={removeOverride}
                patchConfig={patchConfig}
                platform={platform}
              />

              <RepositoriesSection
                parsed={parsed}
                bindText={bindText}
                stateOf={stateOf}
                removeOverride={removeOverride}
                patchConfig={patchConfig}
              />

              <OpenWithSection
                parsed={parsed}
                bindText={bindText}
                stateOf={stateOf}
                removeOverride={removeOverride}
                patchConfig={patchConfig}
              />

              <AppearanceSection
                target="conception"
                themeFor={themeFor}
                setTheme={setConceptionTheme}
                cardMinWidthFor={cardMinWidthFor}
                setCardMinWidth={setConceptionCardMinWidth}
                themeBadge={{
                  stateOf: () => stateOf('theme'),
                  removeOverride: () => void removeOverride('theme'),
                }}
                cardMinWidthBadge={{
                  stateOf: () => stateOf('cardMinWidth'),
                  removeOverride: () => void removeOverride('cardMinWidth'),
                }}
              />

              <TerminalSection
                target="conception"
                bindText={bindText}
                prefs={() => terminalPrefsFor('conception')}
                xterm={() => xtermPrefsFor('conception')}
                setString={(k, v) => setTerminalString('conception', k, v)}
                launchers={() => terminalPrefsFor('conception').launchers ?? []}
                patchLauncher={(i, p) => patchLauncherField('conception', i, p)}
                addLauncher={() => addLauncherField('conception')}
                removeLauncher={(i) => removeLauncherField('conception', i)}
                moveLauncher={(i, d) => moveLauncherField('conception', i, d)}
                projectActions={() => terminalPrefsFor('conception').projectActions ?? []}
                patchProjectAction={(i, p) => patchProjectActionField('conception', i, p)}
                addProjectAction={() => addProjectActionField('conception')}
                removeProjectAction={(i) => removeProjectActionField('conception', i)}
                moveProjectAction={(i, d) => moveProjectActionField('conception', i, d)}
                newProjectActions={() => terminalPrefsFor('conception').newProjectActions ?? []}
                patchNewProjectAction={(i, p) => patchNewProjectActionField('conception', i, p)}
                addNewProjectAction={() => addNewProjectActionField('conception')}
                removeNewProjectAction={(i) => removeNewProjectActionField('conception', i)}
                moveNewProjectAction={(i, d) => moveNewProjectActionField('conception', i, d)}
                updateXterm={(p) => updateXterm('conception', p)}
                updateColor={(k, v) => updateColor('conception', k, v)}
                updateLogging={(p) => updateLogging('conception', p)}
                platform={platform}
                badge={{
                  stateOf: () => stateOf('terminal'),
                  removeOverride: () => void removeOverride('terminal'),
                }}
              />
            </div>
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
