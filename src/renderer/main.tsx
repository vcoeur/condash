import { render } from 'solid-js/web';
import {
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  Show,
  Suspense,
} from 'solid-js';
import type {
  Deliverable,
  OpenWithSlotKey,
  OpenWithSlots,
  Project,
  RepoEntry,
  Step,
  TermSession,
  TerminalPrefs,
  Theme,
  Worktree,
} from '@shared/types';
import { NoteModal, type ModalState } from './note-modal';
import { ProjectPreview } from './project-preview';
import { resetMermaidTheme } from './markdown';
import { TerminalPane, type TerminalPaneHandle } from './terminal-pane';
import { buildSlugIndex } from './wikilinks';
import { PdfModal } from './pdf-modal';
import { HelpModal, type HelpDoc } from './help-modal';
import { PromptModal, type PromptModalState } from './prompt-modal';
import {
  applyStatus,
  applyStepMarker,
  groupByStatus,
  nextMarker,
  ProjectsView,
} from './tabs/projects';
import { KnowledgeView } from './tabs/knowledge';
import { CodeView, groupRepos } from './tabs/code';
import { SearchModal } from './search-modal';
import { SettingsModal } from './settings-modal';
import { matchesShortcut, parseShortcut } from './keymap';
import { createModalRouter } from './modal-router';
import { createTerminalBridge } from './terminal-bridge';
import { applyTreeEvents } from './tree-events';
import { QuitConfirmModal, type Tab, Toolbar } from './toolbar';
import './styles.css';
import './modals.css';
import './note-modal.css';
import './project-preview.css';

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
}

function App() {
  const [conceptionPath, setConceptionPath] = createSignal<string | null>(null);
  const [refreshKey, setRefreshKey] = createSignal(0);
  const [theme, setTheme] = createSignal<Theme>('system');
  const [toast, setToast] = createSignal<string | null>(null);
  const [tab, setTab] = createSignal<Tab>('projects');
  const [modal, setModal] = createSignal<ModalState>(null);
  const [previewPath, setPreviewPath] = createSignal<string | null>(null);
  const [pdfPath, setPdfPath] = createSignal<string | null>(null);
  const [helpDoc, setHelpDoc] = createSignal<HelpDoc | null>(null);
  const [helpMenuOpen, setHelpMenuOpen] = createSignal(false);
  const [terminalOpen, setTerminalOpen] = createSignal(false);
  const [searchModalOpen, setSearchModalOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [quitConfirmOpen, setQuitConfirmOpen] = createSignal(false);
  const [promptState, setPromptState] = createSignal<PromptModalState | null>(null);

  const flashToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 4000);
  };

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

  const unsubscribe = window.condash.onTreeEvents((events) => {
    void applyTreeEvents(events, {
      mutate,
      bumpRefreshKey: () => setRefreshKey((k) => k + 1),
    });
  });
  onCleanup(unsubscribe);

  // Track every live-or-exited session — Code tab uses code-side ones for
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
  // Track the branch each live repo session is running on so the Code-tab
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
    () => [conceptionPath(), refreshKey(), tab()] as const,
    async ([path, , currentTab]) => {
      if (!path || currentTab !== 'knowledge') return null;
      return window.condash.readKnowledgeTree();
    },
  );

  const [repos] = createResource(
    () => [conceptionPath(), refreshKey(), tab()] as const,
    async ([path, , currentTab]) => {
      if (!path || currentTab !== 'code') return [] as RepoEntry[];
      return window.condash.listRepos();
    },
  );

  const repoGroups = createMemo(() => groupRepos(repos() ?? []));

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
    if (!terminalOpen()) setTerminalOpen(true);
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
      flashToast(`Launch failed: ${(err as Error).message}`);
    }
  };

  const handleForceStop = async (repo: RepoEntry) => {
    if (!window.confirm(`Force-stop ${repo.name}?`)) return;
    try {
      await window.condash.forceStopRepo(repo.name);
      flashToast(`Force-stopped ${repo.name}`);
    } catch (err) {
      flashToast(`Force-stop failed: ${(err as Error).message}`);
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
    // Don't grab keystrokes from text inputs / editor / inside the xterm host —
    // the xterm canvas swallows printable keys via its own listener already.
    if (target?.closest('.xterm-host, input, textarea, .cm-editor, [contenteditable=true]')) {
      // The pane-toggle shortcut is the one exception: the user expects it
      // to work from inside the active terminal too.
    }

    const prefs = terminalPrefs() ?? {};
    const toggle = parseShortcut(prefs.shortcut ?? 'Ctrl+`');
    if (matchesShortcut(event, toggle)) {
      event.preventDefault();
      setTerminalOpen((v) => !v);
      return;
    }

    // Move-tab shortcuts only fire when the pane is open.
    if (!terminalOpen() || !terminalHandle) return;
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
    if (command === 'open-conception') {
      void window.condash.openConceptionDirectory().catch((err) => {
        flashToast(`Open failed: ${(err as Error).message}`);
      });
      return;
    }
    if (command === 'request-quit') {
      setQuitConfirmOpen(true);
      return;
    }
  });
  onCleanup(offMenu);

  // Click anywhere outside the help-menu wrapper closes the dropdown.
  const closeHelpMenu = () => {
    if (helpMenuOpen()) setHelpMenuOpen(false);
  };
  onMount(() => document.addEventListener('click', closeHelpMenu));
  onCleanup(() => document.removeEventListener('click', closeHelpMenu));

  const handleRunRepo = async (repo: RepoEntry, worktree?: Worktree) => {
    // The Code-tab Run button spawns a `side: 'code'` session that renders in
    // the inline CodeRunRow inside the Code tab — *not* in the bottom terminal
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
      flashToast(`Run failed: ${(err as Error).message}`);
    }
  };

  const handlePick = async () => {
    const picked = await window.condash.pickConceptionPath();
    if (!picked) return;
    setConceptionPath(picked);
    setRefreshKey((k) => k + 1);

    // Surface the bundled-template init when the picked folder lacks the
    // conception markers (projects/ + configuration.json). Init never
    // overwrites — existing files stay put.
    try {
      const state = await window.condash.detectConceptionState(picked);
      if (state.pathExists && !state.looksInitialised) {
        const missing: string[] = [];
        if (!state.hasProjects) missing.push('projects/');
        if (!state.hasConfiguration) missing.push('configuration.json');
        const ok = window.confirm(
          `This folder is missing ${missing.join(' and ')}.\n\n` +
            'Initialise it from the bundled conception template? ' +
            'Skill files, seed indexes, and example config will be laid down. ' +
            'Existing files are left alone.',
        );
        if (ok) {
          const { created } = await window.condash.initConception(picked);
          flashToast(`Initialised conception template — ${created.length} files created.`);
          setRefreshKey((k) => k + 1);
        }
      }
    } catch (err) {
      flashToast(`Init check failed: ${(err as Error).message}`);
    }
  };

  const handleRefresh = () => {
    // Drop the per-worktree git status cache before bumping refreshKey, so
    // the next listRepos() really does re-run `git status` everywhere.
    void window.condash.invalidateGitStatus();
    setRefreshKey((k) => k + 1);
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
    });
    if (slug === null) return;
    const trimmed = slug.trim();
    if (!trimmed) {
      flashToast('Empty slug — note not created.');
      return;
    }
    try {
      const path = await window.condash.createProjectNote(project.path, trimmed);
      const filename = path.split('/').pop() ?? path;
      flashToast(`Created ${filename}.`);
      // Open the new note in the in-app modal editor straight away.
      setModal({ path, title: filename });
    } catch (err) {
      flashToast(`Could not create note: ${(err as Error).message}`);
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

  const handleOpenKnowledgeFile = (path: string) => {
    setModal({ path });
  };

  const handleOpenHelp = (doc: HelpDoc) => {
    setHelpMenuOpen(false);
    setHelpDoc(doc);
  };

  const handleOpenPreferences = () => {
    if (!conceptionPath()) return;
    setSettingsOpen(true);
  };

  const handleConfirmQuit = () => {
    setQuitConfirmOpen(false);
    void window.condash.quitApp();
  };

  const slugIndex = () => buildSlugIndex(projects() ?? [], knowledge() ?? null);

  const handleWikilink = (slug: string) => {
    const matches = slugIndex().get(slug);
    if (!matches || matches.length === 0) {
      flashToast(`No item matches [[${slug}]]`);
      return;
    }
    const target = matches[0];
    router.navigateInModal({ path: target.path, title: target.title });
    if (matches.length > 1) {
      flashToast(`[[${slug}]] matched ${matches.length} items — opening the first`);
    }
  };

  const handleToggleStep = async (project: Project, step: Step) => {
    const next = nextMarker(step.marker);
    mutate((items) => applyStepMarker(items ?? [], project.path, step.lineIndex, next));
    try {
      await window.condash.toggleStep(project.path, step.lineIndex, step.marker, next);
    } catch (err) {
      mutate((items) => applyStepMarker(items ?? [], project.path, step.lineIndex, step.marker));
      flashToast(`Toggle failed: ${(err as Error).message}`);
    }
  };

  const handleEditStepText = async (project: Project, step: Step, newText: string) => {
    try {
      await window.condash.editStepText(project.path, step.lineIndex, step.text, newText);
      // Watcher fires a 'change' event for the README; the renderer patches in
      // place. No optimistic update — the line index could shift if anything
      // else changed in the file between read and write.
    } catch (err) {
      flashToast(`Edit step failed: ${(err as Error).message}`);
    }
  };

  const handleAddStep = async (project: Project, text: string) => {
    try {
      await window.condash.addStep(project.path, text);
    } catch (err) {
      flashToast(`Add step failed: ${(err as Error).message}`);
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
      await window.condash.setStatus(path, newStatus);
    } catch (err) {
      mutate((current) => applyStatus(current ?? [], path, previous));
      flashToast(`Status change failed: ${(err as Error).message}`);
    }
  };

  return (
    <div class="app">
      <Toolbar
        tab={tab()}
        conceptionPath={conceptionPath()}
        terminalOpen={terminalOpen()}
        helpMenuOpen={helpMenuOpen()}
        onTabChange={setTab}
        onToggleTerminal={() => setTerminalOpen((v) => !v)}
        onOpenSettings={handleOpenPreferences}
        onToggleHelpMenu={(e) => {
          e.stopPropagation();
          setHelpMenuOpen((v) => !v);
        }}
        onOpenHelp={handleOpenHelp}
        onRefresh={handleRefresh}
        onPickFolder={handlePick}
      />

      <Show
        when={conceptionPath()}
        fallback={
          <div class="empty">
            <p>Pick a conception directory to list its projects.</p>
            <button onClick={handlePick}>Choose folder…</button>
          </div>
        }
      >
        <Show when={tab() === 'projects'}>
          <Suspense fallback={<div class="empty">Loading…</div>}>
            <Show
              when={(projects() ?? []).length > 0}
              fallback={<div class="empty">No projects found under projects/.</div>}
            >
              <ProjectsView
                buckets={groupByStatus(projects() ?? [])}
                onOpen={handleOpenProject}
                onToggleStep={handleToggleStep}
                onDropProject={handleDropOnColumn}
                onWorkOn={(p) => void bridge.handleWorkOn(p)}
                onCreateNote={(p) => void handleCreateProjectNote(p)}
              />
            </Show>
          </Suspense>
        </Show>

        <Show when={tab() === 'knowledge'}>
          <Suspense fallback={<div class="empty">Loading…</div>}>
            <Show
              when={knowledge()}
              fallback={
                <div class="empty">No knowledge/ directory under the selected conception path.</div>
              }
            >
              <KnowledgeView root={knowledge()!} onOpen={handleOpenKnowledgeFile} />
            </Show>
          </Suspense>
        </Show>

        <Show when={tab() === 'code'}>
          <Suspense fallback={<div class="empty">Loading…</div>}>
            <Show
              when={(repos() ?? []).length > 0}
              fallback={
                <div class="empty">
                  No repositories listed. Add <code>repositories.primary</code> /{' '}
                  <code>secondary</code> to <code>configuration.json</code> via the gear.
                </div>
              }
            >
              <CodeView
                repos={repos() ?? []}
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
        </Show>
      </Show>

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
        />
      </Show>

      <Show when={helpDoc()}>
        <HelpModal doc={helpDoc()!} onClose={() => setHelpDoc(null)} />
      </Show>

      <PromptModal state={promptState()} onClose={() => setPromptState(null)} />

      <Show when={pdfPath()}>
        <PdfModal
          path={pdfPath()!}
          onClose={() => router.closeChildModal(() => setPdfPath(null))}
          onOpenInOs={handleOpenInEditor}
        />
      </Show>

      <TerminalPane
        open={terminalOpen()}
        onClose={() => setTerminalOpen(false)}
        launcherCommand={terminalPrefs()?.launcher_command ?? null}
        cwd={conceptionPath()}
        xtermPrefs={terminalPrefs()?.xterm}
        registerHandle={(handle) => {
          terminalHandle = handle;
        }}
      />

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
          onClose={() => setSettingsOpen(false)}
        />
      </Show>

      <Show when={quitConfirmOpen()}>
        <QuitConfirmModal
          onCancel={() => setQuitConfirmOpen(false)}
          onConfirm={handleConfirmQuit}
        />
      </Show>

      <Show when={toast()}>
        <div class="toast" role="status">
          {toast()}
        </div>
      </Show>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');
render(() => <App />, root);
