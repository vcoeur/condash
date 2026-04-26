import type {
  KnowledgeNode,
  OpenWithSlotKey,
  OpenWithSlots,
  Project,
  RepoEntry,
  SearchHit,
  StepMarker,
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
  setStatus(path: string, newStatus: string): Promise<void>;
  readNote(path: string): Promise<string>;
  writeNote(path: string, expectedContent: string, newContent: string): Promise<void>;
  /**
   * Subscribe to per-path tree events emitted by the main-process file watcher.
   * Each callback receives a debounced batch. Returns an unsubscribe function.
   */
  onTreeEvents(callback: (events: TreeEvent[]) => void): () => void;
}

declare global {
  interface Window {
    condash: CondashApi;
  }
}
