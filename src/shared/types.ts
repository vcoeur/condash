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

export interface ProjectFileEntry {
  /** Absolute path on disk. */
  path: string;
  /** Path relative to the project directory (e.g. "README.md", "notes/01-foo.md"). */
  relPath: string;
  /** Last segment of relPath. */
  name: string;
}

export type Theme = 'light' | 'dark' | 'system';

export interface Settings {
  conceptionPath: string | null;
  theme: Theme;
}

export interface Worktree {
  /** Absolute path on disk. */
  path: string;
  /** Branch name (without the `refs/heads/` prefix); null when detached. */
  branch: string | null;
  /** True when this worktree is the primary checkout (the one in `repositories`). */
  primary: boolean;
  /** Count of modified + staged + untracked files in this worktree; null
   * when git status couldn't run for any reason. */
  dirty?: number | null;
}

export interface RepoEntry {
  /** Display name (typically the repo directory name; submodules use `parent/child`). */
  name: string;
  /** Absolute path on disk. */
  path: string;
  /** primary | secondary — matches the configuration.json layout. */
  kind: 'primary' | 'secondary';
  /** When set, this entry is a submodule of the named parent repo. */
  parent?: string;
  /** Count of modified+staged+untracked files; null if git status couldn't run. */
  dirty: number | null;
  /** True when path doesn't exist or isn't a git repo. */
  missing: boolean;
  /** True when configuration.json sets a `force_stop:` for this entry. */
  hasForceStop?: boolean;
  /** Worktrees attached to this repo (always includes the primary checkout). */
  worktrees?: Worktree[];
}

export type TermSide = 'my' | 'code';

export interface TerminalPrefs {
  shell?: string;
  shortcut?: string;
  screenshot_dir?: string;
  screenshot_paste_shortcut?: string;
  launcher_command?: string;
  move_tab_left_shortcut?: string;
  move_tab_right_shortcut?: string;
}

/** Snapshot of a live (or recently-exited) terminal session, broadcast on
 * spawn/exit/close so renderers can keep their tab strip and Code-tab LIVE
 * badges in sync without polling. */
export interface TermSession {
  id: string;
  side: TermSide;
  /** When the session was launched via the Run button on a repo, the repo
   * display name (e.g. `condash`, `PaintingManager/app`). */
  repo?: string;
  /** Process exit code if the pty has terminated; undefined while live. */
  exited?: number;
}

export interface TermSpawnRequest {
  side: TermSide;
  /** When set, looks up the repo's `run:` and uses its cwd. */
  repo?: string;
  /** Free-form command to run via `bash -lc`. Mutually exclusive with `repo`. */
  command?: string;
  /** Override the cwd; defaults to $HOME (or the resolved repo cwd). */
  cwd?: string;
  cols?: number;
  rows?: number;
}

export interface TermDataMessage {
  id: string;
  data: string;
}

export interface TermExitMessage {
  id: string;
  code: number;
}

export type OpenWithSlotKey = 'main_ide' | 'secondary_ide' | 'terminal';

export interface OpenWithSlot {
  label: string;
  command: string;
}

export type OpenWithSlots = Partial<Record<OpenWithSlotKey, OpenWithSlot>>;

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

export type TreeEvent =
  | { kind: 'project'; op: 'add' | 'change' | 'unlink'; path: string }
  | { kind: 'knowledge'; op: 'add' | 'change' | 'unlink'; path: string }
  | { kind: 'config'; path: string }
  | { kind: 'unknown' };

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
