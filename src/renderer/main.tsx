import { render } from 'solid-js/web';
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  Show,
  Switch,
} from 'solid-js';
import type { KnowledgeNode, ResourceNode, SkillNode } from '@shared/types';
import { TerminalPane, type TerminalPaneHandle } from './terminal-pane';
import { ModalHost } from './modal-host';
import { WelcomeScreen } from './welcome-screen';
import { ProjectsView } from './panes/projects';
import { DeliverablesView } from './panes/deliverables';
import { TasksView } from './panes/tasks';
import { KnowledgeView } from './panes/knowledge';
import { CodeView } from './panes/code';
import { ResourcesView } from './panes/resources';
import { SkillsView } from './panes/skills';
import { LogsView } from './panes/logs';
import { usableActionTemplates } from './settings-modal-parts/data';
import { createModalRouter } from './modal-router';
import { createTerminalBridge } from './terminal-bridge';
import { createTreeExpansion } from './tree-expansion';
import { createBranchFilterStore } from './branch-filter-store';
import { createReposStore } from './repos-store';
import { createSessionsStore } from './sessions-store';
import { createProjectsStore } from './projects-store';
import { reloadPrIndex } from './pr-index-store';
import { createTreeStore } from './tree-store';
import { createGlobalKeyboard } from './global-keyboard';
import { createMenuRouter } from './menu-commands';
import { useToast } from './hooks/use-toast';
import { usePromptModal } from './hooks/use-prompt-modal';
import { useTheme } from './hooks/use-theme';
import { useCardMinWidth } from './hooks/use-card-min-width';
import { useLayout } from './hooks/use-layout';
import { useConfigBindings } from './hooks/use-config-bindings';
import { useModals } from './hooks/use-modals';
import { useProjectActions } from './hooks/use-project-actions';
import { useTreeActions } from './hooks/use-tree-actions';
import { useRepoActions } from './hooks/use-repo-actions';
import { useConception } from './hooks/use-conception';
import { useWelcome } from './hooks/use-welcome';
import { useSkillsScope } from './hooks/use-skills-scope';
import { useTreeEvents } from './hooks/use-tree-events';
import type { Deliverable, Project, WorkingSurface } from '@shared/types';
import './styles.css';
import './primitives.css';
import './actions.css';
import './modal-base.css';
import './project-preview.css';
import './action-dropdown-button.css';
import './welcome-screen.css';

/** Right-strip handles in display order. Each entry binds the
 *  working-surface enum value to its label + keyboard shortcut so the
 *  edge-strip JSX can map over them instead of repeating one block per
 *  surface. The actual key bindings live in `global-keyboard.ts`; the
 *  string here is just the tooltip suffix. */
const WORKING_SURFACE_HANDLES: ReadonlyArray<{
  key: NonNullable<WorkingSurface>;
  label: string;
  shortcut: string;
}> = [
  { key: 'code', label: 'Code', shortcut: 'Ctrl+Shift+C' },
  { key: 'knowledge', label: 'Knowledge', shortcut: 'Ctrl+Shift+K' },
  { key: 'resources', label: 'Resources', shortcut: 'Ctrl+R' },
  { key: 'skills', label: 'Skills', shortcut: 'Ctrl+L' },
  { key: 'logs', label: 'Logs', shortcut: 'Ctrl+Shift+L' },
];

function App() {
  // --- Toast first so every downstream hydration call can surface a
  //     failure to the user as soon as the IPC resolves ---
  const { toast, flashToast } = useToast();

  // --- Conception path (early so downstream stores can pick it up as a
  //     dep without circular hand-shakes) ---
  const [conceptionPath, setConceptionPath] = createSignal<string | null>(null);
  void window.condash
    .getConceptionPath()
    .then(setConceptionPath)
    .catch((err) =>
      flashToast(`Could not load conception path: ${(err as Error).message}`, 'error'),
    );

  // --- Self-contained hooks (no cross-deps) -----------------------------
  const { promptState, setPromptState, openPrompt } = usePromptModal();
  const { theme, isDark, handleThemeChange } = useTheme({ flashToast });
  const { cardMinWidth, handleCardMinWidthChange } = useCardMinWidth();
  const {
    modal,
    setModal,
    previewPath,
    setPreviewPath,
    pdfPath,
    setPdfPath,
    htmlPath,
    setHtmlPath,
    imagePath,
    setImagePath,
    helpDoc,
    setHelpDoc,
    searchModalOpen,
    setSearchModalOpen,
    settingsOpen,
    setSettingsOpen,
    newProjectOpen,
    setNewProjectOpen,
    aboutOpen,
    setAboutOpen,
    quitConfirmOpen,
    setQuitConfirmOpen,
    shortcutsOpen,
    setShortcutsOpen,
    noteDirty,
    setNoteDirty,
    initConfirmState,
    setInitConfirmState,
    forceStopState,
    setForceStopState,
    logsOpenRequest,
    setLogsOpenRequest,
    nextLogsOpenNonce,
  } = useModals();

  // --- Layout (toggle helpers + splitter drag) --------------------------
  const {
    layout,
    updateLayout,
    toggleProjects,
    toggleTerminal,
    toggleLeftView,
    selectWorking,
    ensureTerminalOpen,
    topBandVisible,
    topBandStyle,
    startSplitterDrag,
  } = useLayout({ flashToast });

  // Bottom-band body selector. The strip's Terminal / Dashboard handles switch
  // which body shows when the pane is open; re-selecting the active band's
  // handle closes the pane. Ephemeral per-session UI state (not persisted).
  const [bottomView, setBottomView] = createSignal<'terminal' | 'dashboard'>('terminal');
  const selectBottomBand = (view: 'terminal' | 'dashboard'): void => {
    if (layout().terminal && bottomView() === view) {
      toggleTerminal();
    } else {
      setBottomView(view);
      ensureTerminalOpen();
    }
  };

  // --- Tree expansion + branch filter (existing stores) ------------------
  const treeExpansion = createTreeExpansion({ flashToast });
  const {
    knowledgeExpanded,
    resourcesExpanded,
    skillsExpandedForScope,
    toggleTreeExpand,
    expandTreeDir,
  } = treeExpansion;
  const branchFilter = createBranchFilterStore({ flashToast });

  // --- Sessions store (drives Code-pane live badges + Stop button) ------
  const { allSessions, liveRepos, liveSessionCwds, codeRunSessions } = createSessionsStore();

  // --- Domain stores ----------------------------------------------------
  const projectsStore = createProjectsStore({ conceptionPath });
  const { projects, loaded: projectsLoaded, mutate, reload: reloadProjects } = projectsStore;

  // Keep the Projects-pane PR badges in sync with the project list: refetch the
  // per-repo open-PR index whenever the project set changes — initial load, a
  // watcher-driven card patch, a manual refresh, or a conception switch. The
  // main-process lookups are TTL-cached per repo, so list churn doesn't spam
  // `gh`; a conception with no branch-bearing projects clears the index.
  createEffect(() => {
    void reloadPrIndex(projects());
  });

  const knowledgeStore = createTreeStore<KnowledgeNode>({
    conceptionPath,
    fetcher: () => window.condash.readKnowledgeTree(),
    key: 'relPath',
    active: () => layout().working === 'knowledge',
  });
  const knowledge = knowledgeStore.root;

  const resourcesStore = createTreeStore<ResourceNode>({
    conceptionPath,
    fetcher: () => window.condash.readResourcesTree(),
    key: 'relPath',
    active: () => layout().working === 'resources',
  });
  const resources = resourcesStore.root;

  // Conception/user scope toggle. Created before the skills store: the
  // store's fetcher reads `skillsActiveScope()`, and that reactive read is
  // what makes the store reload when the scope flips.
  const { skillsActiveScope, handleSkillsScopeSelect } = useSkillsScope({ flashToast });

  // Single skills tree store — the active scope (conception or user) drives
  // which on-disk root the fetcher walks. Post-reframe the pane has no tab
  // dimension; agedum sources are the only surface.
  const skillsStore = createTreeStore<SkillNode>({
    conceptionPath,
    fetcher: () => window.condash.readSkillsTree(skillsActiveScope()),
    key: 'relPath',
    active: () => layout().working === 'skills',
  });

  const reposStore = createReposStore({ conceptionPath, flashToast });
  const { repos, reposLoaded, reloadRepos } = reposStore;

  // --- Config bindings (Open With + terminal prefs) ---------------------
  const { openWithSlots, terminalPrefs, reloadConfig } = useConfigBindings({ conceptionPath });

  // --- Agents (tab-strip spawn dropdown + action-template bindings) -----
  // The `agents` settings list, re-fetched whenever the conception changes.
  // `reloadAgents` refreshes the dropdown after a settings edit.
  const [agentsResource, { refetch: reloadAgents }] = createResource(conceptionPath, async () => {
    try {
      return await window.condash.listAgents();
    } catch {
      return [];
    }
  });
  const agents = () => agentsResource() ?? [];

  // --- Tasks (left-pane reusable agent prompts) -------------------------
  // Re-fetched whenever the conception changes; `reloadTasks` refreshes the
  // pane after a create / edit / delete so the card list stays live.
  const [tasksResource, { refetch: reloadTasks }] = createResource(conceptionPath, async () => {
    try {
      return await window.condash.listTasks();
    } catch {
      return [];
    }
  });
  const tasks = () => tasksResource() ?? [];

  // --- Logs refresh trigger ---------------------------------------------
  // The Logs pane owns its own createResource, so it can't expose a reload
  // function the way the stores do. View → Refresh bumps this counter and the
  // pane refetches via a deferred `on(...)` effect. See reloadLogs below.
  const [logsRefreshTick, setLogsRefreshTick] = createSignal(0);

  // App options for the Tasks fill form's `{APP}` picker — every configured
  // repo as `{ alias: '#<name>', name, path }`. Reads the repos store, so it
  // re-derives when the repo list changes.
  const appOptions = createMemo(() =>
    repos.map((r) => ({ alias: `#${r.name}`, name: r.name, path: r.path })),
  );

  // Stable references to the filtered action-template arrays. `usableActionTemplates`
  // returns a *fresh* filtered array on every call; without memoising, any reactive
  // re-read of these props allocates a new array, which makes Solid's `<For>` inside
  // ActionDropdownButton's menu re-create every menu item on each re-render. The
  // detach-then-reattach cycle is fast enough to be invisible but races every click —
  // the menu item DOM node gets replaced *between* mousedown and mouseup, so the
  // click never fires and the dropdown looks dead. createMemo gives `<For>` a stable
  // reference whenever the underlying template list is unchanged.
  const projectActionItems = createMemo(() =>
    usableActionTemplates(terminalPrefs()?.projectActions ?? []),
  );
  const newProjectActionItems = createMemo(() =>
    usableActionTemplates(terminalPrefs()?.newProjectActions ?? []),
  );

  // --- Modal router + terminal bridge -----------------------------------
  let terminalHandle: TerminalPaneHandle | null = null;
  const router = createModalRouter({ modal, setModal, setPdfPath, setPreviewPath });
  const bridge = createTerminalBridge({
    terminalHandle: () => terminalHandle,
    ensureTerminalOpen,
    terminalPrefs,
    agents,
    flashToast,
    conceptionPath,
  });

  // --- Repo actions (Code-pane row callbacks) ---------------------------
  const { handleLaunch, handlePull, handleForceStop, runForceStop, handleStopRepo, handleRunRepo } =
    useRepoActions({
      allSessions,
      getTerminalHandle: () => terminalHandle,
      setForceStopState,
      flashToast,
    });

  // --- Tree actions (createMd / mkdir / importFile + open handlers) -----
  const {
    treeMutations,
    skillsMutations,
    treePrompts,
    treeError,
    resourcesActions,
    handleAfterTreeMutation,
    handleOpenKnowledgeFile,
    handleOpenSkillFile,
    handleOpenInEditor,
    handleOpenDeliverable,
  } = useTreeActions({
    knowledgeStore,
    resourcesStore,
    skillsStore,
    expandTreeDir,
    openPrompt,
    setModal,
    setPdfPath,
    setHtmlPath,
    setImagePath,
    setSettingsOpen,
    bridge,
    flashToast,
  });

  // --- Tree-events handler (wires watcher pushes to store reloads) ------
  useTreeEvents({
    mutateProjects: mutate,
    reloadProjects,
    knowledgeStore,
    resourcesStore,
    skillsStore,
    reloadConfig,
    reloadRepos,
  });

  // --- Project actions (card open, drop-to-status, step edits, links) ---
  const projectActions = useProjectActions({
    router,
    projects,
    knowledge,
    mutate,
    setModal,
    setPreviewPath,
    setPdfPath,
    setHtmlPath,
    setImagePath,
    openPrompt,
    flashToast,
  });
  const {
    activeProjectBranches,
    projectsTabGroups,
    handleOpenProject,
    handleOpenReadmeFromPreview,
    handleOpenDeliverableFromPreview,
    handleOpenFileFromPreview,
    handleDropOnColumn,
    handleToggleStep,
    handleEditStepText,
    handleAddStep,
    handleWikilink,
    handleCreateProjectNote,
  } = projectActions;
  const previewProject = (): Project | null => projectActions.previewProject(previewPath);

  // Open a deliverable by kind: wikilinks navigate within condash; file/URL
  // links route through the type-aware opener (PDF/HTML modal, browser, …).
  const openDeliverable = (deliverable: Deliverable): void => {
    if (deliverable.kind === 'wikilink') handleWikilink(deliverable.path);
    else handleOpenDeliverable(deliverable.path);
  };

  // --- Welcome screen ---------------------------------------------------
  const knowledgeIsEmpty = (): boolean => {
    const k = knowledge();
    if (k === null || k === undefined) return true;
    if (Array.isArray((k as { children?: unknown[] }).children)) {
      return (k as { children: unknown[] }).children.length === 0;
    }
    return false;
  };
  const {
    shouldShowWelcome,
    handleWelcomeOpenTree,
    handleWelcomeTakeTour,
    handleWelcomeOpenDocs,
    handleWelcomeDismiss,
  } = useWelcome({
    conceptionPath,
    projectsLoaded,
    projects,
    knowledgeIsEmpty,
    setHelpDoc,
  });

  // --- Conception lifecycle (pick / refresh / init / quit) --------------
  const { handleRefresh, handlePick, runInit, handleConfirmQuit } = useConception({
    conceptionPath,
    setConceptionPath,
    knowledgeStore,
    resourcesStore,
    skillsStore,
    reloadProjects,
    reloadConfig,
    reloadRepos,
    reloadAgents: () => void reloadAgents(),
    reloadTasks: () => void reloadTasks(),
    reloadLogs: () => setLogsRefreshTick((n) => n + 1),
    setInitConfirmState,
    flashToast,
  });

  // --- Global wiring (keyboard shortcuts + native menu router) ----------
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
    toggleDashboardBand: () => selectBottomBand('dashboard'),
    handleRefresh: () => handleRefresh(),
    handlePick: () => handlePick(),
    flashToast,
  });

  // --- Top-band ref for the splitter drag (must live on App so the
  //     callback ref captures the DOM node into a closure that the hook
  //     can read) ---
  let topBandRef: HTMLDivElement | undefined;
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
            classList={{ active: layout().projects && layout().leftView === 'projects' }}
            aria-pressed={layout().projects && layout().leftView === 'projects'}
            onClick={() => toggleLeftView('projects')}
            disabled={!handlesEnabled()}
            title={
              layout().projects && layout().leftView === 'projects'
                ? 'Hide Projects'
                : 'Show Projects'
            }
          >
            <span class="edge-handle-label">Projects</span>
          </button>
          <button
            class="edge-handle edge-handle-vertical"
            classList={{ active: layout().projects && layout().leftView === 'tasks' }}
            aria-pressed={layout().projects && layout().leftView === 'tasks'}
            onClick={() => toggleLeftView('tasks')}
            disabled={!handlesEnabled()}
            title={layout().projects && layout().leftView === 'tasks' ? 'Hide Tasks' : 'Show Tasks'}
          >
            <span class="edge-handle-label">Tasks</span>
          </button>
          <button
            class="edge-handle edge-handle-vertical"
            classList={{ active: layout().projects && layout().leftView === 'deliverables' }}
            aria-pressed={layout().projects && layout().leftView === 'deliverables'}
            onClick={() => toggleLeftView('deliverables')}
            disabled={!handlesEnabled()}
            title={
              layout().projects && layout().leftView === 'deliverables'
                ? 'Hide Deliverables'
                : 'Show Deliverables'
            }
          >
            <span class="edge-handle-label">Deliverables</span>
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
                  <button onClick={() => toggleLeftView('projects')}>Show Projects</button>
                  <button onClick={() => toggleLeftView('tasks')}>Show Tasks</button>
                  <button onClick={() => toggleLeftView('deliverables')}>Show Deliverables</button>
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
                  <section
                    class="pane pane-projects"
                    classList={{
                      'pane-deliverables': layout().leftView === 'deliverables',
                      'pane-tasks': layout().leftView === 'tasks',
                    }}
                  >
                    {/* Left band shows one pane at a time, selected by the left
                        edge-strip handles (Projects / Tasks / Deliverables). */}
                    <Switch>
                      <Match when={layout().leftView === 'deliverables'}>
                        <DeliverablesView
                          projects={projects() ?? []}
                          onOpenDeliverable={openDeliverable}
                          onReveal={(p) => void window.condash.showInFolder(p)}
                        />
                      </Match>
                      <Match when={layout().leftView === 'tasks'}>
                        <TasksView
                          tasks={tasks}
                          reload={() => void reloadTasks()}
                          hasConception={() => conceptionPath() !== null}
                          conceptionPath={conceptionPath}
                          agents={agents}
                          projects={() => projects() ?? []}
                          apps={appOptions}
                          flashToast={flashToast}
                          onRun={(agentId, text, taskName, opts) =>
                            void bridge.runTask(agentId, text, taskName, opts)
                          }
                        />
                      </Match>
                      <Match when={layout().leftView === 'projects'}>
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
                            projectActions={projectActionItems()}
                            onProjectAction={(p, a) => void bridge.handleProjectAction(p, a)}
                            onNewProject={() => setNewProjectOpen(true)}
                            newProjectActions={newProjectActionItems()}
                            onNewProjectAction={(a) => void bridge.handleNewProjectAction(a)}
                          />
                        </Show>
                      </Match>
                    </Switch>
                  </section>
                </Show>

                <Show when={layout().projects && layout().working !== null}>
                  <div
                    class="top-band-splitter"
                    onMouseDown={(e) => startSplitterDrag(e, topBandRef)}
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
                    <LogsView openRequest={logsOpenRequest} refreshSignal={logsRefreshTick} />
                  </section>
                </Show>

                <Show when={layout().working === 'skills'}>
                  <section class="pane pane-working">
                    <SkillsView
                      scope={skillsActiveScope()}
                      onSelectScope={handleSkillsScopeSelect}
                      onRefresh={() => void skillsStore.reload()}
                      root={skillsStore.root() ?? null}
                      onOpen={handleOpenSkillFile}
                      onCopyInstallCommand={() => {
                        void navigator.clipboard
                          .writeText('condash skills install')
                          .then(() => flashToast('Copied install command', 'success'))
                          .catch((err) =>
                            flashToast(`Copy failed: ${(err as Error).message}`, 'error'),
                          );
                      }}
                      expanded={() => skillsExpandedForScope(skillsActiveScope())()}
                      onToggleExpand={(rel) => toggleTreeExpand('skills', rel, skillsActiveScope())}
                      mutations={skillsMutations}
                      prompts={treePrompts}
                      onAfterMutation={(newPath, kind, source) =>
                        handleAfterTreeMutation('skills', newPath, kind, source)
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
                        onPull={(path) => void handlePull(path)}
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

        {/* Right strip — working-surface handles. Mutually exclusive in
            the working slot; clicking the active one hides the slot,
            clicking another swaps. Surfaces listed in display order. */}
        <aside class="edge-strip edge-strip-right">
          <For each={WORKING_SURFACE_HANDLES}>
            {(handle) => (
              <button
                class="edge-handle edge-handle-vertical"
                classList={{ active: layout().working === handle.key }}
                aria-pressed={layout().working === handle.key}
                onClick={() => selectWorking(layout().working === handle.key ? null : handle.key)}
                disabled={!handlesEnabled()}
                title={
                  layout().working === handle.key
                    ? `Hide ${handle.label} (${handle.shortcut})`
                    : `Show ${handle.label} (${handle.shortcut})`
                }
              >
                <span class="edge-handle-label">{handle.label}</span>
              </button>
            )}
          </For>
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
        bottomView={bottomView()}
        onSelectBand={selectBottomBand}
        onShowTerminalBand={() => {
          setBottomView('terminal');
          ensureTerminalOpen();
        }}
        agents={agents()}
        cwd={conceptionPath()}
        xtermPrefs={terminalPrefs()?.xterm}
        autoRefreshOnTabSwitch={terminalPrefs()?.autoRefreshOnTabSwitch}
        registerHandle={(handle) => {
          terminalHandle = handle;
        }}
      />

      <ModalHost
        previewProject={previewProject}
        previewPath={previewPath}
        setPreviewPath={setPreviewPath}
        handleToggleStep={handleToggleStep}
        handleEditStepText={handleEditStepText}
        handleAddStep={handleAddStep}
        handleDropOnColumn={handleDropOnColumn}
        handleOpenReadmeFromPreview={handleOpenReadmeFromPreview}
        handleOpenFileFromPreview={handleOpenFileFromPreview}
        handleOpenDeliverableFromPreview={handleOpenDeliverableFromPreview}
        handleWikilink={handleWikilink}
        handleCreateProjectNote={handleCreateProjectNote}
        handleOpenInEditor={handleOpenInEditor}
        handleOpenKnowledgeFile={handleOpenKnowledgeFile}
        openDeliverable={openDeliverable}
        projectActionItems={projectActionItems}
        bridge={bridge}
        router={router}
        modal={modal}
        setModal={setModal}
        setNoteDirty={setNoteDirty}
        isDark={isDark}
        helpDoc={helpDoc}
        setHelpDoc={setHelpDoc}
        aboutOpen={aboutOpen}
        setAboutOpen={setAboutOpen}
        shortcutsOpen={shortcutsOpen}
        setShortcutsOpen={setShortcutsOpen}
        promptState={promptState}
        setPromptState={setPromptState}
        pdfPath={pdfPath}
        setPdfPath={setPdfPath}
        htmlPath={htmlPath}
        setHtmlPath={setHtmlPath}
        imagePath={imagePath}
        setImagePath={setImagePath}
        searchModalOpen={searchModalOpen}
        setSearchModalOpen={setSearchModalOpen}
        setLogsOpenRequest={setLogsOpenRequest}
        nextLogsOpenNonce={nextLogsOpenNonce}
        selectWorking={selectWorking}
        settingsOpen={settingsOpen}
        setSettingsOpen={setSettingsOpen}
        conceptionPath={conceptionPath}
        theme={theme}
        handleThemeChange={handleThemeChange}
        cardMinWidth={cardMinWidth}
        handleCardMinWidthChange={handleCardMinWidthChange}
        newProjectOpen={newProjectOpen}
        setNewProjectOpen={setNewProjectOpen}
        reloadProjects={reloadProjects}
        flashToast={flashToast}
        quitConfirmOpen={quitConfirmOpen}
        setQuitConfirmOpen={setQuitConfirmOpen}
        noteDirty={noteDirty}
        handleConfirmQuit={handleConfirmQuit}
        forceStopState={forceStopState}
        setForceStopState={setForceStopState}
        runForceStop={runForceStop}
        initConfirmState={initConfirmState}
        setInitConfirmState={setInitConfirmState}
        runInit={runInit}
        toast={toast}
      />
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');
render(() => <App />, root);
