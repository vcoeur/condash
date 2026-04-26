import type { KnowledgeNode, Project, SearchHit, StepMarker, Theme } from './types';

export interface CondashApi {
  listProjects(): Promise<Project[]>;
  readKnowledgeTree(): Promise<KnowledgeNode | null>;
  search(query: string): Promise<SearchHit[]>;
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
   * Subscribe to tree-changed events emitted by the main-process file watcher.
   * Returns an unsubscribe function.
   */
  onTreeChanged(callback: () => void): () => void;
}

declare global {
  interface Window {
    condash: CondashApi;
  }
}
