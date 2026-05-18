import { render } from 'solid-js/web';
import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js';
import type {
  CardMinWidthPrefs,
  Deliverable,
  KnowledgeNode,
  LayoutState,
  OpenWithSlotKey,
  OpenWithSlots,
  LogsOpenRequest,
  Project,
  RepoEntry,
  ResourceNode,
  SkillNode,
  SkillTab,
  Step,
  TerminalPrefs,
  Theme,
  TreeRoot,
  WorkingSurface,
  Worktree,
} from '@shared/types';
import { DEFAULT_CARD_MIN_WIDTH } from '@shared/types';
import type { TreeAffordance, TreeViewMutationApi, TreeViewPromptApi } from './panes/tree-view';
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
import { CodeView } from './panes/code';
import { ResourcesView, type ResourcesViewActions } from './panes/resources';
import { SkillsView } from './panes/skills';
import { LogsView } from './panes/logs';
import { SearchModal } from './search-modal';
import { SettingsModal } from './settings-modal';
import { NewProjectModal } from './new-project-modal';
import { createModalRouter } from './modal-router';
import { createTerminalBridge } from './terminal-bridge';
import { applyTreeEvents } from './tree-events';
import { createTreeExpansion } from './tree-expansion';
import { createBranchFilterStore } from './branch-filter-store';
import { createReposStore } from './repos-store';
import { createSessionsStore } from './sessions-store';
import { createProjectsStore } from './projects-store';
import { createTreeStore } from './tree-store';
import { createGlobalKeyboard } from './global-keyboard';
import { createMenuRouter } from './menu-commands';
import { QuitConfirmModal } from './quit-confirm-modal';
import { AboutModal } from './about-modal';
import { ConfirmModal } from './confirm-modal';
import { ShortcutsOverlay } from './shortcuts-overlay';
import './styles.css';
import './modal-base.css';
import './project-preview.css';
import './action-split-button.css';
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
  // Logs pane: external "open this session" requests posted by the
  // global-search modal. Carries a path + nonce so reactivating the same
  // session twice in a row still triggers the pane's effect.
  const [logsOpenRequest, setLogsOpenRequest] = createSignal<LogsOpenRequest | null>(null);
  let logsOpenNonce = 0;
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

  /** Refresh the live card-min-width CSS variables. Settings modal commits
   *  go through here on blur so grids resize without a reload. The modal
   *  itself persists via `patchSettings` (settings.json) / `patchConfig`
   *  (condash.json), so this callback is UI-only — calling `setCardMinWidth`
   *  here would queue a second write that races the modal's CAS baseline. */
  const handleCardMinWidthChange = (patch: CardMinWidthPrefs): void => {
    const next: Required<CardMinWidthPrefs> = { ...cardMinWidth(), ...patch };
    setCardMinWidth(next);
    applyCardMinWidth(next);
  };

  const treeExpansion = createTreeExpansion({ flashToast });
  const {
    knowledgeExpanded,
    resourcesExpanded,
    skillsExpandedByTab,
    toggleTreeExpand,
    expandTreeDir,
  } = treeExpansion;

  const branchFilter = createBranchFilterStore({ flashToast });

  const treeMutations: TreeViewMutationApi = {
    createMd: (root, dirRelPath, filename) =>
      window.condash.treeCreateMd(root, dirRelPath, filename),
    mkdir: (root, dirRelPath, name) => window.condash.treeMkdir(root, dirRelPath, name),
    importFile: (root, dirRelPath) => window.condash.treeImportFile(root, dirRelPath),
  };
  const treePrompts: TreeViewPromptApi = {
    prompt: openPrompt,
  };
  const treeError = (msg: string): void => flashToast(msg, 'error');

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
      mutateProjects: mutate,
      reloadProjects: reloadProjects,
      reloadKnowledge: knowledgeStore.reload,
      reloadResources: resourcesStore.reload,
      reloadSkills: () =>
        // The renderer can't know which tab(s) a tree event affects without
        // duplicating the path-routing logic that lives in the main
        // process. Reload all three; each fetcher is cheap and operates
        // against a small tree (~10–50 files).
        Promise.all([
          skillsStores.generic.reload(),
          skillsStores.claude.reload(),
          skillsStores.kimi.reload(),
        ]).then(() => undefined),
      reloadConfig: reloadConfig,
      // Repos do not subscribe to tree events directly — repo-events
      // covers scalar / structural updates; `config` is the only path
      // through which the repo list itself can change.
      refetchRepos: () => {
        void reloadRepos();
      },
    });
  });
  onCleanup(unsubscribe);

  // Track every live-or-exited session — used by both the Code pane's
  // inline runner rows and the LIVE badge / "running on <branch>" label
  // on repo cards. See `./sessions-store.ts` for the contract.
  const { allSessions, liveRepos, liveSessionCwds, codeRunSessions } = createSessionsStore();

  // UI-only theme update for the Settings modal callback. The modal persists
  // via `patchSettings` (settings.json) / `patchConfig` (condash.json), so
  // calling `setTheme` here would queue a second write that races the modal's
  // CAS baseline and silently drops in-flight terminal edits.
  const handleThemeChange = (next: Theme) => {
    setTheme(next);
    applyTheme(next);
    resetMermaidTheme();
    // xterm refresh runs through the createEffect on isDark below — covers
    // both this path and an OS dark/light flip while theme='system'.
  };

  // Projects + the three tree panes are backed by Solid stores keyed on a
  // stable identity field (`path` for projects, `relPath` for tree nodes).
  // `reconcile` reuses prior node references across refresh, so `<For>`
  // keeps card / row DOM identity and per-card popover state (drag-drop
  // dropdowns, the Step menu, hover anchors) survives every watcher tick.
  // Switching panes does not refetch — the stores stay populated for the
  // active conception until it changes.
  const projectsStore = createProjectsStore({ conceptionPath });
  const { projects, loaded: projectsLoaded, mutate, reload: reloadProjects } = projectsStore;

  /** Branches referenced by an in-flight conception project — drives the
   *  "project" badge in the Code-pane branch-filter dropdown so the
   *  branches most likely worth pinning surface visibly above ad-hoc
   *  local ones. `done`/`later`/`backlog` projects don't badge. */
  const activeProjectBranches = createMemo<ReadonlySet<string>>(() => {
    const out = new Set<string>();
    for (const project of projects()) {
      if (project.status !== 'now' && project.status !== 'review') continue;
      if (project.branch) out.add(project.branch);
    }
    return out;
  });

  const knowledgeStore = createTreeStore<KnowledgeNode>({
    conceptionPath,
    fetcher: () => window.condash.readKnowledgeTree(),
    key: 'relPath',
  });
  const knowledge = knowledgeStore.root;

  const resourcesStore = createTreeStore<ResourceNode>({
    conceptionPath,
    fetcher: () => window.condash.readResourcesTree(),
    key: 'relPath',
  });
  const resources = resourcesStore.root;

  // One tree store per Skills tab. The trees back independent on-disk roots
  // (`.agents/skills/`, `<skills_path>`, `.kimi/skills/`), so each gets its
  // own fetcher, store, and reload trigger. All three are eagerly loaded
  // when the conception path is set so tab switching is paint-only.
  const skillsStores: Record<SkillTab, ReturnType<typeof createTreeStore<SkillNode>>> = {
    generic: createTreeStore<SkillNode>({
      conceptionPath,
      fetcher: () => window.condash.readSkillsTree('generic'),
      key: 'relPath',
    }),
    claude: createTreeStore<SkillNode>({
      conceptionPath,
      fetcher: () => window.condash.readSkillsTree('claude'),
      key: 'relPath',
    }),
    kimi: createTreeStore<SkillNode>({
      conceptionPath,
      fetcher: () => window.condash.readSkillsTree('kimi'),
      key: 'relPath',
    }),
  };
  // Active tab (defaults to `claude` to preserve pre-tabs behaviour; the
  // hydrate-from-IPC `then` below replaces it with the persisted value).
  const [skillsActiveTab, setSkillsActiveTabSig] = createSignal<SkillTab>('claude');
  void window.condash.getSkillsActiveTab().then((tab) => setSkillsActiveTabSig(tab));
  const persistSkillsActiveTab = (tab: SkillTab): void => {
    void window.condash.setSkillsActiveTab(tab).catch((err) => {
      flashToast(`Could not persist Skills tab: ${(err as Error).message}`, 'error');
    });
  };
  const handleSkillsTabSelect = (tab: SkillTab): void => {
    setSkillsActiveTabSig(tab);
    persistSkillsActiveTab(tab);
  };
  const activeSkillsRoot = createMemo(() => skillsStores[skillsActiveTab()].root());
  // Skills mutations pre-bind the currently-active Skills tab so source
  // edits land in `.agents/skills/` and Claude edits in `<skills_path>`.
  // The Kimi tab uses the affordance allowlist to suppress the buttons
  // entirely; the main-process resolver enforces the rule as a backstop.
  // Declared after `skillsActiveTab` so the closures don't carry forward
  // references to a not-yet-initialised signal.
  const skillsMutations: TreeViewMutationApi = {
    createMd: (root, dirRelPath, filename) =>
      window.condash.treeCreateMd(root, dirRelPath, filename, skillsActiveTab()),
    mkdir: (root, dirRelPath, name) =>
      window.condash.treeMkdir(root, dirRelPath, name, skillsActiveTab()),
    importFile: (root, dirRelPath) =>
      window.condash.treeImportFile(root, dirRelPath, skillsActiveTab()),
  };

  // Code-pane repos store. Owns the scalar/set-membership split and the
  // structural-event debouncer; see `./repos-store.ts` for the contract.
  const reposStore = createReposStore({ conceptionPath, flashToast });
  const { repos, reposLoaded, reloadRepos } = reposStore;

  // Open With slots + terminal prefs are config-bound — they change
  // only on a `'config'` tree event (or an explicit user save). Plain
  // signals keep them out of the Suspense/resource graph so a knowledge
  // edit doesn't refetch them.
  const [openWithSlots, setOpenWithSlots] = createSignal<OpenWithSlots>({});
  const [terminalPrefs, setTerminalPrefs] = createSignal<TerminalPrefs | undefined>(undefined);
  const reloadConfig = async (): Promise<void> => {
    if (!conceptionPath()) {
      setOpenWithSlots({});
      setTerminalPrefs(undefined);
      return;
    }
    const [slots, prefs] = await Promise.all([
      window.condash.listOpenWith(),
      window.condash.termGetPrefs(),
    ]);
    setOpenWithSlots(slots);
    setTerminalPrefs(prefs);
  };
  // Reload on every conception-path change. Mirrors the per-store
  // effect so the three config-bound reads stay in sync without a
  // shared `refreshKey`.
  createEffect(() => {
    if (!conceptionPath()) {
      setOpenWithSlots({});
      setTerminalPrefs(undefined);
      return;
    }
    void reloadConfig();
  });

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
    conceptionPath,
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

  createGlobalKeyboard({
    layout,
    terminalPrefs,
    getTerminalHandle: () => terminalHandle,
    toggleTerminal,
    bridge,
    setSearchModalOpen,
    setShortcutsOpen,
  });

  createMenuRouter({
    conceptionPath,
    layout,
    setConceptionPath,
    setSearchModalOpen,
    setSettingsOpen,
    setNewProjectOpen,
    setQuitConfirmOpen,
    setAboutOpen,
    setHelpDoc,
    toggleProjects,
    toggleTerminal,
    selectWorking,
    handleRefresh: () => handleRefresh(),
    handlePick: () => handlePick(),
    flashToast,
  });

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
    const prior = conceptionPath();
    setConceptionPath(picked);
    // Picking the same path is a "refresh me" gesture — the
    // per-store createEffect only fires on actual change, so fan out
    // a full reload to honour that.
    if (prior === picked) void reloadAll();

    // Surface the bundled-template init when the picked folder lacks the
    // conception markers (projects/ + condash.json). Init never
    // overwrites — existing files stay put. The ConfirmModal replaces
    // window.confirm so the dialog stays inside the renderer (no native
    // chrome flash, keyboard handling matches the rest of the app).
    try {
      const state = await window.condash.detectConceptionState(picked);
      if (state.pathExists && !state.looksInitialised) {
        const missing: string[] = [];
        if (!state.hasProjects) missing.push('projects/');
        if (!state.hasConfiguration) missing.push('condash.json');
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
      void reloadAll();
    } catch (err) {
      flashToast(`Init failed: ${(err as Error).message}`, 'error');
    }
  };

  // Full fan-out reload. Used by View → Refresh and as the success
  // tail of `initConception`. Each store applies `reconcile` on swap-in
  // so card / row DOM identity survives — the visible effect is content
  // updating in place, not the pane blanking and rebuilding.
  const reloadAll = async (): Promise<void> => {
    await Promise.all([
      reloadProjects(),
      knowledgeStore.reload(),
      resourcesStore.reload(),
      skillsStores.generic.reload(),
      skillsStores.claude.reload(),
      skillsStores.kimi.reload(),
      reloadConfig(),
      reloadRepos(),
    ]);
  };

  const handleRefresh = () => {
    // F5 / View → Refresh: drop the per-worktree git-status cache so
    // dirty/upstream recompute on the next listRepos, then fan out a
    // full reload across every store. Repos are explicit because the
    // reposStore's createEffect only fires on conception-path change.
    void window.condash.invalidateGitStatus();
    void reloadAll();
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

  /** Per-pane post-mutation handler. Bumps the refresh key so the pane
   *  re-fetches its tree, expands the source directory so the user sees
   *  the new entry, and (for createMd / importFile) opens the new file
   *  the way that pane normally opens its file kind. `mkdir` only
   *  expands so the user can drop notes in. */
  const handleAfterTreeMutation = (
    treeKey: TreeRoot,
    newPath: string,
    kind: TreeAffordance,
    sourceDirRelPath: string,
    skillTab?: SkillTab,
  ): void => {
    // Reload the affected tree explicitly — the chokidar watcher does
    // fire on the new file, but the open-the-newly-created-file branch
    // below runs synchronously and we want the tree pane to reflect
    // the new entry on the same frame.
    if (treeKey === 'knowledge') void knowledgeStore.reload();
    else if (treeKey === 'resources') void resourcesStore.reload();
    else {
      const tab = skillTab ?? skillsActiveTab();
      void skillsStores[tab].reload();
    }
    expandTreeDir(treeKey, sourceDirRelPath, skillTab);
    if (kind === 'mkdir') return;
    if (treeKey === 'knowledge') {
      handleOpenKnowledgeFile(newPath);
      return;
    }
    if (treeKey === 'skills') {
      // Match `handleOpenSkillFile` — title falls back to the basename
      // because the freshly-created file has no h1 yet.
      const title = newPath.split('/').pop() ?? newPath;
      handleOpenSkillFile(newPath, title, null);
      return;
    }
    // Resources: open via the user's main editor for non-viewable kinds,
    // or the inline viewer for markdown / pdf / text.
    const lower = newPath.toLowerCase();
    if (lower.endsWith('.md')) {
      handleViewResource(newPath, newPath.split('/').pop() ?? newPath);
    } else if (lower.endsWith('.pdf')) {
      setPdfPath(newPath);
    } else {
      void window.condash.openInEditor(newPath);
    }
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
    // Wait for the first projects load — otherwise the welcome screen
    // flashes for one frame on cold start before the IPC resolves.
    if (!projectsLoaded()) return false;
    if (projects().length > 0) return false;
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
      console.error('[addStep]', project.path, err);
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
      // done-edges; the watcher fires a 'project' event for the README
      // that patches the card via `mutateProjects`. No explicit reload
      // here — reconcile updates the timeline / closedAt in place and
      // the popup re-reads through the live projects accessor.
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
  const onLogsHandleClick = (): void => {
    selectWorking(layout().working === 'logs' ? null : 'logs');
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
                        projectActions={terminalPrefs()?.projectActions ?? []}
                        onProjectAction={(p, a) => void bridge.handleProjectAction(p, a)}
                        onNewProject={() => setNewProjectOpen(true)}
                        newProjectActions={terminalPrefs()?.newProjectActions ?? []}
                        onNewProjectAction={(a) => void bridge.handleNewProjectAction(a)}
                      />
                    </Show>
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
                    <Show
                      when={knowledge()}
                      fallback={
                        <div class="empty">
                          No knowledge/ directory under the selected conception path.
                        </div>
                      }
                    >
                      <KnowledgeView
                        root={knowledge()!}
                        onOpen={handleOpenKnowledgeFile}
                        expanded={knowledgeExpanded}
                        onToggleExpand={(rel) => toggleTreeExpand('knowledge', rel)}
                        mutations={treeMutations}
                        prompts={treePrompts}
                        onAfterMutation={(newPath, kind, source) =>
                          handleAfterTreeMutation('knowledge', newPath, kind, source)
                        }
                        onError={treeError}
                      />
                    </Show>
                  </section>
                </Show>

                <Show when={layout().working === 'resources'}>
                  <section class="pane pane-working">
                    <ResourcesView
                      root={resources() ?? null}
                      actions={resourcesActions}
                      onOpenSettings={() => setSettingsOpen(true)}
                      onOpenConceptionDir={() => {
                        void window.condash.openConceptionDirectory().catch((err) => {
                          flashToast(`Open failed: ${(err as Error).message}`, 'error');
                        });
                      }}
                      expanded={resourcesExpanded}
                      onToggleExpand={(rel) => toggleTreeExpand('resources', rel)}
                      mutations={treeMutations}
                      prompts={treePrompts}
                      onAfterMutation={(newPath, kind, source) =>
                        handleAfterTreeMutation('resources', newPath, kind, source)
                      }
                      onError={treeError}
                    />
                  </section>
                </Show>

                <Show when={layout().working === 'logs'}>
                  <section class="pane pane-working">
                    <LogsView openRequest={logsOpenRequest} />
                  </section>
                </Show>

                <Show when={layout().working === 'skills'}>
                  <section class="pane pane-working">
                    <SkillsView
                      tab={skillsActiveTab()}
                      onSelectTab={handleSkillsTabSelect}
                      root={activeSkillsRoot() ?? null}
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
                      expanded={() => skillsExpandedByTab(skillsActiveTab())()}
                      onToggleExpand={(rel) => toggleTreeExpand('skills', rel, skillsActiveTab())}
                      mutations={skillsMutations}
                      prompts={treePrompts}
                      onAfterMutation={(newPath, kind, source) =>
                        handleAfterTreeMutation('skills', newPath, kind, source, skillsActiveTab())
                      }
                      onError={treeError}
                    />
                  </section>
                </Show>

                <Show when={layout().working === 'code'}>
                  <section class="pane pane-working">
                    <Show
                      when={repos.length > 0}
                      fallback={
                        <Show when={reposLoaded()} fallback={<div class="empty">Loading…</div>}>
                          <div class="empty">
                            <p>No repositories configured.</p>
                            <p>
                              Add entries to <code>repositories</code> in <code>condash.json</code>.
                            </p>
                            <button
                              type="button"
                              class="empty-cta"
                              onClick={() => setSettingsOpen(true)}
                            >
                              + Add repository
                            </button>
                          </div>
                        </Show>
                      }
                    >
                      <CodeView
                        repos={repos}
                        slots={openWithSlots() ?? {}}
                        liveRepos={liveRepos()}
                        liveSessionCwds={liveSessionCwds()}
                        codeRunSessions={codeRunSessions()}
                        xtermPrefs={terminalPrefs()?.xterm}
                        selectedBranches={branchFilter.selectedBranches()}
                        activeProjectBranches={activeProjectBranches()}
                        stickyAllBranches={branchFilter.stickyAll()}
                        onToggleBranch={branchFilter.toggleBranch}
                        onSetAllSticky={branchFilter.setAllSticky}
                        onSetNoneBranches={branchFilter.setNone}
                        onOpen={handleOpenInEditor}
                        onLaunch={(slot, path) => void handleLaunch(slot, path)}
                        onForceStop={(r) => void handleForceStop(r)}
                        onStop={handleStopRepo}
                        onRun={(r, wt) => void handleRunRepo(r, wt)}
                        onOpenInTerm={(r, wt) => void bridge.handleOpenInTerm(r, wt)}
                        onCloseSession={(id) => void window.condash.termClose(id)}
                      />
                    </Show>
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
          <button
            class="edge-handle edge-handle-vertical"
            classList={{ active: layout().working === 'logs' }}
            aria-pressed={layout().working === 'logs'}
            onClick={onLogsHandleClick}
            disabled={!handlesEnabled()}
            title={
              layout().working === 'logs' ? 'Hide Logs (Ctrl+Shift+L)' : 'Show Logs (Ctrl+Shift+L)'
            }
          >
            <span class="edge-handle-label">Logs</span>
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
        launchers={terminalPrefs()?.launchers ?? []}
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
        projectActions={terminalPrefs()?.projectActions ?? []}
        onProjectAction={(p, a) => void bridge.handleProjectAction(p, a)}
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
          onOpenLog={(path) => {
            // Open the Logs pane and post an open-request the pane reacts
            // to. Nonce bumps every time so reactivating the same path
            // still fires the createEffect.
            logsOpenNonce++;
            setLogsOpenRequest({ path, nonce: logsOpenNonce });
            selectWorking('logs');
          }}
        />
      </Show>

      <Show when={settingsOpen() && conceptionPath()}>
        <SettingsModal
          conceptionPath={conceptionPath()!}
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
            // re-reads `projects()`, so the popup mounts as soon as
            // reload settles.
            void reloadProjects();
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
