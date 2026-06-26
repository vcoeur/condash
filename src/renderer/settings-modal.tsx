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
  buildSavePayload,
  type ColorEntry,
  moveActionTemplate,
  patchActionTemplate,
  pruneEmpty,
  type RawConfig,
  removeActionTemplate,
  type Section,
  SECTIONS,
  SECTION_KEYS,
  type SettingsTab,
  TABS,
  TERMINAL_STRING_FIELDS,
} from './settings-modal-parts/data';
import { inheritanceState, stableEqual } from './settings-modal-parts/badges';
import type { InheritanceState } from './settings-modal-parts/badges';
import { SearchProvider } from './settings-modal-parts/fields';
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
import { AgentsSection } from './settings-modal-parts/sections-agents';
import { DashboardSection } from './settings-modal-parts/sections-dashboard';
import { ActionBar, Button } from './actions';
import { IconClose } from './icons';
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

  // Two-layer draft model.
  //
  // - **Tree drafts** (globalDraft / conceptionDraft): the entire RawConfig
  //   object as it would be saved. Non-null means the user has staged at
  //   least one mutation (toggle, dropdown, array op, blurred text commit)
  //   that hasn't reached disk. Cleared by Save (after flush) or Discard.
  //
  // - **Text drafts** (textDrafts): per-input-id ephemeral string for
  //   mid-typing UX. Commits to its tree draft on blur via the saver
  //   registered by `bindText`. Cleared on flush.
  //
  // Tree-draft existence is the single source of truth for "dirty"; text
  // drafts are a UX-only buffer so the input doesn't fight the user's
  // cursor while they type.
  const [globalDraft, setGlobalDraft] = createSignal<RawConfig | null>(null);
  const [conceptionDraft, setConceptionDraft] = createSignal<RawConfig | null>(null);
  const [textDrafts, setTextDrafts] = createSignal<Record<string, string>>({});
  const [closeConfirm, setCloseConfirm] = createSignal(false);
  // Search filter — empty string disables filtering. Passed through
  // SearchProvider so every Subgroup (and any other component that calls
  // useSearch()) can match its own keywords against the active query.
  const [searchQuery, setSearchQuery] = createSignal('');
  // Diff view (G1) — when on, the Conception tab hides every section
  // whose top-level keys all inherit from global. Acts as a quick way to
  // audit "what does this conception actually change?". Persisted per-
  // machine so the user doesn't re-toggle on every open.
  const DIFF_KEY = 'condash:settings-modal:diff-only';
  const [diffOnly, setDiffOnly] = createSignal(
    typeof window !== 'undefined' && window.localStorage.getItem(DIFF_KEY) === '1',
  );
  const toggleDiff = (): void => {
    setDiffOnly((d) => {
      const next = !d;
      try {
        window.localStorage.setItem(DIFF_KEY, next ? '1' : '0');
      } catch {
        // localStorage may throw in private mode — same fallback shape as
        // the rest of this modal: the preference simply resets on next open.
      }
      return next;
    });
  };

  const isDirty = (): boolean =>
    globalDraft() !== null || conceptionDraft() !== null || Object.keys(textDrafts()).length > 0;

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
  //
  // `disk*` memos reflect what's on disk right now (CAS baseline at save
  // time). `parsed` / `globalParsed` overlay the active tree draft on top
  // so every section component, badge, and bound input automatically reads
  // the draft-aware view. Sections take a `parsed: () => RawConfig` getter
  // and don't need to know drafts exist.

  const diskConception = createMemo<RawConfig>(() => parseRawConfig(content() ?? ''));
  const diskGlobal = createMemo<RawConfig>(() => parseRawConfig(globalContent() ?? ''));

  const parsed = createMemo<RawConfig>(() => conceptionDraft() ?? diskConception());
  const globalParsed = createMemo<RawConfig>(() => globalDraft() ?? diskGlobal());

  const parseError = createMemo<string | null>(() => parseErrorOf(content() ?? ''));
  const globalParseError = createMemo<string | null>(() => parseErrorOf(globalContent() ?? ''));

  // --- Stage (draft-tree mutators) -----------------------------------

  /** Mutate the tree draft for `target`, lazily seeding from disk on
   *  first stage. Synchronous: the caller's mutator runs, the draft
   *  signal updates, and every consumer (badges, inputs, previews)
   *  re-derives without any IPC round-trip. Returns Promise<void> for
   *  call-site compatibility with the pre-draft API — every existing
   *  `await patchConfig(...)` still resolves immediately. */
  const stage = (target: SettingsTab, mutator: (c: RawConfig) => void): Promise<void> => {
    if (target === 'global') {
      setGlobalDraft((current) => {
        const base: RawConfig = current ? { ...current } : structuredClone(diskGlobal());
        mutator(base);
        return base;
      });
    } else {
      setConceptionDraft((current) => {
        const base: RawConfig = current ? { ...current } : structuredClone(diskConception());
        mutator(base);
        return base;
      });
    }
    return Promise.resolve();
  };

  /** Stage a mutation to the conception tree draft. */
  const patchConfig = (mutator: (config: RawConfig) => void): Promise<void> =>
    stage('conception', mutator);

  /** Stage a mutation to the global tree draft. */
  const patchSettings = (mutator: (settings: RawConfig) => void): Promise<void> =>
    stage('global', mutator);

  /** Patch the right file based on `target`. */
  const patchFor = (target: SettingsTab) => (target === 'global' ? patchSettings : patchConfig);

  /** Read the parsed source-of-truth for the given target. Draft-aware. */
  const parsedFor = (target: SettingsTab): RawConfig =>
    target === 'global' ? globalParsed() : parsed();

  // --- Inheritance state helpers --------------------------------------

  const stateOf = <K extends keyof RawConfig>(key: K): InheritanceState =>
    inheritanceState(key, globalParsed(), parsed());

  /** True when any of the keys owned by `id` differ between the disk
   *  snapshot and the active draft. Drives the rail's unsaved-changes pip
   *  next to each section label. */
  const sectionDirty = (id: Section): boolean => {
    const keys = SECTION_KEYS[id];
    if (keys.length === 0) return false;
    const isGlobal = id.endsWith(':global');
    const disk = isGlobal ? diskGlobal() : diskConception();
    const effective = isGlobal ? globalParsed() : parsed();
    for (const k of keys) {
      if (!stableEqual(disk[k], effective[k])) return true;
    }
    return false;
  };

  /** True when every conception-side key owned by `id` is in the
   *  'inherits' state (i.e. the conception doesn't override anything in
   *  that section). Used by the diff-view to hide pure-inheritance
   *  sections on the Conception tab. */
  const sectionFullyInherits = (id: Section): boolean => {
    if (!id.endsWith(':conception')) return false;
    const keys = SECTION_KEYS[id];
    if (keys.length === 0) return true;
    for (const k of keys) {
      if (stateOf(k) !== 'inherits') return false;
    }
    return true;
  };

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

  // Maps each text-field id to its current commit handler so we can drain
  // any uncommitted text drafts into their tree drafts before writing.
  const draftSavers = new Map<string, (value: string) => Promise<void> | void>();

  /**
   * Bind a text input. On every keystroke the value lives in `textDrafts`
   * (so the cursor doesn't fight a re-render); on blur the value commits
   * via `save`, which stages it into the tree draft. Nothing reaches disk
   * until Save is clicked.
   */
  const bindText = (
    id: string,
    persisted: () => string | undefined,
    save: (value: string) => Promise<void> | void,
  ): {
    value: string;
    onInput: (e: InputEvent & { currentTarget: HTMLInputElement }) => void;
    onChange: (e: Event & { currentTarget: HTMLInputElement }) => void;
  } => {
    draftSavers.set(id, save);
    return {
      value: textDrafts()[id] ?? persisted() ?? '',
      onInput: (e) => {
        const next = e.currentTarget.value;
        setTextDrafts((d) => ({ ...d, [id]: next }));
      },
      onChange: (e) => {
        const next = e.currentTarget.value;
        setTextDrafts((d) => {
          const copy = { ...d };
          delete copy[id];
          return copy;
        });
        void save(next);
      },
    };
  };

  /** Drain the text-draft layer into tree drafts. Called as the first step
   *  of any flush so on-screen typed-but-unblurred edits don't get lost. */
  const drainTextDrafts = async (): Promise<void> => {
    const snapshot = textDrafts();
    const ids = Object.keys(snapshot);
    if (ids.length === 0) return;
    setTextDrafts({});
    for (const id of ids) {
      const saver = draftSavers.get(id);
      if (saver) await saver(snapshot[id]);
    }
  };

  /** Write a single tree draft to disk through its CAS write IPC. Returns
   *  true if it actually wrote (false when the serialized draft matches
   *  disk byte-for-byte — common right after a Discard-then-edit-back). */
  const writeTreeDraft = async (
    draft: RawConfig,
    expected: string,
    write: (text: string, next: string) => Promise<string>,
    onWritten: (written: string) => void,
  ): Promise<boolean> => {
    const next = JSON.stringify(buildSavePayload(draft), null, 2) + '\n';
    if (next === expected) return false;
    const written = await write(expected, next);
    onWritten(written);
    return true;
  };

  /** Persist all staged drafts (text + tree) in one round. Writes proceed
   *  in parallel across the two files but each goes through its own CAS
   *  guard so a concurrent external edit surfaces as a per-file error. */
  const flushDrafts = async (): Promise<void> => {
    await drainTextDrafts();
    if (!globalDraft() && !conceptionDraft()) {
      // Nothing to write — the text drain may have produced no tree-level
      // changes (e.g. blurred field re-typed to its original value).
      setSavedAt(Date.now());
      scheduleSavedAtClear();
      return;
    }
    setError(null);
    setPending(true);
    try {
      const tasks: Promise<unknown>[] = [];
      const gd = globalDraft();
      if (gd) {
        tasks.push(
          writeTreeDraft(
            gd,
            globalContent() ?? '',
            (text, next) => window.condash.writeGlobalSettings(text, next),
            (written) => {
              mutateGlobalContent(written);
              // Live-fire the theme + card-min-width props once the global
              // file actually changed, so the rest of the app picks up the
              // new CSS variables without a re-mount.
              const g = parseRawConfig(written);
              if (g.theme && g.theme !== props.theme) props.onChangeTheme(g.theme);
              if (g.cardMinWidth) props.onChangeCardMinWidth(g.cardMinWidth);
              setGlobalDraft(null);
            },
          ),
        );
      }
      const cd = conceptionDraft();
      if (cd) {
        const readFrom = configurationPath();
        const expectedConception = readFrom === writePath ? (content() ?? '') : '';
        tasks.push(
          writeTreeDraft(
            cd,
            expectedConception,
            (text, next) => window.condash.writeNote(writePath, text, next),
            (written) => {
              mutateContent(written);
              if (readFrom !== writePath) mutateReadPath(writePath);
              setConceptionDraft(null);
            },
          ),
        );
      }
      await Promise.all(tasks);
      setSavedAt(Date.now());
      scheduleSavedAtClear();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  };

  /** Drop every staged change. The next render falls back to disk content.
   *  Doesn't restore the live theme prop if the user previewed a different
   *  one via the radio — that prop only fires on Save. */
  const discardDrafts = (): void => {
    setGlobalDraft(null);
    setConceptionDraft(null);
    setTextDrafts({});
    setError(null);
  };

  const handleSaveAndClose = async (): Promise<void> => {
    setCloseConfirm(false);
    await flushDrafts();
    // If the save errored, leave the modal open so the user sees the
    // banner. Otherwise close.
    if (!error()) props.onClose();
  };

  const handleDiscardAndClose = (): void => {
    discardDrafts();
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
    // Live preview only inside the modal (see card-density preview strip
    // in C3). The app-wide CSS variables update when the user clicks Save
    // — see flushDrafts.
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
    // The live theme prop only updates when the user clicks Save — the
    // radio shows the staged choice inside the modal via themeFor(),
    // while the rest of the app keeps the disk theme until flush.
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
   *  Hold the dynamic-row arrays (`projectActions`, `newProjectActions`)
   *  aside while `pruneEmpty` cleans the scalar keys — otherwise pruneEmpty
   *  strips required `label`/`template` fields whose value is '' (blank-row
   *  placeholders just added via the "+ Add" buttons) and leaves `{}` rows
   *  that the schema rejects with "expected string, received undefined".
   *  `buildSavePayload` runs the matching bypass at serialise time. */
  const patchTerminal = (
    target: SettingsTab,
    mutator: (prefs: TerminalPrefs) => TerminalPrefs,
  ): Promise<void> =>
    patchFor(target)((c) => {
      const next = mutator({ ...((c.terminal as TerminalPrefs | undefined) ?? {}) });
      const { projectActions, newProjectActions, ...rest } = next;
      const cleaned = (pruneEmpty(rest) as TerminalPrefs) ?? {};
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
        data-diff-only={diffOnly() ? 'true' : 'false'}
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
          <Show when={savedAt() !== null && !pending() && !isDirty()}>
            <span class="modal-saved" title="Saved">
              ✓
            </span>
          </Show>
          <Show when={isDirty() && !pending()}>
            <span class="modal-dirty" title="Unsaved changes — click Save to write to disk">
              ●
            </span>
          </Show>
          <span class="settings-head-spacer" />
          <Show when={tab() === 'conception'}>
            <Button
              type="button"
              variant="default"
              size="sm"
              classList={{ 'btn--active': diffOnly() }}
              onClick={toggleDiff}
              title={
                diffOnly()
                  ? 'Showing only sections this conception overrides — click to show all'
                  : 'Hide sections that fully inherit from global'
              }
              aria-pressed={diffOnly()}
            >
              {diffOnly() ? 'Overrides only ✓' : 'Overrides only'}
            </Button>
          </Show>
          <Button
            variant={isDirty() ? 'primary' : 'default'}
            class="settings-save"
            onClick={() => void flushDrafts()}
            disabled={!isDirty() || pending()}
            title="Save staged changes to disk"
          >
            Save
          </Button>
          <Button
            variant="default"
            onClick={discardDrafts}
            disabled={!isDirty() || pending()}
            title="Drop every staged change and revert to the file on disk"
          >
            Discard
          </Button>
          <button
            class="modal-button"
            onClick={attemptClose}
            title="Close (Esc)"
            aria-label="Close settings"
          >
            <IconClose />
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

        <div class="settings-search-bar">
          <input
            type="search"
            class="settings-search"
            placeholder="Search settings…"
            value={searchQuery()}
            onInput={(e) => setSearchQuery(e.currentTarget.value)}
            aria-label="Filter settings"
          />
          <Show when={searchQuery().trim().length > 0}>
            <button
              type="button"
              class="settings-search-clear"
              onClick={() => setSearchQuery('')}
              title="Clear search"
              aria-label="Clear search"
            >
              ×
            </button>
          </Show>
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
                      <span class="settings-rail-item-label">{s.label}</span>
                      <Show when={sectionDirty(s.id)}>
                        <span
                          class="settings-rail-item-pip"
                          title="Section has unsaved changes"
                          aria-label="Unsaved changes"
                        >
                          ●
                        </span>
                      </Show>
                    </button>
                  </li>
                )}
              </For>
            </ul>
            <div class="settings-rail-actions">
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
            <SearchProvider query={searchQuery}>
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

                <AgentsSection
                  target="global"
                  parsed={globalParsed}
                  bindText={bindText}
                  patch={patchSettings}
                />

                <DashboardSection target="global" parsed={globalParsed} patch={patchSettings} />
              </div>

              {/* Conception tabpanel ----------------------------------- */}
              <div
                role="tabpanel"
                id="settings-panel-conception"
                aria-labelledby="settings-tab-conception"
                class="settings-tabpanel"
                classList={{ 'settings-tabpanel--hidden': tab() !== 'conception' }}
              >
                <div
                  class="settings-section-frame"
                  data-section-state={
                    sectionFullyInherits('workspace:conception') ? 'inherits' : 'overridden'
                  }
                >
                  <WorkspaceSection
                    bindText={bindText}
                    parsed={parsed}
                    stateOf={stateOf}
                    removeOverride={removeOverride}
                    patchConfig={patchConfig}
                    platform={platform}
                  />
                </div>

                <div
                  class="settings-section-frame"
                  data-section-state={
                    sectionFullyInherits('repositories:conception') ? 'inherits' : 'overridden'
                  }
                >
                  <RepositoriesSection
                    parsed={parsed}
                    bindText={bindText}
                    stateOf={stateOf}
                    removeOverride={removeOverride}
                    patchConfig={patchConfig}
                  />
                </div>

                <div
                  class="settings-section-frame"
                  data-section-state={
                    sectionFullyInherits('open-with:conception') ? 'inherits' : 'overridden'
                  }
                >
                  <OpenWithSection
                    parsed={parsed}
                    bindText={bindText}
                    stateOf={stateOf}
                    removeOverride={removeOverride}
                    patchConfig={patchConfig}
                  />
                </div>

                <div
                  class="settings-section-frame"
                  data-section-state={
                    sectionFullyInherits('appearance:conception') ? 'inherits' : 'overridden'
                  }
                >
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
                </div>

                <div
                  class="settings-section-frame"
                  data-section-state={
                    sectionFullyInherits('terminal:conception') ? 'inherits' : 'overridden'
                  }
                >
                  <TerminalSection
                    target="conception"
                    bindText={bindText}
                    prefs={() => terminalPrefsFor('conception')}
                    xterm={() => xtermPrefsFor('conception')}
                    setString={(k, v) => setTerminalString('conception', k, v)}
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

                <div
                  class="settings-section-frame"
                  data-section-state={
                    sectionFullyInherits('agents:conception') ? 'inherits' : 'overridden'
                  }
                >
                  <AgentsSection
                    target="conception"
                    parsed={parsed}
                    bindText={bindText}
                    patch={patchConfig}
                    badge={{
                      stateOf: () => stateOf('agents'),
                      removeOverride: () => void removeOverride('agents'),
                    }}
                  />
                </div>

                <div
                  class="settings-section-frame"
                  data-section-state={
                    sectionFullyInherits('dashboard:conception') ? 'inherits' : 'overridden'
                  }
                >
                  <DashboardSection
                    target="conception"
                    parsed={parsed}
                    patch={patchConfig}
                    badge={{
                      stateOf: () => stateOf('dashboard'),
                      removeOverride: () => void removeOverride('dashboard'),
                    }}
                  />
                </div>
              </div>
            </SearchProvider>
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
              <p>You have staged changes that haven't been written to disk yet.</p>
              <ActionBar>
                <Button variant="default" onClick={() => setCloseConfirm(false)}>
                  Keep editing
                </Button>
                <Button variant="danger" onClick={handleDiscardAndClose}>
                  Discard and close
                </Button>
                <Button variant="primary" onClick={() => void handleSaveAndClose()}>
                  Save and close
                </Button>
              </ActionBar>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
