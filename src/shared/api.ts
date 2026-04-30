import type {
  ConceptionInitState,
  DirtyDetails,
  KnowledgeNode,
  OpenWithSlotKey,
  OpenWithSlots,
  Project,
  ProjectFileEntry,
  RepoEntry,
  SearchResults,
  StepMarker,
  TermDataMessage,
  TermExitMessage,
  TermSession,
  TermSpawnRequest,
  TerminalPrefs,
  Theme,
  TreeEvent,
} from './types';

export interface CondashApi {
  listProjects(): Promise<Project[]>;
  getProject(path: string): Promise<Project | null>;
  readKnowledgeTree(): Promise<KnowledgeNode | null>;
  search(query: string): Promise<SearchResults>;
  listRepos(): Promise<RepoEntry[]>;
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
  /** Probe a candidate workspace path: does it have projects/ and configuration.json? */
  detectConceptionState(path: string): Promise<ConceptionInitState>;
  /** Lay the bundled conception-template/ tree into `path`. Existing files preserved. */
  initConception(path: string): Promise<{ created: string[] }>;
  getTheme(): Promise<Theme>;
  setTheme(theme: Theme): Promise<void>;
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
  setStatus(path: string, newStatus: string): Promise<void>;
  readNote(path: string): Promise<string>;
  writeNote(path: string, expectedContent: string, newContent: string): Promise<void>;
  /**
   * Read one of the bundled help docs (`docs/<name>.md`). The main process
   * whitelists the four shipped names; anything else rejects.
   */
  helpReadDoc(name: 'architecture' | 'configuration' | 'non-goals' | 'index'): Promise<string>;
  /**
   * Subscribe to per-path tree events emitted by the main-process file watcher.
   * Each callback receives a debounced batch. Returns an unsubscribe function.
   */
  onTreeEvents(callback: (events: TreeEvent[]) => void): () => void;

  termSpawn(request: TermSpawnRequest): Promise<{ id: string; cwd: string }>;
  termWrite(id: string, data: string): Promise<void>;
  termResize(id: string, cols: number, rows: number): Promise<void>;
  termClose(id: string): Promise<void>;
  termGetPrefs(): Promise<TerminalPrefs>;
  termLatestScreenshot(dir: string): Promise<string | null>;
  /** Snapshot of currently-tracked sessions (live or recently exited). */
  termList(): Promise<TermSession[]>;
  /** Pull the buffered output for an existing session, used on renderer
   * mount to replay history into a freshly-created xterm. */
  termAttach(id: string): Promise<{ output: string; exited?: number } | null>;
  /** Re-side a session — used by the Code-tab pop-out button to surface a
   * running dev server in the bottom "My terms" pane. */
  termSetSide(id: string, side: 'my' | 'code'): Promise<void>;
  onTermData(callback: (msg: TermDataMessage) => void): () => void;
  onTermExit(callback: (msg: TermExitMessage) => void): () => void;
  /** Sessions changed (spawn / exit / close). Receives the full snapshot. */
  onTermSessions(callback: (sessions: TermSession[]) => void): () => void;

  /** Open the configured conception directory in the OS file manager. */
  openConceptionDirectory(): Promise<void>;
  /** Open an arbitrary URL or file path with the OS default handler.
   *  Used by the xterm web-links addon and any future external-link UI. */
  openExternal(target: string): Promise<void>;
  /** Create a new note file under <projectPath>/notes/. The slug is sanitised
   *  and prefixed with the next zero-padded NN- counter. Returns the absolute
   *  path of the new file (always created — caller can then open it). */
  createProjectNote(projectPath: string, slug: string): Promise<string>;
  /** Trigger app quit. Renderer is responsible for any user confirmation. */
  quitApp(): Promise<void>;
  /** App version + bundled release metadata used by the About modal. */
  getAppInfo(): Promise<{
    name: string;
    version: string;
    electron: string;
    chrome: string;
    node: string;
  }>;
  /**
   * Subscribe to commands sent by the application menu (File → Search,
   * File → Open conception directory, File → Quit). Returns an unsubscribe.
   */
  onMenuCommand(callback: (command: MenuCommand) => void): () => void;
}

export type MenuCommand =
  | 'search'
  | 'open-folder'
  | 'open-conception'
  | 'open-settings'
  | 'request-quit'
  | 'toggle-terminal'
  | 'refresh'
  | 'about'
  | 'help-architecture'
  | 'help-configuration'
  | 'help-non-goals'
  | 'help-index';

declare global {
  interface Window {
    condash: CondashApi;
  }
}
