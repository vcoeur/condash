// Tree panes: the root discriminator, FS-watch events, the Knowledge /
// Resources / Skills node shapes (plus the resource category + skill
// shipped-stamp helpers), and the conception-init probe result.

/** Discriminator for the three tree panes. Used by the `tree.*` IPC verbs
 * to pick the correct on-disk root (knowledge is hardcoded to `knowledge/`;
 * resources and skills come from `condash.json`). */
export type TreeRoot = 'knowledge' | 'resources' | 'skills';

export type TreeEvent =
  | { kind: 'project'; op: 'add' | 'change' | 'unlink'; path: string }
  | { kind: 'knowledge'; op: 'add' | 'change' | 'unlink'; path: string }
  | { kind: 'resources'; op: 'add' | 'change' | 'unlink'; path: string }
  | { kind: 'skills'; op: 'add' | 'change' | 'unlink'; path: string }
  | { kind: 'logs'; op: 'add' | 'change' | 'unlink'; path: string }
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
  /** First non-heading paragraph, trimmed to ~240 chars. Files only. */
  summary?: string;
  /** ISO date (YYYY-MM-DD) extracted from a `**Verified:**` line, when present. Files only. */
  verifiedAt?: string;
}

/**
 * Coarse file category used by the Resources pane to pick the right icon
 * and action set without re-reading the file. Computed from the extension
 * during the tree walk; binaries fall through to `binary`, anything not
 * matched by the table lands in `other`.
 */
export type ResourceCategory =
  | 'markdown'
  | 'pdf'
  | 'html'
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'archive'
  | 'binary'
  | 'other';

/**
 * Tree node for the Resources pane. Same shape as `KnowledgeNode` but every
 * file is surfaced (not just `.md`), and each file carries its mime hint
 * plus the coarse `category` used by the renderer's icon picker.
 */
export interface ResourceNode {
  /** Path relative to <conception>/resources/. Empty string for the root. */
  relPath: string;
  /** Absolute path on disk. */
  path: string;
  /** Last segment of relPath, or 'resources' for the root. */
  name: string;
  /** Title from the .md (first h1) when this is a markdown file; the directory or basename otherwise. */
  title: string;
  /** Directory or file. */
  kind: 'directory' | 'file';
  /** Children (only for directories). Sorted: directories first, then files, both alphabetical. */
  children?: ResourceNode[];
  /** First non-heading paragraph, trimmed to ~240 chars. Markdown files only. */
  summary?: string;
  /** Coarse category (drives icon + action set). Files only. */
  category?: ResourceCategory;
  /** Best-effort mime type (e.g. "text/markdown", "image/png"). Files only. */
  mime?: string;
  /** Size in bytes. Files only. */
  size?: number;
}

/**
 * Tracked-shipping metadata for a skill file. Populated only when the file
 * appears in `<conception>/.agents/.condash-skills.json`. Used by the renderer to
 * surface a "shipped" chip and a "diverged from shipped" banner when local
 * edits would be flagged on the next `condash skills install`.
 */
export interface SkillShippedInfo {
  /** SHA-256 from the manifest (the hash of the version condash shipped). */
  manifestSha: string;
  /** SHA-256 of the file currently on disk. */
  diskSha: string;
  /** True when the two hashes differ. */
  diverged: boolean;
  /** Condash version that shipped this file, when recorded in the manifest. */
  shippedVersion?: string;
}

/**
 * Tree node for the Skills pane. Same shape as `KnowledgeNode` plus the
 * optional `shipped` stamp on `SKILL.md` and shipped body files.
 */
export interface SkillNode {
  /** Path relative to the scope's skills root (`<conception>/.agents/skills/`
   *  for conception scope, `~/.config/agents/skills/` for user scope). Empty string
   *  for the root. */
  relPath: string;
  /** Absolute path on disk. */
  path: string;
  /** Last segment of relPath, or 'skills' for the root. */
  name: string;
  /** Title from the .md (first h1) when this is a file; the directory name otherwise. */
  title: string;
  /** Directory or file. Files end with .md; everything else is skipped. */
  kind: 'directory' | 'file';
  /** Children (only for directories). */
  children?: SkillNode[];
  /** First non-heading paragraph, trimmed to ~240 chars. Files only. */
  summary?: string;
  /** Shipped-file tracking, when the manifest covers this file. Files only. */
  shipped?: SkillShippedInfo;
  /** Set on the synthetic AGENTS.md entry pinned at the top of the tree.
   *  Carries the short uppercase badge the renderer shows ('AGENTS'); its
   *  presence is also how the renderer tells the read-only callout apart
   *  from real skill files. Absent on every on-disk skill node. */
  badge?: string;
}

/**
 * Result of probing a candidate conception path. The renderer uses this to
 * decide whether to surface the bundled-template init prompt after the user
 * picks a folder.
 */
export interface ConceptionInitState {
  pathExists: boolean;
  hasProjects: boolean;
  hasConfiguration: boolean;
  /** Both projects/ and condash.json (or legacy configuration.json) present. */
  looksInitialised: boolean;
}
