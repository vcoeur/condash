import type { Project, Theme } from './types';

export interface CondashApi {
  listProjects(): Promise<Project[]>;
  openInEditor(path: string): Promise<void>;
  pickConceptionPath(): Promise<string | null>;
  getConceptionPath(): Promise<string | null>;
  getTheme(): Promise<Theme>;
  setTheme(theme: Theme): Promise<void>;
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
