// Project lifecycle: statuses, steps, deliverables, timeline, the parsed
// `Project` aggregate, and the create / transition IPC payloads.

import type { ItemKind } from './common';

export type KnownStatus = 'now' | 'review' | 'later' | 'backlog' | 'done';

export const KNOWN_STATUSES: readonly KnownStatus[] = ['now', 'review', 'later', 'backlog', 'done'];

export interface StepCounts {
  todo: number;
  doing: number;
  done: number;
  blocked: number;
  dropped: number;
}

export type StepMarker = ' ' | '~' | 'x' | '!' | '-';

export const STEP_MARKERS: readonly StepMarker[] = [' ', '~', 'x', '!', '-'];

export interface Step {
  lineIndex: number;
  marker: StepMarker;
  text: string;
  section: string;
}

/** What a deliverable link points at — drives how it opens:
 *  - `file`: a local artifact (resolved absolute posix path) → in-app viewer / OS default.
 *  - `url`: an external `http(s)` link → opens in the browser.
 *  - `wikilink`: an internal `[[slug]]` reference → navigates within condash. */
export type DeliverableKind = 'file' | 'url' | 'wikilink';

export interface Deliverable {
  /** Display label. For `[label](target)` it's the bracket text; for a
   *  `[[slug|label]]` wikilink it's the label (or the slug when no `|`). */
  label: string;
  /** The link target, interpreted per `kind`: a resolved absolute (posix)
   *  path for `file`, the verbatim URL for `url`, the raw slug for `wikilink`. */
  path: string;
  /** Whether the target is a local file, an external URL, or a wikilink. */
  kind: DeliverableKind;
  /** Optional trailing comment after ' — ' (or '-' / ':'), shown in the view. */
  description?: string;
}

/** Single `## Timeline` entry parsed from a project README. The
 * `<date> — <text>` shape is canonical; lines that don't match it are
 * skipped at parse time. */
export interface TimelineEntry {
  date: string;
  text: string;
}

export interface Project {
  slug: string;
  path: string;
  title: string;
  kind: ItemKind;
  status: KnownStatus | string;
  /** Apps backticked on the **Apps** header line, parsed into the bare slugs
   * (e.g. `[\`alicepeintures\`]` → `['alicepeintures']`). Empty when the line
   * is missing or has no backticks — never `undefined`, so call sites can
   * iterate without an existence guard. */
  apps: string[];
  /** Auth value from `**Branch**: \`<name>\` …`. The first backticked token
   * is authoritative per `projects/SKILL.md` — trailing prose is ignored.
   * Null when the header has no `**Branch**` line. Populated alongside
   * `apps` so the renderer can show the branch on the card without a
   * second IPC call. */
  branch: string | null;
  /** Auth value from `**Base**`. Null when the header has no `**Base**` line. */
  base: string | null;
  summary?: string;
  steps: Step[];
  stepCounts: StepCounts;
  deliverables: Deliverable[];
  deliverableCount: number;
  /** ISO date `YYYY-MM-DD` of the most recent `## Timeline` line matching
   * `- <date> — Closed.`. `null` when no such line exists (the project was
   * never closed, or its timeline pre-dates the convention). Populated for
   * every project, not only `status === 'done'`, so a reopened-then-reclosed
   * item retains the date the latest close left behind. */
  closedAt: string | null;
  /** Parsed `## Timeline` entries in source order. Empty when the section
   * is absent. Powers the popup's collapsed-by-default Timeline pane.
   *
   * The `listProjects` projection **empties this array** in the resident
   * renderer list + every IPC clone (it grows unbounded with a project's age —
   * G1): cards read `lastActivity` instead, and the preview lazy-fetches the
   * full project (with `timeline`) via `getProject`. `getProject` and the CLI
   * paths keep it populated. */
  timeline: TimelineEntry[];
  /** Date (`YYYY-MM-DD`) of the most recent `## Timeline` entry, or null when
   * the section is empty — precomputed so the card's last-activity label needn't
   * carry the whole `timeline[]`. `parseReadme` always sets it; only hand-built
   * fixtures omit it (hence optional). */
  lastActivity?: string | null;
}

export interface ProjectFileEntry {
  /** Absolute path on disk. */
  path: string;
  /** Path relative to the project directory (e.g. "README.md", "notes/01-foo.md"). */
  relPath: string;
  /** Last segment of relPath. */
  name: string;
}

/**
 * Result of a status transition (`setStatus` IPC, `condash projects status
 * set` / `close` / `reopen`). `timelineAppended` is non-null only on
 * done-edges (close or reopen) — that's the entire signal the renderer needs
 * to surface a "Closed." / "Reopened." toast and refresh the timeline pane.
 */
export interface TransitionResult {
  previousStatus: string | null;
  newStatus: string;
  timelineAppended: string | null;
  /** Set on close (done-edge) when the project's `**Branch**` has a stale
   * worktree on disk or a local branch left behind. The renderer surfaces
   * this as a toast so the user remembers to run `condash worktrees remove`
   * before forgetting. Undefined for non-close transitions and for closes
   * that didn't touch a branch. */
  branchWarning?: string;
}

/**
 * Input for the GUI's "+ New project" form, mirrored on the CLI as the
 * `condash projects create` flag set. Apps / Branch / Base intentionally
 * omitted from the form: minimal-info create only. The renderer normalises
 * the slug (via `slugify`) before dispatching; the main process re-validates
 * against `^[a-z0-9-]+$`.
 */
export interface ProjectCreateInput {
  title: string;
  slug: string;
  kind: 'project' | 'incident' | 'document';
  status: 'now' | 'review' | 'later' | 'backlog';
  /** Incident-only: PROD / STAGING / DEV. */
  environment?: 'PROD' | 'STAGING' | 'DEV';
  /** Incident-only: low / medium / high. */
  severity?: 'low' | 'medium' | 'high';
  /** Incident-only: free-text impact line. */
  severityImpact?: string;
}

export interface ProjectCreateResult {
  /** Folder name (e.g. `2026-05-02-foo`). */
  slug: string;
  /** Absolute path to the new project directory. */
  path: string;
  /** Path relative to the conception root. */
  relPath: string;
  /** Absolute path to the new README.md. */
  readme: string;
}
