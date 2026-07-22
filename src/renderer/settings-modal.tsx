import { createMemo, createResource, createSignal, For, Show } from 'solid-js';
import { onMount, onCleanup } from 'solid-js';
import type {
  CardMinWidthPrefs,
  Platform,
  AppScopeMemoryPrefs,
  TerminalLoggingPrefs,
  TerminalMemoryPrefs,
  TerminalPrefs,
  TerminalXtermPrefs,
  Theme,
  ResolvedUiFonts,
  UiFontCategory,
  UiFontCategoryPrefs,
  UiFontPrefs,
} from '@shared/types';
import { DEFAULT_CARD_MIN_WIDTH, DEFAULT_UI_FONT_CATEGORY } from '@shared/types';
import {
  addActionTemplate,
  buildSavePayload,
  type ColorEntry,
  moveActionTemplate,
  patchActionTemplate,
  pruneEmpty,
  type RawConfig,
  type Section,
  SECTIONS,
  SECTION_KEYS,
  SCOPE_FILE,
  SCOPE_GROUP_LABEL,
  type SettingsScope,
  type SettingsTab,
  removeActionTemplate,
  TERMINAL_STRING_FIELDS,
} from './settings-modal-parts/data';
import { stableEqual } from './settings-modal-parts/badges';
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
import { SyncSection } from './settings-modal-parts/sections-sync';
import { ActionBar, Button } from './actions';
import { IconClose } from './icons';
import './settings-modal.css';

/**
 * Full-viewport Settings modal. One scrolling surface organised by topic, with
 * the rail grouped under two scope headers — Personal (writes the per-machine
 * `settings.json`) and This conception (writes `<conception>/.condash/settings.json`).
 *
 * Every setting has exactly one home, so each section appears once and carries
 * a scope chip naming its file. There is no inheritance, override, or diff —
 * the old two-tab + badge machinery was removed with the scope-partition
 * revamp.
 *
 * Writes are funnelled through `patchSettings` (settings.json) and
 * `patchConfig` (.condash/settings.json), each of which stages a draft; on Save
 * the drafts round-trip through the `writeGlobalSettings` / `writeNote` IPC's
 * atomic CAS so the schema-validation path stays consistent across the two
 * files.
 */

const SCOPE_ORDER: SettingsScope[] = ['global', 'conception'];

export function SettingsModal(props: {
  conceptionPath: string;
  theme: Theme;
  onChangeTheme: (theme: Theme) => void;
  /** Overlay a theme on the running UI without committing it — the picker
   *  drives this from its **staged selection**, and drops it (`null`) on
   *  unmount. Distinct from `onChangeTheme` so a preview never becomes the
   *  committed value the picker reads back as checked. */
  onPreviewTheme: (theme: Theme | null) => void;
  /** Resolved card-min-width prefs (every key filled). Drives the live
   *  values shown in the Appearance section. */
  cardMinWidth: Required<CardMinWidthPrefs>;
  /** Commit a partial card-min-width patch. The renderer applies the new
   *  CSS variables and persists. */
  onChangeCardMinWidth: (patch: CardMinWidthPrefs) => void;
  /** Fully-resolved per-category UI fonts. Drives the live values shown in
   *  the Appearance section. */
  uiFonts: ResolvedUiFonts;
  /** Commit a partial per-category UI-font patch. The renderer applies the new
   *  CSS variables and persists. */
  onChangeUiFonts: (patch: UiFontPrefs) => void;
  onClose: () => void;
}) {
  // Conception read path: `.condash/settings.json` (canonical) or a legacy
  // fallback. Write path: always `.condash/settings.json`.
  const writePath = `${props.conceptionPath}/.condash/settings.json`;
  const [readPath, { mutate: mutateReadPath }] = createResource(
    () => props.conceptionPath,
    () => window.condash.getConceptionConfigPath(),
  );
  const configurationPath = (): string => readPath() ?? writePath;

  const [section, setSection] = createSignal<Section>(SECTIONS[0].id);
  const [error, setError] = createSignal<string | null>(null);
  const [savedAt, setSavedAt] = createSignal<number | null>(null);
  const [pending, setPending] = createSignal(false);

  // Two-layer draft model.
  //
  // - **Tree drafts** (globalDraft / conceptionDraft): the entire RawConfig
  //   object as it would be saved. Non-null means the user has staged at
  //   least one mutation that hasn't reached disk. Cleared by Save or Discard.
  // - **Text drafts** (textDrafts): per-input-id ephemeral string for
  //   mid-typing UX. Commits to its tree draft on blur via the saver
  //   registered by `bindText`. Cleared on flush.
  const [globalDraft, setGlobalDraft] = createSignal<RawConfig | null>(null);
  const [conceptionDraft, setConceptionDraft] = createSignal<RawConfig | null>(null);
  const [textDrafts, setTextDrafts] = createSignal<Record<string, string>>({});
  const [closeConfirm, setCloseConfirm] = createSignal(false);
  // Search filter — empty string disables filtering. Passed through
  // SearchProvider so every Subgroup can match its own keywords.
  const [searchQuery, setSearchQuery] = createSignal('');

  // Perf recording is deliberately NOT part of the draft/save flow the rest of
  // this modal uses. It routes through `perfSetEnabled`, the same verb the
  // Performance pane calls, because that verb both read-merge-writes the
  // `terminal` block and re-applies the preference to the running recorder. A
  // plain config patch would persist the flag and change nothing until the next
  // launch — `syncPerfLogging` is only called at boot, on a conception switch,
  // and by that verb. Hence: live state, applied immediately, no Save needed.
  const [perfRecording, setPerfRecording] = createSignal(false);
  onMount(() => {
    void window.condash
      .perfVitals()
      .then((vitals) => setPerfRecording(vitals.recording))
      .catch(() => {
        /* leave the checkbox unchecked; toggling it will re-sync from the reply */
      });
  });
  const applyPerfRecording = async (value: boolean): Promise<void> => {
    try {
      const vitals = await window.condash.perfSetEnabled(value);
      setPerfRecording(vitals.recording);
    } catch (err) {
      // Surface it: a settings write can fail (ENOSPC, read-only home), and a
      // checkbox that silently springs back with no explanation is worse than
      // the error itself.
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const isDirty = (): boolean =>
    globalDraft() !== null || conceptionDraft() !== null || Object.keys(textDrafts()).length > 0;

  const [content, { mutate: mutateContent }] = createResource(
    () => configurationPath(),
    (path) => window.condash.readNote(path),
  );

  // Raw text of `settings.json`. Empty string means the file doesn't exist yet
  // on this machine — the modal still renders, the first save creates it.
  const [globalContent, { mutate: mutateGlobalContent }] = createResource(() =>
    window.condash.getGlobalSettingsRaw(),
  );

  // Used to pick OS-appropriate placeholder text for path / shell fields.
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
  // rAF guard for the scroller's onScroll → SECTIONS layout-read loop.
  let rafScheduled = false;
  onMount(() => {
    document.addEventListener('keydown', handleKeydown, true);
    // Focus the Back button on open so Tab order starts inside the modal.
    queueMicrotask(() => backButtonRef?.focus());
  });
  onCleanup(() => document.removeEventListener('keydown', handleKeydown, true));

  // Saved-at indicator timer — shared by both writers so we only ever have one
  // pending clear in-flight, and closing the modal mid-grace doesn't fire
  // setSavedAt on a disposed scope.
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
  // `disk*` memos reflect what's on disk now (CAS baseline at save time).
  // `parsed` / `globalParsed` overlay the active tree draft so every section,
  // pip, and bound input reads the draft-aware view.

  const diskConception = createMemo<RawConfig>(() => parseRawConfig(content() ?? ''));
  const diskGlobal = createMemo<RawConfig>(() => parseRawConfig(globalContent() ?? ''));

  const parsed = createMemo<RawConfig>(() => conceptionDraft() ?? diskConception());
  const globalParsed = createMemo<RawConfig>(() => globalDraft() ?? diskGlobal());

  const parseError = createMemo<string | null>(() => parseErrorOf(content() ?? ''));
  const globalParseError = createMemo<string | null>(() => parseErrorOf(globalContent() ?? ''));

  // --- Stage (draft-tree mutators) -----------------------------------

  /** Mutate the tree draft for `target`, lazily seeding from disk on first
   *  stage. Synchronous; returns Promise<void> for call-site compatibility. */
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

  /** Stage a mutation to the conception (.condash/settings.json) draft. */
  const patchConfig = (mutator: (config: RawConfig) => void): Promise<void> =>
    stage('conception', mutator);

  /** Stage a mutation to the global (settings.json) draft. */
  const patchSettings = (mutator: (settings: RawConfig) => void): Promise<void> =>
    stage('global', mutator);

  // --- Per-section dirty pip ------------------------------------------

  /** True when any key owned by `id` differs between disk and the active
   *  draft — drives the rail's unsaved-changes pip. */
  const sectionDirty = (id: Section): boolean => {
    const keys = SECTION_KEYS[id];
    if (keys.length === 0) return false;
    const meta = SECTIONS.find((s) => s.id === id);
    const isGlobal = meta?.scope !== 'conception';
    const disk = isGlobal ? diskGlobal() : diskConception();
    const effective = isGlobal ? globalParsed() : parsed();
    for (const k of keys) {
      if (!stableEqual(disk[k], effective[k])) return true;
    }
    return false;
  };

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

  const draftSavers = new Map<string, (value: string) => Promise<void> | void>();

  /**
   * Bind a text input. On every keystroke the value lives in `textDrafts`; on
   * blur it commits via `save`, which stages it into the tree draft. Nothing
   * reaches disk until Save is clicked.
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

  /** Drain the text-draft layer into tree drafts. First step of any flush so
   *  typed-but-unblurred edits aren't lost. */
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

  /** Write a single tree draft to disk through its CAS write IPC. Returns true
   *  if it actually wrote (false when the serialized draft matches disk). */
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

  /** Persist all staged drafts in one round. Writes proceed in parallel across
   *  the two files but each goes through its own CAS guard. */
  const flushDrafts = async (): Promise<void> => {
    await drainTextDrafts();
    if (!globalDraft() && !conceptionDraft()) {
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
              // Live-fire theme + card-min-width once the global file changed,
              // so the rest of the app picks up the new CSS variables.
              const g = parseRawConfig(written);
              if (g.theme && g.theme !== props.theme) props.onChangeTheme(g.theme);
              if (g.uiFonts) props.onChangeUiFonts(g.uiFonts);
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

  /** Drop every staged change. The next render falls back to disk content. */
  const discardDrafts = (): void => {
    setGlobalDraft(null);
    setConceptionDraft(null);
    setTextDrafts({});
    setError(null);
  };

  const handleSaveAndClose = async (): Promise<void> => {
    setCloseConfirm(false);
    await flushDrafts();
    if (!error()) props.onClose();
  };

  const handleDiscardAndClose = (): void => {
    discardDrafts();
    setCloseConfirm(false);
    props.onClose();
  };

  // --- Appearance (global) -------------------------------------------

  const globalTheme = (): Theme => globalParsed().theme ?? props.theme ?? 'system';
  const setGlobalTheme = (next: Theme): Promise<void> =>
    patchSettings((c) => {
      c.theme = next;
    });

  const uiFontOf = (category: UiFontCategory): Required<UiFontCategoryPrefs> => ({
    ...DEFAULT_UI_FONT_CATEGORY,
    ...props.uiFonts[category],
    ...(globalParsed().uiFonts?.[category] ?? {}),
  });
  const setGlobalUiFonts = (patch: UiFontPrefs): Promise<void> =>
    patchSettings((c) => {
      // Deep-merge each category so a family patch doesn't drop a saved
      // weight/size (and vice-versa).
      const merged: UiFontPrefs = { ...(c.uiFonts ?? {}) };
      for (const category of Object.keys(patch) as UiFontCategory[]) {
        merged[category] = { ...(merged[category] ?? {}), ...patch[category] };
      }
      c.uiFonts = merged;
    });

  const cardMinWidthGlobal = (key: keyof CardMinWidthPrefs): number =>
    globalParsed().cardMinWidth?.[key] ?? DEFAULT_CARD_MIN_WIDTH[key];

  const setGlobalCardMinWidth = (patch: CardMinWidthPrefs): Promise<void> =>
    patchSettings((c) => {
      const merged: CardMinWidthPrefs = { ...(c.cardMinWidth ?? {}), ...patch };
      for (const k of Object.keys(merged) as (keyof CardMinWidthPrefs)[]) {
        if (merged[k] === undefined) delete merged[k];
      }
      c.cardMinWidth = Object.keys(merged).length > 0 ? merged : undefined;
    });

  // --- Terminal prefs (global) ---------------------------------------

  const terminalPrefs = (): TerminalPrefs => (globalParsed().terminal as TerminalPrefs) ?? {};

  /** Mutate the `terminal` block. Hold the dynamic-row arrays aside while
   *  `pruneEmpty` cleans the scalar keys — otherwise pruneEmpty strips required
   *  `label`/`template` fields whose value is '' (blank-row placeholders) and
   *  leaves `{}` rows the schema rejects. */
  const patchTerminal = (mutator: (prefs: TerminalPrefs) => TerminalPrefs): Promise<void> =>
    patchSettings((c) => {
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
    key: (typeof TERMINAL_STRING_FIELDS)[number]['key'],
    value: string,
  ): Promise<void> =>
    patchTerminal((p) => {
      const next = { ...p } as Record<string, unknown>;
      next[key] = value || undefined;
      return next as TerminalPrefs;
    });

  const patchProjectActionField = (
    index: number,
    patch: Partial<import('@shared/types').ActionTemplate>,
  ): Promise<void> =>
    patchTerminal((p) => ({
      ...p,
      projectActions: patchActionTemplate(p.projectActions, index, patch),
    }));

  const addProjectActionField = (): Promise<void> =>
    patchTerminal((p) => ({ ...p, projectActions: addActionTemplate(p.projectActions) }));

  const removeProjectActionField = (index: number): Promise<void> =>
    patchTerminal((p) => ({ ...p, projectActions: removeActionTemplate(p.projectActions, index) }));

  const moveProjectActionField = (index: number, delta: -1 | 1): Promise<void> =>
    patchTerminal((p) => ({
      ...p,
      projectActions: moveActionTemplate(p.projectActions, index, delta),
    }));

  const patchNewProjectActionField = (
    index: number,
    patch: Partial<import('@shared/types').ActionTemplate>,
  ): Promise<void> =>
    patchTerminal((p) => ({
      ...p,
      newProjectActions: patchActionTemplate(p.newProjectActions, index, patch),
    }));

  const addNewProjectActionField = (): Promise<void> =>
    patchTerminal((p) => ({ ...p, newProjectActions: addActionTemplate(p.newProjectActions) }));

  const removeNewProjectActionField = (index: number): Promise<void> =>
    patchTerminal((p) => ({
      ...p,
      newProjectActions: removeActionTemplate(p.newProjectActions, index),
    }));

  const moveNewProjectActionField = (index: number, delta: -1 | 1): Promise<void> =>
    patchTerminal((p) => ({
      ...p,
      newProjectActions: moveActionTemplate(p.newProjectActions, index, delta),
    }));

  const xtermPrefs = (): TerminalXtermPrefs => terminalPrefs().xterm ?? {};

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

  const updateLogging = (patch: Partial<TerminalLoggingPrefs>): Promise<void> =>
    patchTerminal((p) => {
      const logging = (p.logging ?? {}) as TerminalLoggingPrefs;
      const merged: TerminalLoggingPrefs = { ...logging };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) {
          delete (merged as Record<string, unknown>)[k];
        } else {
          (merged as Record<string, unknown>)[k] = v;
        }
      }
      return { ...p, logging: merged };
    });

  // Per-tab memory caps. Mirrors updateLogging: shallow-merge into
  // `terminal.memory`, pruning undefined keys so the config stays minimal.
  const updateMemory = (patch: Partial<TerminalMemoryPrefs>): Promise<void> =>
    patchTerminal((p) => {
      const memory = (p.memory ?? {}) as TerminalMemoryPrefs;
      const merged: TerminalMemoryPrefs = { ...memory };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) {
          delete (merged as Record<string, unknown>)[k];
        } else {
          (merged as Record<string, unknown>)[k] = v;
        }
      }
      return { ...p, memory: merged };
    });

  // App-scope backstop caps — a nested object under `terminal.memory.appScope`.
  const updateAppScopeMemory = (patch: Partial<AppScopeMemoryPrefs>): Promise<void> =>
    patchTerminal((p) => {
      const memory = (p.memory ?? {}) as TerminalMemoryPrefs;
      const appScope = (memory.appScope ?? {}) as AppScopeMemoryPrefs;
      const mergedApp: AppScopeMemoryPrefs = { ...appScope };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) {
          delete (mergedApp as Record<string, unknown>)[k];
        } else {
          (mergedApp as Record<string, unknown>)[k] = v;
        }
      }
      return { ...p, memory: { ...memory, appScope: mergedApp } };
    });

  // On by default: store only the explicit "off" state; `true` / undefined
  // prune to undefined so the block stays minimal (matches the memory.enabled
  // precedent).
  const setAutoRefreshOnTabSwitch = (value: boolean | undefined): Promise<void> =>
    patchTerminal((p) => ({ ...p, autoRefreshOnTabSwitch: value === false ? false : undefined }));

  // --- Scroll-to-section ---------------------------------------------

  const scrollToSection = (id: Section): void => {
    setSection(id);
    const el = document.getElementById(`settings-section-${id}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
          <Button
            variant="default"
            class="btn--modal-head"
            onClick={attemptClose}
            title="Close (Esc)"
            aria-label="Close settings"
          >
            <IconClose />
          </Button>
        </header>

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
            .condash/settings.json failed to parse — {parseError()}. Edit it externally to repair.
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
            <For each={SCOPE_ORDER}>
              {(scope) => (
                <div class="settings-rail-group" data-scope={scope}>
                  <p class="settings-rail-group-head">{SCOPE_GROUP_LABEL[scope]}</p>
                  <ul class="settings-rail-list">
                    <For each={SECTIONS.filter((s) => s.scope === scope)}>
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
                </div>
              )}
            </For>
            <div class="settings-rail-actions">
              <Button
                variant="default"
                onClick={openSettingsExternally}
                title={`Open ${SCOPE_FILE.global} with the OS default editor`}
              >
                Open {SCOPE_FILE.global}
              </Button>
              <Button
                variant="default"
                onClick={openConfigExternally}
                title={`Open ${SCOPE_FILE.conception} with the OS default editor`}
              >
                Open .condash/settings.json
              </Button>
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
                let active: Section = SECTIONS[0].id;
                for (const s of SECTIONS) {
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
              <RecentConceptionsSection />

              <AppearanceSection
                theme={globalTheme}
                previewTheme={props.onPreviewTheme}
                setTheme={setGlobalTheme}
                uiFont={uiFontOf}
                setUiFonts={setGlobalUiFonts}
                cardMinWidth={cardMinWidthGlobal}
                setCardMinWidth={setGlobalCardMinWidth}
              />

              <TerminalSection
                bindText={bindText}
                prefs={terminalPrefs}
                xterm={xtermPrefs}
                setString={setTerminalString}
                projectActions={() => terminalPrefs().projectActions ?? []}
                patchProjectAction={patchProjectActionField}
                addProjectAction={addProjectActionField}
                removeProjectAction={removeProjectActionField}
                moveProjectAction={moveProjectActionField}
                newProjectActions={() => terminalPrefs().newProjectActions ?? []}
                patchNewProjectAction={patchNewProjectActionField}
                addNewProjectAction={addNewProjectActionField}
                removeNewProjectAction={removeNewProjectActionField}
                moveNewProjectAction={moveNewProjectActionField}
                updateXterm={updateXterm}
                updateColor={updateColor}
                updateLogging={updateLogging}
                updateMemory={updateMemory}
                updateAppScopeMemory={updateAppScopeMemory}
                perfRecording={perfRecording}
                setPerfRecording={applyPerfRecording}
                setAutoRefreshOnTabSwitch={setAutoRefreshOnTabSwitch}
                platform={platform}
              />

              <AgentsSection parsed={globalParsed} bindText={bindText} patch={patchSettings} />

              <OpenWithSection parsed={globalParsed} bindText={bindText} patch={patchSettings} />

              <DashboardSection parsed={globalParsed} patch={patchSettings} />

              <SyncSection parsed={globalParsed} patch={patchSettings} />

              <WorkspaceSection
                bindText={bindText}
                parsed={parsed}
                patch={patchConfig}
                platform={platform}
              />

              <RepositoriesSection parsed={parsed} bindText={bindText} patch={patchConfig} />
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
