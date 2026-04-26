export type ItemKind = 'project' | 'incident' | 'document' | 'unknown';

export type KnownStatus = 'now' | 'soon' | 'later' | 'backlog' | 'review' | 'done';

export const KNOWN_STATUSES: readonly KnownStatus[] = [
  'now',
  'soon',
  'later',
  'backlog',
  'review',
  'done',
];

export interface StepCounts {
  todo: number;
  doing: number;
  done: number;
  dropped: number;
}

export type StepMarker = ' ' | '~' | 'x' | '-';

export const STEP_MARKERS: readonly StepMarker[] = [' ', '~', 'x', '-'];

export interface Step {
  lineIndex: number;
  marker: StepMarker;
  text: string;
  section: string;
}

export interface Deliverable {
  /** Label as written between the [ ] of `- [label](path) — desc`. */
  label: string;
  /** Resolved absolute path on disk. */
  path: string;
  /** Optional trailing description after ' — '. */
  description?: string;
}

export interface Project {
  slug: string;
  path: string;
  title: string;
  kind: ItemKind;
  status: KnownStatus | string;
  apps?: string;
  summary?: string;
  steps: Step[];
  stepCounts: StepCounts;
  deliverables: Deliverable[];
  deliverableCount: number;
}

export type Theme = 'light' | 'dark' | 'system';

export interface Settings {
  conceptionPath: string | null;
  theme: Theme;
}

export interface RepoEntry {
  /** Display name (typically the repo directory name). */
  name: string;
  /** Absolute path on disk. */
  path: string;
  /** primary | secondary — matches the configuration.json layout. */
  kind: 'primary' | 'secondary';
  /** Count of modified+staged+untracked files; null if git status couldn't run. */
  dirty: number | null;
  /** True when path doesn't exist or isn't a git repo. */
  missing: boolean;
}

export interface SearchHit {
  /** Absolute path of the matched file. */
  path: string;
  /** Best-effort title (first H1 line) for display. */
  title: string;
  /** 'project' if the file is a projects/.../README.md, 'knowledge' otherwise. */
  source: 'project' | 'knowledge';
  /** Number of matches in the file. */
  matchCount: number;
  /** First few snippets, each ~120 chars centred on the first line of each match. */
  snippets: string[];
}

export interface KnowledgeNode {
  /** Path relative to <conception>/knowledge/. Empty string for the root. */
  relPath: string;
  /** Absolute path on disk. */
  path: string;
  /** Last segment of relPath, or 'knowledge' for the root. */
  name: string;
  /** Title from the .md (first h1) when this is a file; the directory name otherwise. */
  title: string;
  /** Directory or file. Files end with .md; everything else is skipped. */
  kind: 'directory' | 'file';
  /** Children (only for directories). Sorted: directories first, then files, both alphabetical. */
  children?: KnowledgeNode[];
}
