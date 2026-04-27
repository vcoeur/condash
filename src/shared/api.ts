import type {
  KnowledgeNode,
  OpenWithSlotKey,
  OpenWithSlots,
  Project,
  ProjectFileEntry,
  RepoEntry,
  SearchHit,
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
  search(query: string): Promise<SearchHit[]>;
  listRepos(): Promise<RepoEntry[]>;
  listOpenWith(): Promise<OpenWithSlots>;
  launchOpenWith(slot: OpenWithSlotKey, path: string): Promise<void>;
  forceStopRepo(repoName: string): Promise<void>;
  openInEditor(path: string): Promise<void>;
  pickConceptionPath(): Promise<string | null>;
  getConceptionPath(): Promise<string | null>;
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
  onTermData(callback: (msg: TermDataMessage) => void): () => void;
  onTermExit(callback: (msg: TermExitMessage) => void): () => void;
  /** Sessions changed (spawn / exit / close). Receives the full snapshot. */
  onTermSessions(callback: (sessions: TermSession[]) => void): () => void;
}

declare global {
  interface Window {
    condash: CondashApi;
  }
}
