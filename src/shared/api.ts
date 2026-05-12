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
  StepMarker,
  TermDataMessage,
  TermExitMessage,
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
  /** Tree under <conception>/<skills_path> — `.md` files only, with
   * shipped-SHA stamps populated from `.condash-skills.json` when present.
   * Resolves to null when the directory is missing. */
  readSkillsTree(): Promise<SkillNode | null>;
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
  helpReadDoc(name: HelpDocName): Promise<string>;
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

  termSpawn(request: TermSpawnRequest): Promise<{ id: string; cwd: string }>;
  termWrite(id: string, data: string): Promise<void>;
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
   *  can re-fetch the tree and open the file in the editor. */
  treeCreateMd(root: TreeRoot, dirRelPath: string, filename: string): Promise<string>;
  /** Create a new subdirectory under one of the three tree panes'
   *  directories. Same `dirRelPath` semantics as `treeCreateMd`. `name` is
   *  sanitised to lowercase-hyphen. Idempotent: a no-op if the directory
   *  already exists, but always returns its absolute path. */
  treeMkdir(root: TreeRoot, dirRelPath: string, name: string): Promise<string>;
  /** Pop an OS file picker, then copy the chosen file into the target tree
   *  directory. Resolves to the destination's absolute path, or `null` when
   *  the user cancels. Refuses to overwrite an existing file. */
  treeImportFile(root: TreeRoot, dirRelPath: string): Promise<string | null>;
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
