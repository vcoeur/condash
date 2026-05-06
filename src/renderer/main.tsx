import { render } from 'solid-js/web';
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  Show,
  Suspense,
} from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import type {
  CardMinWidthPrefs,
  Deliverable,
  LayoutState,
  OpenWithSlotKey,
  OpenWithSlots,
  Project,
  RepoEntry,
  Step,
  TermSession,
  TerminalPrefs,
  Theme,
  WorkingSurface,
  Worktree,
} from '@shared/types';
import { DEFAULT_CARD_MIN_WIDTH } from '@shared/types';
import { NoteModal, type ModalState } from './note-modal';
import { ProjectPreview } from './project-preview';
import { resetMermaidTheme } from './markdown';
import { refreshAllXtermThemes } from './xterm-mount';
import { TerminalPane, type TerminalPaneHandle } from './terminal-pane';
import { buildSlugIndex } from './wikilinks';
import { PdfModal } from './pdf-modal';
import { HelpModal, type HelpDoc } from './help-modal';
import { WelcomeScreen } from './welcome-screen';
import { PromptModal, type PromptModalState } from './prompt-modal';
import {
  applyStatus,
  applyStepMarker,
  groupByStatus,
  nextMarker,
  ProjectsView,
} from './panes/projects';
import { KnowledgeView } from './panes/knowledge';
import { CodeView, groupRepos } from './panes/code';
import { ResourcesView, type ResourcesViewActions } from './panes/resources';
import { SkillsView } from './panes/skills';
import { SearchModal } from './search-modal';
import { SettingsModal } from './settings-modal';
import { NewProjectModal } from './new-project-modal';
import { matchesShortcut, parseShortcut } from './keymap';
import { createModalRouter } from './modal-router';
import { createTerminalBridge } from './terminal-bridge';
import { applyTreeEvents } from './tree-events';
import { applyRepoEvents } from './repo-events';
import { QuitConfirmModal } from './quit-confirm-modal';
import { AboutModal } from './about-modal';
import { ConfirmModal } from './confirm-modal';
import { ShortcutsOverlay } from './shortcuts-overlay';
import './styles.css';
import './modals.css';
import './note-modal.css';
import './project-preview.css';
import './welcome-screen.css';

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
}

/** Push the user-configured card grid min-widths onto `:root` as CSS
 * pixels. The pane stylesheets read `--card-min-{projects,code,knowledge,resources,skills}`
 * with a literal fallback that matches `DEFAULT_CARD_MIN_WIDTH`, so a
 * partial prefs object falls back per-key automatically. */
function applyCardMinWidth(prefs: Required<CardMinWidthPrefs>): void {
  const root = document.documentElement;
  // Clamp to the documented [120, 2400] range — guards against a hand-edited
  // settings.json with out-of-range values reaching the CSS variables and
  // breaking the grid (e.g. `{ projects: 10 }` → unreadable).
  const clamp = (n: number, fallback: number): number => {
    if (!Number.isFinite(n)) return fallback;
    if (n < 120) return 120;
    if (n > 2400) return 2400;
    return n;
  };
  root.style.setProperty('--card-min-projects', `${clamp(prefs.projects, 650)}px`);
  root.style.setProperty('--card-min-code', `${clamp(prefs.code, 650)}px`);
  root.style.setProperty('--card-min-knowledge', `${clamp(prefs.knowledge, 520)}px`);
  root.style.setProperty('--card-min-resources', `${clamp(prefs.resources, 280)}px`);
  root.style.setProperty('--card-min-skills', `${clamp(prefs.skills, 280)}px`);
}

function App() {
  const [conceptionPath, setConceptionPath] = createSignal<string | null>(null);
  const [refreshKey, setRefreshKey] = createSignal(0);
  const [theme, setTheme] = createSignal<Theme>('system');
  type ToastKind = 'success' | 'error' | 'info';
  const [toast, setToast] = createSignal<{ msg: string; kind: ToastKind } | null>(null);
  // Composite-layout state — replaces the prior single-`tab` selector.
  // Default mirrors the persisted server-side default until the real
  // value loads (avoids a frame of empty UI).
  const [layout, setLayoutState] = createSignal<LayoutState>({
    projects: true,
    working: 'code',
    terminal: true,
    projectsWidth: 320,
  });
  const [modal, setModal] = createSignal<ModalState>(null);
  const [previewPath, setPreviewPath] = createSignal<string | null>(null);
  const [pdfPath, setPdfPath] = createSignal<string | null>(null);
  const [helpDoc, setHelpDoc] = createSignal<HelpDoc | null>(null);
  const [searchModalOpen, setSearchModalOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [newProjectOpen, setNewProjectOpen] = createSignal(false);
  const [aboutOpen, setAboutOpen] = createSignal(false);
  const [quitConfirmOpen, setQuitConfirmOpen] = createSignal(false);
  const [noteDirty, setNoteDirty] = createSignal(false);
  const [shortcutsOpen, setShortcutsOpen] = createSignal(false);
  const [initConfirmState, setInitConfirmState] = createSignal<{
    path: string;
    missing: string[];
  } | null>(null);
  const [forceStopState, setForceStopState] = createSignal<RepoEntry | null>(null);

  // Resolved dark/light flag for the active app theme. Watches `theme()` plus
  // the system colour-scheme media query so a system flip while the app is
  // open also propagates to dependents (CodeMirror's theme compartment).
  const [systemDark, setSystemDark] = createSignal(
    typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    onCleanup(() => mq.removeEventListener('change', onChange));
  }
  const isDark = createMemo(() => {
    const t = theme();
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return systemDark();
  });
  // Repaint live xterms whenever isDark flips. Covers both the user-driven
  // theme toggle (already handled in handleThemeChange) and the system flip
  // while theme='system' (which only updates `systemDark`, never going through
  // the manual handler). Runs once on mount with the initial value — harmless,
  // since CSS tokens already match.
  createEffect(() => {
    isDark();
    refreshAllXtermThemes();
  });
  const [promptState, setPromptState] = createSignal<PromptModalState | null>(null);
  const [welcomeDismissed, setWelcomeDismissed] = createSignal<boolean>(false);
  void window.condash.getWelcomeDismissed().then(setWelcomeDismissed);

  // Track the active dismiss timer so a fast burst of flashes — or app
  // teardown within the 4 s window — doesn't leave a callback running
  // against a disposed signal.
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  const flashToast = (msg: string, kind: ToastKind = 'info') => {
    setToast({ msg, kind });
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastTimer = null;
      setToast((cur) => (cur && cur.msg === msg ? null : cur));
    }, 4000);
  };
  onCleanup(() => {
    if (toastTimer !== null) clearTimeout(toastTimer);
  });

  const openPrompt = (init: Omit<PromptModalState, 'resolve'>): Promise<string | null> =>
    new Promise<string | null>((resolve) => {
      setPromptState({ ...init, resolve });
    });
  let terminalHandle: TerminalPaneHandle | null = null;

  void window.condash.getConceptionPath().then(setConceptionPath);
  void window.condash.getTheme().then((t) => {
    setTheme(t);
    applyTheme(t);
  });
  void window.condash.getLayout().then(setLayoutState);

  // Card min-widths drive the n→n+1 reflow on the three pane grids.
  // Track them in a signal so the settings modal can publish updates
  // back through `setCardMinWidth` and the CSS variables react in the
  // same frame.
  const [cardMinWidth, setCardMinWidth] = createSignal<Required<CardMinWidthPrefs>>({
    ...DEFAULT_CARD_MIN_WIDTH,
  });
  applyCardMinWidth(cardMinWidth());
  void window.condash.getCardMinWidth().then((prefs) => {
    setCardMinWidth(prefs);
    applyCardMinWidth(prefs);
  });

  /** Persist a partial card-min-width patch and refresh the CSS variables.
   * Settings modal commits go through here so the live grids resize on
   * blur without a reload. */
  const handleCardMinWidthChange = (patch: CardMinWidthPrefs): void => {
    const next: Required<CardMinWidthPrefs> = { ...cardMinWidth(), ...patch };
    setCardMinWidth(next);
    applyCardMinWidth(next);
    void window.condash.setCardMinWidth(next).catch((err) => {
      flashToast(`Could not persist card min-width: ${(err as Error).message}`, 'error');
    });
  };

  /** Apply a layout patch and persist it. The persistence is fire-and-
   * forget: any settings.json write failure surfaces as a toast but the
   * UI state is the source of truth for the session. */
  const updateLayout = (patch: Partial<LayoutState>): void => {
    const next = { ...layout(), ...patch };
    setLayoutState(next);
    void window.condash.setLayout(next).catch((err) => {
      flashToast(`Could not persist layout: ${(err as Error).message}`, 'error');
    });
  };

  const toggleProjects = (): void => updateLayout({ projects: !layout().projects });
  const toggleTerminal = (): void => updateLayout({ terminal: !layout().terminal });
  const selectWorking = (next: WorkingSurface): void => updateLayout({ working: next });

  const unsubscribe = window.condash.onTreeEvents((events) => {
    void applyTreeEvents(events, {
      mutate,
      bumpRefreshKey: () => setRefreshKey((k) => k + 1),
      // Repos no longer depend on refreshKey — refetch them explicitly when
      // a config edit (potentially adding/removing repos) or an unknown event
      // arrives. Dirty changes flow through `repo-events` instead and don't
      // need this path.
      refetchRepos: () => {
        void reloadRepos();
      },
    });
  });
  onCleanup(unsubscribe);

  // Track every live-or-exited session — Code pane uses code-side ones for
  // its inline runner rows, and the LIVE badge on repo cards is derived
  // from the same snapshot.
  const [allSessions, setAllSessions] = createSignal<readonly TermSession[]>([]);
  const liveRepos = createMemo<ReadonlySet<string>>(() => {
    const live = new Set<string>();
    for (const s of allSessions()) {
      if (s.repo && s.exited === undefined) live.add(s.repo);
    }
    return live;
  });
  // Track the branch each live repo session is running on so the Code-pane
  // card face can label it ("running on main") without expanding the card.
  // We match the session's cwd against the repo's worktree paths to pick
  // the right branch.
  const liveSessionCwds = createMemo<ReadonlyMap<string, string>>(() => {
    const out = new Map<string, string>();
    for (const s of allSessions()) {
      if (!s.repo || s.exited !== undefined) continue;
      if (s.cwd) out.set(s.repo, s.cwd);
    }
    return out;
  });
  const codeRunSessions = createMemo<readonly TermSession[]>(() =>
    allSessions().filter((s) => s.side === 'code'),
  );
  const offTermSessions = window.condash.onTermSessions((sessions) => {
    setAllSessions(sessions);
  });
  // Seed once on mount — onTermSessions only fires on changes, so without
  // this initial pull, sessions inherited from a prior renderer would not
  // surface until the next spawn/exit.
  void window.condash.termList().then(setAllSessions);
  onCleanup(offTermSessions);

  const handleThemeChange = (next: Theme) => {
    setTheme(next);
    applyTheme(next);
    resetMermaidTheme();
    // xterm refresh runs through the createEffect on isDark below — covers
    // both this path and an OS dark/light flip while theme='system'.
    void window.condash.setTheme(next);
  };

  const [projects, { mutate }] = createResource(
    () => [conceptionPath(), refreshKey()] as const,
    async ([path]) => {
      if (!path) return [] as Project[];
      return window.condash.listProjects();
    },
  );

  const [knowledge] = createResource(
    () => [conceptionPath(), refreshKey(), layout().working] as const,
    async ([path, , working]) => {
      if (!path || working !== 'knowledge') return null;
      return window.condash.readKnowledgeTree();
    },
  );

  const [resources] = createResource(
    () => [conceptionPath(), refreshKey(), layout().working] as const,
    async ([path, , working]) => {
      if (!path || working !== 'resources') return null;
      return window.condash.readResourcesTree();
    },
  );

  const [skills] = createResource(
    () => [conceptionPath(), refreshKey(), layout().working] as const,
    async ([path, , working]) => {
      if (!path || working !== 'skills') return null;
      return window.condash.readSkillsTree();
    },
  );

  // `repos` is a Solid store rather than a `createResource`. The Code
  // panel's data has two refresh axes — keep them mentally separate or
  // the bug at the end of v2.7 keeps coming back:
  //
  //   1. **Scalar** (dirty, upstream) — push events from
  //      `repo-watchers.ts` flow through `repo-events.ts` into path-
  //      shaped `setRepos(...)` writes. Only the cells that actually
  //      read each value re-evaluate — `repoGroups` and other whole-
  //      list readers stay quiet on a single dirty tick.
  //   2. **Set membership** (worktree add/remove, primary checkout
  //      branch switch, configuration.json edit) — `reloadRepos` (full
  //      list) or `reloadPrimaryByPath` (per-primary subset) replaces
  //      rows. `reconcile` keyed on `path` preserves row identity, so
  //      open dropdowns / popovers survive the swap. Do not remove the
  //      `key: 'path'` argument — without it, the v2.7-era
  //      "F5 nukes my popover" disruption bug returns.
  const [repos, setRepos] = createStore<RepoEntry[]>([]);

  const reloadRepos = async (): Promise<void> => {
    const path = conceptionPath();
    if (!path) {
      setRepos(reconcile([] as RepoEntry[], { key: 'path' }));
      return;
    }
    const list = await window.condash.listRepos();
    setRepos(reconcile(list, { key: 'path' }));
  };

  /** Per-primary partial reload. Looks up the primary entry by `path`
   *  in the current store, calls `listReposForPrimary`, and merges the
   *  result row-by-row keyed on `path`. Falls back to a full
   *  `reloadRepos()` if the primary isn't in the store (defensive — a
   *  structural event for an unknown primary is unexpected). */
  const reloadPrimaryByPath = async (repoPath: string): Promise<void> => {
    if (!conceptionPath()) return;
    const primary = repos.find((r) => !r.parent && r.path === repoPath);
    if (!primary) {
      void reloadRepos();
      return;
    }
    const updated = await window.condash.listReposForPrimary(primary.name);
    if (updated.length === 0) {
      // Primary disappeared from configuration.json between the watcher
      // event and this fetch — reload everything to reconcile.
      void reloadRepos();
      return;
    }
    // Build the next snapshot: keep rows outside this primary's family,
    // append the freshly-fetched rows. Reconcile keyed on `path` does
    // the diff/merge, preserving row identity for unaffected rows and
    // any popovers anchored on them.
    const familyPaths = new Set(updated.map((e) => e.path));
    const survivors = repos.filter((r) => !familyPaths.has(r.path) && r.parent !== primary.name);
    setRepos(reconcile([...survivors, ...updated], { key: 'path' }));
  };

  // Per-primary reload debouncer. Coalesces bursts of structural events
  // for the same primary (e.g. several FS writes during one `git
  // worktree add`). 250 ms is short enough to feel instant and long
  // enough to absorb the burst.
  const primaryReloadTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const schedulePrimaryReload = (repoPath: string): void => {
    const existing = primaryReloadTimers.get(repoPath);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      primaryReloadTimers.delete(repoPath);
      void reloadPrimaryByPath(repoPath);
    }, 250);
    primaryReloadTimers.set(repoPath, t);
  };
  onCleanup(() => {
    for (const t of primaryReloadTimers.values()) clearTimeout(t);
    primaryReloadTimers.clear();
  });

  // Mirror the prior resource semantics: load when the user is on the Code
  // pane, clear otherwise. Side-effect-light — no Suspense, no remount.
  createEffect(() => {
    const path = conceptionPath();
    const working = layout().working;
    if (!path || working !== 'code') {
      setRepos(reconcile([] as RepoEntry[], { key: 'path' }));
      return;
    }
    void reloadRepos();
  });

  const offRepoEvents = window.condash.onRepoEvents((events) => {
    applyRepoEvents(events, {
      repos,
      setRepos,
      onWorktreesChanged: schedulePrimaryReload,
    });
  });
  onCleanup(offRepoEvents);

  const repoGroups = createMemo(() => groupRepos(repos));

  const [openWithSlots] = createResource(
    () => [conceptionPath(), refreshKey()] as const,
    async ([path]) => {
      if (!path) return {} as OpenWithSlots;
      return window.condash.listOpenWith();
    },
  );

  const [terminalPrefs] = createResource(
    () => [conceptionPath(), refreshKey()] as const,
    async ([path]) => {
      if (!path) return {} as TerminalPrefs;
      return window.condash.termGetPrefs();
    },
  );

  const ensureTerminalOpen = (): void => {
    if (!layout().terminal) updateLayout({ terminal: true });
  };

  const router = createModalRouter({
    modal,
    setModal,
    setPdfPath,
    setPreviewPath,
  });

  const bridge = createTerminalBridge({
    terminalHandle: () => terminalHandle,
    ensureTerminalOpen,
    terminalPrefs,
    flashToast,
  });

  const handleLaunch = async (slot: OpenWithSlotKey, path: string) => {
    try {
      await window.condash.launchOpenWith(slot, path);
    } catch (err) {
      flashToast(`Launch failed: ${(err as Error).message}`, 'error');
    }
  };

  const handleForceStop = (repo: RepoEntry): void => {
    setForceStopState(repo);
  };

  const runForceStop = async (repo: RepoEntry): Promise<void> => {
    try {
      await window.condash.forceStopRepo(repo.name);
      flashToast(`Force-stopped ${repo.name}`, 'success');
    } catch (err) {
      flashToast(`Force-stop failed: ${(err as Error).message}`, 'error');
    }
  };

  // Per-card ⏹ — close the live code-side session for this repo, which now
  // routes through the full Stop pipeline (process-group SIGTERM, force_stop,
  // SIGKILL fallback) in main/terminals.ts. No window.confirm: the button is
  // only visible when the repo is live, and the icon reads as destructive.
  const handleStopRepo = (repo: RepoEntry): void => {
    const live = allSessions().find(
      (s) => s.side === 'code' && s.repo === repo.name && s.exited === undefined,
    );
    if (!live) return;
    void window.condash.termClose(live.id);
  };

  const handleGlobalKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    const insideEditable = !!target?.closest(
      '.xterm-host, input, textarea, .cm-editor, [contenteditable=true]',
    );

    const prefs = terminalPrefs() ?? {};
    const toggle = parseShortcut(prefs.shortcut ?? 'Ctrl+`');
    // Pane-toggle is the one shortcut that always wins, even from inside a
    // text input or the active xterm — users expect it to summon/dismiss the
    // pane unconditionally.
    if (matchesShortcut(event, toggle)) {
      event.preventDefault();
      toggleTerminal();
      return;
    }

    // Every other shortcut yields to text inputs / xterm so we don't steal
    // arrow keys, paste, etc. from someone who's typing.
    if (insideEditable) return;

    // ?-overlay toggle. Bare `?` (no modifiers) so a shifted `?` from the
    // user's keyboard layout still fires; the focused-input guard above
    // already keeps it out of any text field.
    if (event.key === '?' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      setShortcutsOpen((cur) => !cur);
      return;
    }

    // Ctrl+K → open search. The Search menu item already binds
    // Ctrl+Shift+F (Electron menus accept one accelerator per item), but
    // the cheat-sheet documents Ctrl+K as the primary; bind it here so
    // muscle memory from VS Code / Linear / Slack works.
    if ((event.ctrlKey || event.metaKey) && event.key === 'k' && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      setSearchModalOpen(true);
      return;
    }

    // Move-tab shortcuts only fire when the pane is open.
    if (!layout().terminal || !terminalHandle) return;
    const left = parseShortcut(prefs.move_tab_left_shortcut ?? 'Ctrl+Left');
    const right = parseShortcut(prefs.move_tab_right_shortcut ?? 'Ctrl+Right');
    if (matchesShortcut(event, left)) {
      event.preventDefault();
      terminalHandle.moveActiveTab(-1);
      return;
    }
    if (matchesShortcut(event, right)) {
      event.preventDefault();
      terminalHandle.moveActiveTab(1);
      return;
    }
    const paste = parseShortcut(prefs.screenshot_paste_shortcut);
    if (matchesShortcut(event, paste)) {
      event.preventDefault();
      void bridge.handleScreenshotPaste();
    }
  };

  onMount(() => {
    document.addEventListener('keydown', handleGlobalKeyDown);
  });
  onCleanup(() => {
    document.removeEventListener('keydown', handleGlobalKeyDown);
  });

  // Application menu → renderer plumbing.
  const offMenu = window.condash.onMenuCommand((command) => {
    if (command === 'search') {
      setSearchModalOpen(true);
      return;
    }
    if (command === 'open-folder') {
      void handlePick();
      return;
    }
    if (command === 'open-conception') {
      void window.condash.openConceptionDirectory().catch((err) => {
        flashToast(`Open failed: ${(err as Error).message}`, 'error');
      });
      return;
    }
    if (command === 'open-settings') {
      if (conceptionPath()) setSettingsOpen(true);
      return;
    }
    if (command === 'request-quit') {
      setQuitConfirmOpen(true);
      return;
    }
    if (command === 'new-project') {
      if (conceptionPath()) setNewProjectOpen(true);
      return;
    }
    if (command === 'toggle-terminal') {
      toggleTerminal();
      return;
    }
    if (command === 'toggle-projects') {
      toggleProjects();
      return;
    }
    if (command === 'show-code') {
      selectWorking(layout().working === 'code' ? null : 'code');
      return;
    }
    if (command === 'show-knowledge') {
      selectWorking(layout().working === 'knowledge' ? null : 'knowledge');
      return;
    }
    if (command === 'show-resources') {
      selectWorking(layout().working === 'resources' ? null : 'resources');
      return;
    }
    if (command === 'show-skills') {
      selectWorking(layout().working === 'skills' ? null : 'skills');
      return;
    }
    if (command === 'hide-working') {
      selectWorking(null);
      return;
    }
    if (command === 'refresh') {
      handleRefresh();
      return;
    }
    if (command === 'about') {
      setAboutOpen(true);
      return;
    }
    if (command.startsWith('help-')) {
      // Strip the `help-` prefix to get the HelpDoc name.
      const doc = command.slice('help-'.length) as HelpDoc;
      setHelpDoc(doc);
      return;
    }
  });
  onCleanup(offMenu);

  const handleRunRepo = async (repo: RepoEntry, worktree?: Worktree) => {
    // The Code-pane Run button spawns a `side: 'code'` session that renders in
    // the inline CodeRunRow inside the Code pane — *not* in the bottom terminal
    // pane. So we no longer auto-open the pane on Run; the pane stays mounted
    // (but visually collapsed) so terminalHandle is still available for spawn.
    if (!terminalHandle) return;
    const isPrimary = !worktree || worktree.primary;
    const label = isPrimary ? repo.name : `${repo.name} · ${worktree.branch ?? '(detached)'}`;
    try {
      await terminalHandle.spawn(
        {
          side: 'code',
          repo: repo.name,
          cwd: isPrimary ? undefined : worktree.path,
        },
        label,
      );
    } catch (err) {
      flashToast(`Run failed: ${(err as Error).message}`, 'error');
    }
  };

  const handlePick = async () => {
    const picked = await window.condash.pickConceptionPath();
    if (!picked) return;
    setConceptionPath(picked);
    setRefreshKey((k) => k + 1);

    // Surface the bundled-template init when the picked folder lacks the
    // conception markers (projects/ + configuration.json). Init never
    // overwrites — existing files stay put. The ConfirmModal replaces
    // window.confirm so the dialog stays inside the renderer (no native
    // chrome flash, keyboard handling matches the rest of the app).
    try {
      const state = await window.condash.detectConceptionState(picked);
      if (state.pathExists && !state.looksInitialised) {
        const missing: string[] = [];
        if (!state.hasProjects) missing.push('projects/');
        if (!state.hasConfiguration) missing.push('configuration.json');
        setInitConfirmState({ path: picked, missing });
      }
    } catch (err) {
      flashToast(`Init check failed: ${(err as Error).message}`, 'error');
    }
  };

  const runInit = async (path: string): Promise<void> => {
    try {
      const { created } = await window.condash.initConception(path);
      flashToast(`Initialised conception template — ${created.length} files created.`, 'success');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      flashToast(`Init failed: ${(err as Error).message}`, 'error');
    }
  };

  const handleRefresh = () => {
    // F5 / View → Refresh covers both axes:
    //   1. Drop the per-worktree git-status cache + force-recompute
    //      every watched path so dirty/upstream are fresh.
    //   2. Bump refreshKey so projects, knowledge, openWith, terminal
    //      prefs all re-fetch.
    //   3. Re-list repos so any worktree add/remove that happened
    //      outside the running app (CLI worktree mutation, manual git
    //      worktree add) is reflected immediately. The reconcile-with-
    //      key contract on the repos store keeps open popovers /
    //      dropdowns alive across the swap.
    void window.condash.invalidateGitStatus();
    setRefreshKey((k) => k + 1);
    void reloadRepos();
  };

  const handleOpenInEditor = (path: string) => {
    void window.condash.openInEditor(path);
  };

  const handleOpenDeliverable = (path: string) => {
    if (path.toLowerCase().endsWith('.pdf')) {
      setPdfPath(path);
    } else {
      void window.condash.openInEditor(path);
    }
  };

  const handleCreateProjectNote = async (project: Project) => {
    const slug = await openPrompt({
      title: `New note for "${project.title}"`,
      message: 'Slug (lowercase, hyphenated). Saved as notes/NN-<slug>.md.',
      placeholder: 'my-new-note',
      confirmLabel: 'Create',
      slugPreview: true,
    });
    if (slug === null) return;
    const trimmed = slug.trim();
    if (!trimmed) {
      flashToast('Empty slug — note not created.', 'error');
      return;
    }
    try {
      const path = await window.condash.createProjectNote(project.path, trimmed);
      const filename = path.split('/').pop() ?? path;
      flashToast(`Created ${filename}.`, 'success');
      // Open the new note in the in-app modal editor straight away.
      setModal({ path, title: filename });
    } catch (err) {
      flashToast(`Could not create note: ${(err as Error).message}`, 'error');
    }
  };

  const handleOpenProject = (project: Project) => {
    // Opening a fresh preview from a card resets any pending back-link from
    // a previously-opened file modal — the user has explicitly chosen a new
    // starting point.
    router.setPreviewBackPath(null);
    setPreviewPath(project.path);
  };

  const previewProject = (): Project | null => {
    const path = previewPath();
    if (!path) return null;
    return (projects() ?? []).find((p) => p.path === path) ?? null;
  };

  const handleOpenReadmeFromPreview = (project: Project) => {
    // Set the back-path so the modal's onClose / "← Back" button returns to
    // the card popup view instead of just dismissing.
    router.setPreviewBackPath(project.path);
    setPreviewPath(null);
    setModal({
      path: project.path,
      title: project.title,
      deliverables: project.deliverables,
      backLabel: project.title,
    });
  };

  const handleOpenDeliverableFromPreview = (deliverable: Deliverable) => {
    if (deliverable.path.toLowerCase().endsWith('.pdf')) {
      setPdfPath(deliverable.path);
    } else {
      void window.condash.openInEditor(deliverable.path);
    }
  };

  const handleOpenKnowledgeFile = (path: string, title?: string) => {
    // Pass the .md's h1 (or fallback) so the modal head doesn't fall back
    // to displaying the absolute filesystem path — long, low-contrast,
    // and not what the user wants to read at the top of a note.
    setModal({ path, title });
  };

  const handleViewResource = (path: string, title: string): void => {
    setModal({ path, title, readOnly: true });
  };

  const handleOpenSkillFile = (
    path: string,
    title: string,
    shipped?: { diverged: boolean } | null,
  ): void => {
    let bannerKind: 'shipped' | 'shipped-diverged' | undefined;
    if (shipped) bannerKind = shipped.diverged ? 'shipped-diverged' : 'shipped';
    setModal({ path, title, bannerKind });
  };

  const resourcesActions: ResourcesViewActions = {
    openInEditor: handleOpenInEditor,
    viewMarkdown: handleViewResource,
    viewText: handleViewResource,
    viewPdf: (path) => setPdfPath(path),
    copyPath: (path) => {
      void navigator.clipboard
        .writeText(path)
        .then(() => flashToast('Path copied', 'success'))
        .catch((err) => flashToast(`Copy failed: ${(err as Error).message}`, 'error'));
    },
    pasteToTerm: async (path) => {
      await bridge.handlePasteToTerm(path);
    },
  };

  const handleOpenHelp = (doc: HelpDoc) => {
    setHelpDoc(doc);
  };

  const handleConfirmQuit = () => {
    // The QuitConfirmModal already surfaces the noteDirty warning inline
    // (see noteDirty prop) so by the time the user clicks Quit they've
    // accepted both stakes. No second confirm.
    setQuitConfirmOpen(false);
    void window.condash.quitApp();
  };

  const knowledgeIsEmpty = (): boolean => {
    const k = knowledge();
    if (k === null || k === undefined) return true;
    if (Array.isArray((k as { children?: unknown[] }).children)) {
      return (k as { children: unknown[] }).children.length === 0;
    }
    return false;
  };

  // Welcome screen shows on a tree with no items and no knowledge entries,
  // unless the user dismissed it. Once content lands, it stops appearing
  // automatically; the dismiss is for users who never want to see it again.
  const shouldShowWelcome = (): boolean => {
    if (welcomeDismissed()) return false;
    if (!conceptionPath()) return false;
    if (projects.loading) return false;
    if ((projects() ?? []).length > 0) return false;
    if (!knowledgeIsEmpty()) return false;
    return true;
  };

  const handleWelcomeOpenTree = () => {
    void window.condash.openConceptionDirectory();
  };

  const handleWelcomeTakeTour = () => {
    setHelpDoc('welcome');
  };

  const handleWelcomeOpenDocs = () => {
    void window.condash.openExternal('https://condash.vcoeur.com');
  };

  const handleWelcomeDismiss = () => {
    setWelcomeDismissed(true);
    void window.condash.setWelcomeDismissed(true);
  };

  const slugIndex = createMemo(() => buildSlugIndex(projects() ?? [], knowledge() ?? null));
  // Memoise the per-status grouping so a tap that doesn't actually reshuffle
  // statuses (e.g. a step toggle) doesn't rebuild the four-bucket map for every
  // dependent reader. `groupByStatus` itself is pure — referential equality on
  // `projects()` is enough.
  const projectsTabGroups = createMemo(() => groupByStatus(projects() ?? []));

  const handleWikilink = (slug: string) => {
    const matches = slugIndex().get(slug);
    if (!matches || matches.length === 0) {
      flashToast(`No item matches [[${slug}]]`, 'error');
      return;
    }
    const target = matches[0];
    router.navigateInModal({ path: target.path, title: target.title });
    if (matches.length > 1) {
      flashToast(`[[${slug}]] matched ${matches.length} items — opening the first`, 'info');
    }
  };

  const handleToggleStep = async (project: Project, step: Step) => {
    const next = nextMarker(step.marker);
    mutate((items) => applyStepMarker(items ?? [], project.path, step.lineIndex, next));
    try {
      await window.condash.toggleStep(project.path, step.lineIndex, step.marker, next);
    } catch (err) {
      mutate((items) => applyStepMarker(items ?? [], project.path, step.lineIndex, step.marker));
      flashToast(`Toggle failed: ${(err as Error).message}`, 'error');
    }
  };

  const handleEditStepText = async (project: Project, step: Step, newText: string) => {
    try {
      await window.condash.editStepText(project.path, step.lineIndex, step.text, newText);
      // Watcher fires a 'change' event for the README; the renderer patches in
      // place. No optimistic update — the line index could shift if anything
      // else changed in the file between read and write.
    } catch (err) {
      flashToast(`Edit step failed: ${(err as Error).message}`, 'error');
    }
  };

  const handleAddStep = async (project: Project, text: string) => {
    try {
      await window.condash.addStep(project.path, text);
    } catch (err) {
      // Surface to the console as well as the toast. Without this, a thrown
      // IPC rejection (missing `## Steps` section, file lock contention) is
      // hard to diagnose from a screenshot alone — the toast is transient.
      console.error('[step.add]', project.path, err);
      flashToast(`Add step failed: ${(err as Error).message}`, 'error');
    }
  };

  const handleOpenFileFromPreview = (path: string) => {
    const back = previewProject()?.title;
    if (path.toLowerCase().endsWith('.md')) {
      router.setPreviewBackPath(previewPath());
      setPreviewPath(null);
      setModal({ path, backLabel: back });
    } else if (path.toLowerCase().endsWith('.pdf')) {
      router.setPreviewBackPath(previewPath());
      setPdfPath(path);
    } else {
      // Non-md, non-pdf — opens externally, preview stays in place.
      void window.condash.openInEditor(path);
    }
  };

  const handleDropOnColumn = async (path: string, newStatus: string) => {
    const items = projects() ?? [];
    const project = items.find((p) => p.path === path);
    if (!project) return;
    if (project.status === newStatus) return;

    const previous = project.status;
    mutate((current) => applyStatus(current ?? [], path, newStatus));
    try {
      const result = await window.condash.setStatus(path, newStatus);
      // The main process appended a Closed./Reopened. timeline entry on
      // done-edges; bump the refresh key so the popup's timeline pane and
      // the card's last-date both pick up the new entry.
      if (result.timelineAppended) {
        setRefreshKey((k) => k + 1);
      }
      if (result.branchWarning) {
        flashToast(result.branchWarning, 'info');
      }
    } catch (err) {
      mutate((current) => applyStatus(current ?? [], path, previous));
      flashToast(`Status change failed: ${(err as Error).message}`, 'error');
    }
  };

  // The top band visibility is "any of the three top-band panes is on"
  // — when all three are off, only the Terminal renders, and the top
  // band collapses entirely.
  const topBandVisible = (): boolean => layout().projects || layout().working !== null;

  // Grid columns inside the top band. Three states:
  //   - both Projects and working surface visible: split with the user-
  //     resizable Projects width on the left.
  //   - one of them hidden: the other fills.
  //   - none visible: top band is collapsed (handled at the wrapper).
  const topBandStyle = (): Record<string, string> => {
    const l = layout();
    if (l.projects && l.working !== null) {
      return { 'grid-template-columns': `${l.projectsWidth}px 4px 1fr` };
    }
    return { 'grid-template-columns': '1fr' };
  };

  // Drag the Projects ↔ working-surface splitter. We resize against the
  // top-band element's left edge, clamped to a sensible range so the
  // user can't drag a pane below its minimum visible width.
  let topBandRef: HTMLDivElement | undefined;
  const startSplitterDrag = (event: MouseEvent): void => {
    if (!topBandRef) return;
    // Left mouse only — right-click + middle-click should fall through to
    // the OS context menu / paste, not start a resize.
    if (event.button !== 0) return;
    event.preventDefault();
    const band = topBandRef;
    const rect = band.getBoundingClientRect();
    const min = 160;
    // Coalesce mousemove updates: write grid columns straight to the DOM at
    // most once per frame, and skip the Solid signal entirely during the
    // drag. Re-running topBandStyle() per mousemove triggers a full reflow
    // of both panes (Projects + Knowledge/Code) and pushes INP > 300 ms on
    // a heavily-populated page. We commit the final width to layout state
    // on mouseup, so persistence still works.
    let pendingX: number | null = null;
    let rafId: number | null = null;
    let lastWidth = layout().projectsWidth;
    const flush = (): void => {
      rafId = null;
      if (pendingX === null) return;
      const desired = pendingX - rect.left;
      const clamped = Math.max(min, Math.min(rect.width - min - 4, desired));
      lastWidth = Math.round(clamped);
      band.style.gridTemplateColumns = `${lastWidth}px 4px 1fr`;
    };
    const onMove = (e: MouseEvent): void => {
      pendingX = e.clientX;
      if (rafId === null) rafId = requestAnimationFrame(flush);
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (rafId !== null) cancelAnimationFrame(rafId);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      updateLayout({ projectsWidth: lastWidth });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const onCodeHandleClick = (): void => {
    selectWorking(layout().working === 'code' ? null : 'code');
  };
  const onKnowledgeHandleClick = (): void => {
    selectWorking(layout().working === 'knowledge' ? null : 'knowledge');
  };
  const onResourcesHandleClick = (): void => {
    selectWorking(layout().working === 'resources' ? null : 'resources');
  };
  const onSkillsHandleClick = (): void => {
    selectWorking(layout().working === 'skills' ? null : 'skills');
  };
  const handlesEnabled = (): boolean => !!conceptionPath();

  return (
    <div class="app">
      <div class="workspace">
        {/* Left strip — Projects handle. Always visible so a hidden
            pane can be summoned back. Disabled until a conception path
            is picked, since there is no Projects content to show. */}
        <aside class="edge-strip edge-strip-left">
          <button
            class="edge-handle edge-handle-vertical"
            classList={{ active: layout().projects }}
            aria-pressed={layout().projects}
            onClick={toggleProjects}
            disabled={!handlesEnabled()}
            title={layout().projects ? 'Hide Projects' : 'Show Projects'}
          >
            <span class="edge-handle-label">Projects</span>
          </button>
        </aside>

        <div class="workspace-center">
          <Show
            when={conceptionPath()}
            fallback={
              <div class="empty">
                <p>Pick a conception directory to list its projects.</p>
                <button onClick={handlePick}>Choose folder…</button>
              </div>
            }
          >
            <Show when={shouldShowWelcome()}>
              <WelcomeScreen
                conceptionPath={conceptionPath()!}
                onCreateProject={() => setNewProjectOpen(true)}
                onOpenTree={handleWelcomeOpenTree}
                onTakeTour={handleWelcomeTakeTour}
                onOpenDocs={handleWelcomeOpenDocs}
                onOpenSettings={() => setSettingsOpen(true)}
                onDismiss={handleWelcomeDismiss}
              />
            </Show>
            <Show when={!shouldShowWelcome() && !topBandVisible() && !layout().terminal}>
              <div class="all-panes-hidden-helper">
                <h2>All panes are hidden</h2>
                <p>Bring one back to start working:</p>
                <div class="all-panes-hidden-actions">
                  <button onClick={toggleProjects}>Show Projects</button>
                  <button onClick={() => selectWorking('code')}>Show Code</button>
                  <button onClick={() => selectWorking('knowledge')}>Show Knowledge</button>
                  <button onClick={() => selectWorking('resources')}>Show Resources</button>
                  <button onClick={() => selectWorking('skills')}>Show Skills</button>
                  <button onClick={toggleTerminal}>Show Terminal</button>
                </div>
              </div>
            </Show>
            <Show when={topBandVisible()}>
              <div class="top-band" ref={(el) => (topBandRef = el)} style={topBandStyle()}>
                <Show when={layout().projects}>
                  <section class="pane pane-projects">
                    <Suspense fallback={<div class="empty">Loading…</div>}>
                      <Show
                        when={(projects() ?? []).length > 0}
                        fallback={<div class="empty">No projects found under projects/.</div>}
                      >
                        <ProjectsView
                          buckets={projectsTabGroups()}
                          onOpen={handleOpenProject}
                          onToggleStep={handleToggleStep}
                          onDropProject={handleDropOnColumn}
                          onWorkOn={(p) => void bridge.handleWorkOn(p)}
                          onNewProject={() => setNewProjectOpen(true)}
                        />
                      </Show>
                    </Suspense>
                  </section>
                </Show>

                <Show when={layout().projects && layout().working !== null}>
                  <div
                    class="top-band-splitter"
                    onMouseDown={startSplitterDrag}
                    title="Drag to resize"
                  />
                </Show>

                <Show when={layout().working === 'knowledge'}>
                  <section class="pane pane-working">
                    <Suspense fallback={<div class="empty">Loading…</div>}>
                      <Show
                        when={knowledge()}
                        fallback={
                          <div class="empty">
                            No knowledge/ directory under the selected conception path.
                          </div>
                        }
                      >
                        <KnowledgeView root={knowledge()!} onOpen={handleOpenKnowledgeFile} />
                      </Show>
                    </Suspense>
                  </section>
                </Show>

                <Show when={layout().working === 'resources'}>
                  <section class="pane pane-working">
                    <Suspense fallback={<div class="empty">Loading…</div>}>
                      <ResourcesView
                        root={resources() ?? null}
                        actions={resourcesActions}
                        onOpenSettings={() => setSettingsOpen(true)}
                        onOpenConceptionDir={() => {
                          void window.condash.openConceptionDirectory().catch((err) => {
                            flashToast(`Open failed: ${(err as Error).message}`, 'error');
                          });
                        }}
                      />
                    </Suspense>
                  </section>
                </Show>

                <Show when={layout().working === 'skills'}>
                  <section class="pane pane-working">
                    <Suspense fallback={<div class="empty">Loading…</div>}>
                      <SkillsView
                        root={skills() ?? null}
                        onOpen={handleOpenSkillFile}
                        onOpenSettings={() => setSettingsOpen(true)}
                        onCopyInstallCommand={() => {
                          void navigator.clipboard
                            .writeText('condash skills install')
                            .then(() => flashToast('Copied install command', 'success'))
                            .catch((err) =>
                              flashToast(`Copy failed: ${(err as Error).message}`, 'error'),
                            );
                        }}
                      />
                    </Suspense>
                  </section>
                </Show>

                <Show when={layout().working === 'code'}>
                  <section class="pane pane-working">
                    <Suspense fallback={<div class="empty">Loading…</div>}>
                      <Show
                        when={repos.length > 0}
                        fallback={
                          <div class="empty">
                            <p>No repositories configured.</p>
                            <p>
                              Add entries under <code>repositories.primary</code> or{' '}
                              <code>repositories.secondary</code> in <code>configuration.json</code>
                              .
                            </p>
                            <button
                              type="button"
                              class="empty-cta"
                              onClick={() => setSettingsOpen(true)}
                            >
                              + Add repository
                            </button>
                          </div>
                        }
                      >
                        <CodeView
                          repos={repos}
                          groups={repoGroups()}
                          slots={openWithSlots() ?? {}}
                          liveRepos={liveRepos()}
                          liveSessionCwds={liveSessionCwds()}
                          codeRunSessions={codeRunSessions()}
                          xtermPrefs={terminalPrefs()?.xterm}
                          onOpen={handleOpenInEditor}
                          onLaunch={(slot, path) => void handleLaunch(slot, path)}
                          onForceStop={(r) => void handleForceStop(r)}
                          onStop={handleStopRepo}
                          onRun={(r, wt) => void handleRunRepo(r, wt)}
                          onOpenInTerm={(r, wt) => void bridge.handleOpenInTerm(r, wt)}
                          onCloseSession={(id) => void window.condash.termClose(id)}
                        />
                      </Show>
                    </Suspense>
                  </section>
                </Show>
              </div>
            </Show>
          </Show>
        </div>

        {/* Right strip — Code + Knowledge handles. Mutually exclusive
            in the working-surface slot; clicking the active one hides
            the slot, clicking the other swaps. */}
        <aside class="edge-strip edge-strip-right">
          <button
            class="edge-handle edge-handle-vertical"
            classList={{ active: layout().working === 'code' }}
            aria-pressed={layout().working === 'code'}
            onClick={onCodeHandleClick}
            disabled={!handlesEnabled()}
            title={
              layout().working === 'code' ? 'Hide Code (Ctrl+Shift+C)' : 'Show Code (Ctrl+Shift+C)'
            }
          >
            <span class="edge-handle-label">Code</span>
          </button>
          <button
            class="edge-handle edge-handle-vertical"
            classList={{ active: layout().working === 'knowledge' }}
            aria-pressed={layout().working === 'knowledge'}
            onClick={onKnowledgeHandleClick}
            disabled={!handlesEnabled()}
            title={
              layout().working === 'knowledge'
                ? 'Hide Knowledge (Ctrl+Shift+K)'
                : 'Show Knowledge (Ctrl+Shift+K)'
            }
          >
            <span class="edge-handle-label">Knowledge</span>
          </button>
          <button
            class="edge-handle edge-handle-vertical"
            classList={{ active: layout().working === 'resources' }}
            aria-pressed={layout().working === 'resources'}
            onClick={onResourcesHandleClick}
            disabled={!handlesEnabled()}
            title={
              layout().working === 'resources'
                ? 'Hide Resources (Ctrl+R)'
                : 'Show Resources (Ctrl+R)'
            }
          >
            <span class="edge-handle-label">Resources</span>
          </button>
          <button
            class="edge-handle edge-handle-vertical"
            classList={{ active: layout().working === 'skills' }}
            aria-pressed={layout().working === 'skills'}
            onClick={onSkillsHandleClick}
            disabled={!handlesEnabled()}
            title={layout().working === 'skills' ? 'Hide Skills (Ctrl+L)' : 'Show Skills (Ctrl+L)'}
          >
            <span class="edge-handle-label">Skills</span>
          </button>
        </aside>
      </div>

      {/* TerminalPane is always mounted at full window width, below the
          workspace row. Its own tab strip carries the persistent
          Terminal handle on the left — clicking the handle toggles
          the body open/closed. When closed, only the strip remains
          visible (height collapses to the strip height); when open,
          the body grows to its persisted height above the strip. The
          left / right edge strips above end where this pane begins,
          so the bottom band is genuinely full width. */}
      <TerminalPane
        open={layout().terminal}
        onClose={() => updateLayout({ terminal: false })}
        onTogglePane={toggleTerminal}
        launcherCommand={terminalPrefs()?.launcher_command ?? null}
        cwd={conceptionPath()}
        xtermPrefs={terminalPrefs()?.xterm}
        registerHandle={(handle) => {
          terminalHandle = handle;
        }}
      />

      <ProjectPreview
        project={previewProject()}
        onClose={() => setPreviewPath(null)}
        onToggleStep={handleToggleStep}
        onEditStepText={handleEditStepText}
        onAddStep={handleAddStep}
        onChangeStatus={(p, s) => void handleDropOnColumn(p.path, s)}
        onOpenReadme={handleOpenReadmeFromPreview}
        onOpenFile={handleOpenFileFromPreview}
        onOpenInEditor={handleOpenInEditor}
        onOpenDeliverable={handleOpenDeliverableFromPreview}
        onWorkOn={(p) => void bridge.handleWorkOn(p)}
        onCreateNote={(p) => void handleCreateProjectNote(p)}
      />

      <Show when={modal()}>
        <NoteModal
          state={modal()}
          onClose={() => router.closeChildModal(() => setModal(null))}
          onOpenInEditor={handleOpenInEditor}
          onOpenDeliverable={handleOpenDeliverable}
          onWikilink={handleWikilink}
          onOpenMarkdown={(path) => router.navigateInModal({ path })}
          onBack={router.handleModalBack}
          onOpenPdf={(path) => setPdfPath(path)}
          onOpenHelp={handleOpenHelp}
          onDirtyChange={setNoteDirty}
          dark={isDark()}
        />
      </Show>

      <Show when={helpDoc()}>
        <HelpModal doc={helpDoc()!} onClose={() => setHelpDoc(null)} />
      </Show>

      <Show when={aboutOpen()}>
        <AboutModal onClose={() => setAboutOpen(false)} />
      </Show>

      <Show when={shortcutsOpen()}>
        <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />
      </Show>

      <PromptModal state={promptState()} onClose={() => setPromptState(null)} />

      <Show when={pdfPath()}>
        <PdfModal
          path={pdfPath()!}
          onClose={() => router.closeChildModal(() => setPdfPath(null))}
          onOpenInOs={handleOpenInEditor}
        />
      </Show>

      <Show when={searchModalOpen()}>
        <SearchModal
          onClose={() => setSearchModalOpen(false)}
          onOpenProject={(projectDir) => {
            // ProjectPreview is keyed on the README path (matching
            // Project.path), but search returns the project directory —
            // map back to the README so the preview lookup hits.
            router.setPreviewBackPath(null);
            setPreviewPath(`${projectDir}/README.md`);
          }}
          onOpenFile={handleOpenKnowledgeFile}
        />
      </Show>

      <Show when={settingsOpen() && conceptionPath()}>
        <SettingsModal
          configurationPath={`${conceptionPath()}/configuration.json`}
          theme={theme()}
          onChangeTheme={handleThemeChange}
          cardMinWidth={cardMinWidth()}
          onChangeCardMinWidth={handleCardMinWidthChange}
          onClose={() => setSettingsOpen(false)}
        />
      </Show>

      <Show when={newProjectOpen()}>
        <NewProjectModal
          onClose={() => setNewProjectOpen(false)}
          onCreated={(result) => {
            setNewProjectOpen(false);
            // Refresh the project list and prime the popup. The popup
            // resolves the Project object via `previewProject()`, which
            // re-reads `projects()`, so the popup mounts as soon as the
            // resource refetch settles.
            setRefreshKey((k) => k + 1);
            setPreviewPath(result.readme);
            flashToast(`Created ${result.relPath}`, 'success');
          }}
        />
      </Show>

      <Show when={quitConfirmOpen()}>
        <QuitConfirmModal
          onCancel={() => setQuitConfirmOpen(false)}
          onConfirm={handleConfirmQuit}
          noteDirty={noteDirty()}
        />
      </Show>

      <Show when={forceStopState()}>
        {(repo) => (
          <ConfirmModal
            title={`Force-stop ${repo().name}?`}
            body="The repo's run command will be killed via the configured force_stop. Use only when the dev server is unresponsive."
            confirmLabel="Force-stop"
            destructive
            onCancel={() => setForceStopState(null)}
            onConfirm={() => {
              const r = repo();
              setForceStopState(null);
              void runForceStop(r);
            }}
          />
        )}
      </Show>

      <Show when={initConfirmState()}>
        {(state) => (
          <ConfirmModal
            title="Initialise from template?"
            body={
              `This folder is missing ${state().missing.join(' and ')}.\n\n` +
              'Initialise it from the bundled conception template? ' +
              'Skill files, seed indexes, and example config will be laid down. ' +
              'Existing files are left alone.'
            }
            confirmLabel="Initialise"
            onCancel={() => setInitConfirmState(null)}
            onConfirm={() => {
              const path = state().path;
              setInitConfirmState(null);
              void runInit(path);
            }}
          />
        )}
      </Show>

      <Show when={toast()}>
        {(t) => (
          <div
            class="toast"
            data-kind={t().kind}
            role={t().kind === 'error' ? 'alert' : 'status'}
            aria-live={t().kind === 'error' ? 'assertive' : 'polite'}
          >
            {t().msg}
          </div>
        )}
      </Show>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');
render(() => <App />, root);
