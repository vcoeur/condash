import type { Project } from './types';

export interface CondashApi {
  listProjects(): Promise<Project[]>;
  openInEditor(path: string): Promise<void>;
  pickConceptionPath(): Promise<string | null>;
  getConceptionPath(): Promise<string | null>;
}

declare global {
  interface Window {
    condash: CondashApi;
  }
}
