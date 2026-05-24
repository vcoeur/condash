import type { AgentDef, AgentListItem, AgentSpawnPreview } from './harnesses';
import type { TaskDef, TaskListItem } from './tasks';
import type {
  CardMinWidthPrefs,
  ConceptionInitState,
  DirtyDetails,
  HelpDocName,
  KnowledgeNode,
  LayoutState,
  OpenWithSlotKey,
  OpenWithSlots,
  Platform,
  Project,
  ProjectCreateInput,
  ProjectCreateResult,
  ProjectFileEntry,
  RepoEntry,
  RepoEvent,
  ResourceNode,
  SearchResults,
  SkillNode,
  SkillScope,
  SkillTab,
  StepMarker,
  TermDataMessage,
  TermExitMessage,
  TermLogSessionMeta,
  TermLogSessionRead,
  TermSession,
  TermSpawnRequest,
  TerminalPrefs,
  Theme,
  TransitionResult,
  TreeEvent,
  TreeExpansionPrefs,
  TreeRoot,
} from './types';

export interface CondashApi {
  listProjects(): Promise<Project[]>;
  getProject(path: string): Promise<Project | null>;
  readKnowledgeTree(): Promise<KnowledgeNode | null>;
  /** Tree under <conception>/<resources_path> — every file (any extension),
   * carrying mime + coarse category for the renderer's icon picker.
   * Resolves to null when the directory is missing. */
  readResourcesTree(): Promise<ResourceNode | null>;
  /** Tree under the active skills tab's root, for the given scope.
   *  `local` reads the conception; `global` reads the per-machine user scope
   *  (`~/.config/agents/`, `~/.claude/`, `~/.kimi/`, `~/.config/opencode/`):
   *  - generic → `…/skills/` (`.md` and `.yaml`) + `common.md`/`<model>.md` sources
   *  - claude  → `…/skills/` (`.md` only) + the compiled `CLAUDE.md`
   *  - kimi    → `…/skills/` (`.md` only) + `AGENTS.md`
   *  - opencode→ `…/skills/` (`.md` only) + `AGENTS.md`
   * Shipped-SHA stamps are populated from `.condash-skills.json` when present.
   * Resolves to null when the directory and all agent-config files are absent. */
  readSkillsTree(scope: SkillScope, tab: SkillTab): Promise<SkillNode | null>;
  /** Read-only content of a Skills-pane file. Permits the active conception
   *  and the user-scope skill / agent-config locations (global scope lives
   *  outside the conception); rejects anything else. */
  readSkillFile(path: string): Promise<string>;
  search(query: string): Promise<SearchResults>;
  listRepos(): Promise<RepoEntry[]>;
  /** Per-primary partial reload — returns the primary's `RepoEntry` plus
   * its submodule children freshly re-read. Driven by the structural
   * FS-watcher event `repo-worktrees-changed`. Empty array when the
   * primary is no longer in `condash.json`. */
  listReposForPrimary(primaryName: string): Promise<RepoEntry[]>;
  /** Drop the in-memory git-status cache. Use from Refresh so the next
   * listRepos() runs `git status` everywhere instead of returning TTL-
   * cached values. */
  invalidateGitStatus(): Promise<void>;
  /** Detailed `git status -s` + `git diff --stat HEAD` for a worktree path.
   * Powers the click-to-inspect popover on the per-branch `N dirty` badge.
   * Returns null when the path is missing or not a git repo. */
  getDirtyDetails(path: string, opts?: { scopeToSubtree?: boolean }): Promise<DirtyDetails | null>;
  listOpenWith(): Promise<OpenWithSlots>;
  launchOpenWith(slot: OpenWithSlotKey, path: string): Promise<void>;
  forceStopRepo(repoName: string): Promise<void>;
  openInEditor(path: string): Promise<void>;
  pickConceptionPath(): Promise<string | null>;
  getConceptionPath(): Promise<string | null>;
  /** Switch the active conception to one of the recents. Promotes the path
   * to the head of `recentConceptionPaths`, swaps the FS watchers, and
   * fires the same broadcast `pickConceptionPath`'s success branch does.
   * Returns the path so the renderer can re-render against it without a
   * second `getConceptionPath` round-trip. */
  openConception(path: string): Promise<string>;
  /** Path to the conception's editable config file (`condash.json`,
   * falling back to legacy `configuration.json`). Returns `null` when no
   * conception is active. */
  getConceptionConfigPath(): Promise<string | null>;
  /** Per-machine list of recently-opened conception paths, newest first.
   * Drives the File → Open Recent submenu and the Settings modal. */
  getRecentConceptionPaths(): Promise<string[]>;
  /** Drop the entire recents list. Does not touch `lastConceptionPath` —
   * the active conception is whichever the user has open right now. */
  clearRecentConceptionPaths(): Promise<void>;
  /** Drop one entry from the recents list. Does not touch `lastConceptionPath`. */
  removeRecentConceptionPath(path: string): Promise<void>;
  /** Probe a candidate workspace path: does it have projects/ and condash.json? */
  detectConceptionState(path: string): Promise<ConceptionInitState>;
  /** Lay the bundled conception-template/ tree into `path`. Existing files preserved. */
  initConception(path: string): Promise<{ created: string[] }>;
  getTheme(): Promise<Theme>;
  setTheme(theme: Theme): Promise<void>;
  /** Composite-layout state (which panes are shown + their sizes).
   * Persisted in the global per-machine settings.json. */
  getLayout(): Promise<LayoutState>;
  setLayout(layout: LayoutState): Promise<void>;
  /** Whether the first-launch welcome screen was dismissed by the user.
   * Stored as `welcome.dismissed` in settings.json. */
  getWelcomeDismissed(): Promise<boolean>;
  setWelcomeDismissed(value: boolean): Promise<void>;
  /** Per-pane card grid min-width (CSS pixels). Returned as a fully-resolved
   *  object — missing keys are filled in with `DEFAULT_CARD_MIN_WIDTH` so
   *  the renderer never has to deal with `undefined`. */
  getCardMinWidth(): Promise<Required<CardMinWidthPrefs>>;
  /** Persist the user-edited card min-widths. Keys explicitly set to the
   *  built-in default are dropped from settings.json so the file stays
   *  small and re-defaulting works automatically when the bundled
   *  defaults change in a future release. */
  setCardMinWidth(prefs: CardMinWidthPrefs): Promise<void>;
  /** Per-pane set of expanded directory `relPath`s for the three tree
   *  panes. The empty-string entry stands in for the pane root. Returns a
   *  fully-resolved object — every key has at least an empty array so the
   *  renderer never has to deal with `undefined`. */
  getTreeExpansion(): Promise<Required<TreeExpansionPrefs>>;
  /** Persist the per-pane expanded-directory sets. The patch is a full
   *  replacement; pass `{}` to clear back to the all-collapsed default. */
  setTreeExpansion(prefs: TreeExpansionPrefs): Promise<void>;
  /** Branch names the Code-pane top-of-pane filter currently pins as
   *  visible on every app card. Always returns a deduped array (possibly
   *  empty); the renderer wraps it in a `Set` for membership tests. */
  getSelectedBranches(): Promise<string[]>;
  /** Persist the Code-pane pinned-branches set. Pass an empty array to
   *  hide every non-primary row (the on-purpose default). */
  setSelectedBranches(list: string[]): Promise<void>;
  /** Whether the branch-pin selector is in "All (sticky)" mode — every
   *  branch shown, new branches auto-pinned. Defaults to true when the
   *  field is undefined and `selectedBranches` is empty (preserves the
   *  old "empty = show all" behaviour). Issue #169. */
  getBranchFilterStickyAll(): Promise<boolean>;
  /** Persist the All-sticky mode flag. */
  setBranchFilterStickyAll(value: boolean): Promise<void>;
  /** Active tab in the Skills pane. Persisted per-machine in settings.json. */
  getSkillsActiveTab(): Promise<SkillTab>;
  setSkillsActiveTab(tab: SkillTab): Promise<void>;
  /** Active scope (local conception vs global user scope) in the Skills pane.
   *  Persisted per-machine; defaults to `local`. */
  getSkillsActiveScope(): Promise<SkillScope>;
  setSkillsActiveScope(scope: SkillScope): Promise<void>;
  /** Absolute path to `~/.config/condash/settings.json` (or platform equivalent),
   * for the settings modal's "Open externally" button. */
  getSettingsPath(): Promise<string>;
  /**
   * Raw text content of `settings.json`. Returns `''` when the file is
   * absent — the Settings modal treats that as "fresh defaults" and creates
   * the file on first save. Used to drive the Global tab's editor and to
   * compute inheritance badges by comparing against the conception's
   * `condash.json`.
   */
  getGlobalSettingsRaw(): Promise<string>;
  /**
   * Atomic CAS write to `settings.json`. The main process canonicalises
   * the JSON through `globalSettingsSchema` before writing — so the bytes
   * that hit disk can differ from `newContent` (Zod reorders keys to
   * schema order). Returns whatever was actually written so the caller can
   * keep its CAS baseline aligned with disk.
   */
  writeGlobalSettings(expectedContent: string, newContent: string): Promise<string>;
  toggleStep(
    path: string,
    lineIndex: number,
    expectedMarker: StepMarker,
    newMarker: StepMarker,
  ): Promise<void>;
  editStepText(
    path: string,
    lineIndex: number,
    expectedText: string,
    newText: string,
  ): Promise<void>;
  addStep(path: string, text: string): Promise<void>;
  listProjectFiles(path: string): Promise<ProjectFileEntry[]>;
  /**
   * Set a project's `**Status**` field. On done-edges (close: prev != done →
   * done; reopen: done → prev != done) also append a `Closed.` /
   * `Reopened.` entry to `## Timeline`. Other transitions only edit the
   * header. The returned `TransitionResult.timelineAppended` is non-null
   * exactly when a timeline line was written, so the renderer can refresh
   * the popup's timeline pane and show a leftover-branch toast on close.
   */
  setStatus(
    path: string,
    newStatus: string,
    opts?: { summary?: string },
  ): Promise<TransitionResult>;
  /**
   * Create a new project / incident / document under
   * `projects/<YYYY-MM>/<YYYY-MM-DD>-<slug>/`. The renderer's "+ New
   * project" form dispatches here with the minimal field set (Apps stays
   * empty for now, the user fills it in later by editing the README or
   * via the popup). Returns the new directory and README paths so the
   * caller can refresh the list and auto-open the popup.
   */
  createProject(input: ProjectCreateInput): Promise<ProjectCreateResult>;
  readNote(path: string): Promise<string>;
  /**
   * Atomically write `newContent` if disk still matches `expectedContent`.
   * For `condash.json`, the main process canonicalises the JSON
   * through the Zod schema before writing — so the bytes that hit disk can
   * differ from `newContent` (e.g. Zod reorders object keys to schema
   * order). Returns whatever was actually written so the caller can keep
   * its CAS baseline aligned with disk.
   */
  writeNote(path: string, expectedContent: string, newContent: string): Promise<string>;
  /**
   * Read one of the bundled help docs (`docs/<name>.md`). The main process
   * whitelists the shipped names; anything else rejects.
   */
  readHelpDoc(name: HelpDocName): Promise<string>;
  /**
   * Subscribe to per-path tree events emitted by the main-process file watcher.
   * Each callback receives a debounced batch. Returns an unsubscribe function.
   */
  onTreeEvents(callback: (events: TreeEvent[]) => void): () => void;
  /**
   * Subscribe to per-repo events emitted when a repo's working tree or
   * `.git/{index,HEAD,refs/heads}` changes. The renderer uses these to
   * patch a single `RepoEntry.dirty` (or a worktree's dirty count) in
   * place — no list refetch, no Suspense remount, dropdowns stay open.
   * Returns an unsubscribe function.
   */
  onRepoEvents(callback: (events: RepoEvent[]) => void): () => void;

  /** List agents defined under `<conception>/agents/*.json`, each with token
   *  presence (never the value). Empty when no conception / no agents. */
  listAgents(): Promise<AgentListItem[]>;
  /** Read one agent definition by slug. Null when absent. Carries no token. */
  readAgent(slug: string): Promise<AgentDef | null>;
  /** Create / update an agent JSON file at `agents/<slug>.json` (the def's
   *  lowercase-kebab `slug`, validated by the main process). When `previousSlug`
   *  differs from the new slug, the old file is removed (rename). Returns the
   *  resolved slug. */
  writeAgent(def: AgentDef, previousSlug?: string): Promise<string>;
  /** Delete an agent definition file by slug. */
  deleteAgent(slug: string): Promise<void>;
  /** Spawn preview for the pane's "view full config" — auth vars show
   *  `$SECRET_ENV` references, never a token. Null when the agent is absent. */
  previewAgent(slug: string): Promise<AgentSpawnPreview | null>;
  /** Raw contents of `<conception>/agents/.env` for the in-app token editor —
   *  a commented template when the file is absent, or null when no conception
   *  is active. This is the one verb that returns secret *values* to the
   *  renderer, by explicit user action. */
  readAgentsEnv(): Promise<string | null>;
  /** Write the token editor's contents back to `<conception>/agents/.env`. */
  writeAgentsEnv(content: string): Promise<void>;

  /** List tasks defined under `<conception>/tasks/*`, each with its referenced
   *  agent, agent presence, and parsed markers. Empty when no conception. */
  listTasks(): Promise<TaskListItem[]>;
  /** Read one task by slug (name / agent / submit / prompt). Null when absent. */
  readTask(slug: string): Promise<TaskDef | null>;
  /** Create / update a task directory (`task.json` + `prompt.md`). When
   *  `previousSlug` differs from `slug`, the old directory is removed (rename).
   *  Returns the resolved slug. */
  writeTask(slug: string, def: TaskDef, previousSlug?: string): Promise<string>;
  /** Delete a task directory by slug. */
  deleteTask(slug: string): Promise<void>;
  /** Repoint every task referencing `oldAgentSlug` to `newAgentSlug` (cascade
   *  after an agent rename). Returns how many tasks were rewritten. */
  repointTasksAgent(oldAgentSlug: string, newAgentSlug: string): Promise<number>;

  termSpawn(request: TermSpawnRequest): Promise<{ id: string; cwd: string }>;
  termWrite(id: string, data: string): Promise<void>;
  /** Read the system clipboard via the main process. Used by the terminal's
   * Ctrl+V handler — the renderer's navigator.clipboard.readText() is
   * permission-gated and unreliable in Electron. */
  clipboardReadText(): Promise<string>;
  termResize(id: string, cols: number, rows: number): Promise<void>;
  termClose(id: string): Promise<void>;
  termGetPrefs(): Promise<TerminalPrefs>;
  /** Replace the persisted terminal prefs in settings.json. The patch is a
   * full replacement; pass `{}` to clear back to defaults. */
  termSetPrefs(prefs: TerminalPrefs): Promise<void>;
  termLatestScreenshot(dir: string): Promise<string | null>;
  /** Snapshot of currently-tracked sessions (live or recently exited). */
  termList(): Promise<TermSession[]>;
  /** Pull the buffered output for an existing session, used on renderer
   * mount to replay history into a freshly-created xterm. */
  termAttach(id: string): Promise<{ output: string; exited?: number } | null>;
  /** Re-side a session — used by the Code-pane pop-out button to surface a
   * running dev server in the bottom "My terms" pane. */
  termSetSide(id: string, side: 'my' | 'code'): Promise<void>;
  onTermData(callback: (msg: TermDataMessage) => void): () => void;
  onTermExit(callback: (msg: TermExitMessage) => void): () => void;
  /** Sessions changed (spawn / exit / close). Receives the full snapshot. */
  onTermSessions(callback: (sessions: TermSession[]) => void): () => void;

  /** List the day-directories present under
   * `<conception>/.condash/logs/` — newest first. Empty when no
   * conception is active or no logs have been captured. */
  logsListDays(): Promise<{ day: string; path: string }[]>;
  /** List session-file metadata (path, time, size, repo, cmd) for one
   * day. `day` is `YYYY-MM-DD`. */
  logsListSessions(day: string): Promise<TermLogSessionMeta[]>;
  /** Read a session's plain-text body + parsed `# condash: {...}` header /
   * footer metadata. */
  logsReadSession(filePath: string): Promise<TermLogSessionRead>;
  /** Wipe an entire day-directory. */
  logsDeleteDay(day: string): Promise<{ deleted: boolean }>;
  /** Delete a single session (one pty spawn). Bounded under
   *  `<conception>/.condash/logs/`; rejects paths outside the logs root
   *  or files that don't end in `.txt`. */
  logsDeleteSession(filePath: string): Promise<{ deleted: boolean }>;

  /** Open the configured conception directory in the OS file manager. */
  openConceptionDirectory(): Promise<void>;
  /** Open an `http(s):` or `mailto:` URL with the OS default handler.
   *  Other schemes (incl. `file:`) are rejected for safety — call
   *  `openPath` for local filesystem paths. */
  openExternal(target: string): Promise<void>;
  /** Open a local filesystem path with the OS default handler. Used by
   *  the Settings modal's "Open externally" buttons for condash.json
   *  and settings.json. Caller must pass an absolute path. */
  openPath(target: string): Promise<void>;
  /** Create a new note file under <projectPath>/notes/. The slug is sanitised
   *  and prefixed with the next zero-padded NN- counter. Returns the absolute
   *  path of the new file (always created — caller can then open it). */
  createProjectNote(projectPath: string, slug: string): Promise<string>;
  /** Create a new markdown file under one of the three tree panes'
   *  directories. `dirRelPath` is relative to the pane's on-disk root (`''`
   *  for the root). `filename` is sanitised to lowercase-hyphen and an
   *  `.md` extension is appended when missing. Resources accept any
   *  extension; knowledge / skills always force `.md`. Refuses to overwrite
   *  an existing file. Returns the new file's absolute path so the caller
   *  can re-fetch the tree and open the file in the editor.
   *  When `root === 'skills'`, `skillTab` selects which tab's directory is
   *  the target (generic / claude / kimi). Kimi rejects with an error. */
  treeCreateMd(
    root: TreeRoot,
    dirRelPath: string,
    filename: string,
    skillTab?: SkillTab,
  ): Promise<string>;
  /** Create a new subdirectory under one of the three tree panes'
   *  directories. Same `dirRelPath` semantics as `treeCreateMd`. `name` is
   *  sanitised to lowercase-hyphen. Idempotent: a no-op if the directory
   *  already exists, but always returns its absolute path.
   *  When `root === 'skills'`, `skillTab` selects which tab's directory is
   *  the target (generic / claude / kimi). Kimi rejects with an error. */
  treeMkdir(root: TreeRoot, dirRelPath: string, name: string, skillTab?: SkillTab): Promise<string>;
  /** Pop an OS file picker, then copy the chosen file into the target tree
   *  directory. Resolves to the destination's absolute path, or `null` when
   *  the user cancels. Refuses to overwrite an existing file.
   *  When `root === 'skills'`, `skillTab` selects which tab's directory is
   *  the target (generic / claude / kimi). Kimi rejects with an error. */
  treeImportFile(root: TreeRoot, dirRelPath: string, skillTab?: SkillTab): Promise<string | null>;
  /** Trigger app quit. Renderer is responsible for any user confirmation. */
  quitApp(): Promise<void>;
  /** App version + bundled release metadata used by the About modal.
   *  `platform` is the Node platform string (`linux`/`darwin`/`win32`) used
   *  by the renderer to pick OS-appropriate placeholders. */
  getAppInfo(): Promise<{
    name: string;
    version: string;
    electron: string;
    chrome: string;
    node: string;
    platform: Platform;
  }>;
  /** Build a `file://` URL for a local path (handles Windows drive letters
   *  and percent-encoding). Returns the URL plus the basename so the
   *  renderer can render it without doing its own POSIX-only path split. */
  pdfToFileUrl(path: string): Promise<{ url: string; filename: string }>;
  /**
   * Subscribe to commands sent by the application menu (File → Search,
   * File → Open conception directory, File → Quit). Returns an unsubscribe.
   */
  onMenuCommand(callback: (command: MenuCommand) => void): () => void;
  /** File → Open Recent → <path> click. Returns an unsubscribe. */
  onMenuOpenRecent(callback: (path: string) => void): () => void;
  /** File → Open Recent → Clear menu click. Returns an unsubscribe. */
  onMenuClearRecents(callback: () => void): () => void;
}

export type MenuCommand =
  | 'search'
  | 'open-folder'
  | 'open-conception'
  | 'open-settings'
  | 'new-project'
  | 'request-quit'
  | 'toggle-projects'
  | 'toggle-terminal'
  | 'show-code'
  | 'show-knowledge'
  | 'show-resources'
  | 'show-skills'
  | 'show-logs'
  | 'show-agents'
  | 'hide-working'
  | 'refresh'
  | 'about'
  | 'help-welcome'
  | 'help-quick-start'
  | 'help-shortcuts'
  | 'help-configuration'
  | 'help-cli'
  | 'help-why-markdown';

declare global {
  interface Window {
    condash: CondashApi;
  }
}
