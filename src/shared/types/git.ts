// Git / worktree status: the dirty-file rows, upstream tracking, the
// click-to-inspect popover payload, and the per-repo / per-worktree entries
// the Code pane renders.

/** One row of `git status --porcelain=v1` output, joined with the
 *  matching `git diff --numstat HEAD` row when present. */
export interface DirtyFile {
  /** Two-character porcelain status (e.g. ` M`, `??`, `D `). Whitespace
   * preserved so the renderer can render the column verbatim. */
  code: string;
  /** Path relative to the worktree root. Rename arrows are collapsed to the
   * new path (rename targets are usually the more interesting filename). */
  path: string;
  /** Lines added per `git diff --numstat HEAD`. Null when the file is
   *  untracked, binary, or numstat had no row for it (fresh repo, etc.). */
  added: number | null;
  /** Lines deleted. Same null semantics as `added`. */
  deleted: number | null;
  /** True when numstat reports the path as binary (`- - <path>`). */
  binary: boolean;
}

/** One unpushed commit on the local branch (i.e. on `HEAD` but not yet on
 *  the upstream tracking ref). Surfaced in the dirty popover so the user
 *  sees what's queued for the next push, not just the count. */
export interface UnpushedCommit {
  /** Short SHA (`%h`). */
  sha: string;
  /** Subject line (`%s`). */
  subject: string;
}

/** Upstream tracking summary for one worktree. The badge needs only `ahead`
 *  + the existence of an upstream; `upstreamRef` is shown in the popover so
 *  the user knows which remote/branch they're being told about. */
export interface UpstreamStatus {
  /** Tracking ref shorthand, e.g. `origin/main`. Null only when the lookup
   *  ran but git returned an unexpected shape — `hasUpstream:false` cases
   *  return a top-level null instead of this struct. */
  upstreamRef: string | null;
  /** Commits on local but not on upstream (i.e. unpushed). */
  ahead: number;
}

/** Outcome of a per-branch `git pull --ff-only` (the Code-pane "Pull branch"
 *  action). The renderer toasts `message`; `status` picks the toast tone.
 *  - `updated`: the worktree fast-forwarded to new upstream commits.
 *  - `up-to-date`: already in sync — nothing to apply.
 *  - `diverged`: local and upstream both advanced, so a fast-forward isn't
 *    possible; condash can't resolve it, so it's reported, not swallowed.
 *  - `dirty`: refused because the worktree has uncommitted changes. */
export interface PullBranchResult {
  status: 'updated' | 'up-to-date' | 'diverged' | 'dirty';
  /** Human-readable one-line summary for the toast. */
  message: string;
}

/** Click-to-inspect payload for the per-branch dirty badge. One row per
 *  dirty file (capped at a fixed file limit) with totals for the footer.
 *  Also carries unpushed-commit context so the popover can list them in a
 *  separate section without a second round-trip. */
export interface DirtyDetails {
  files: DirtyFile[];
  /** Aggregate `+` count across the returned files. Untracked / binary
   *  files contribute 0. */
  totalAdded: number;
  /** Aggregate `-` count across the returned files. */
  totalDeleted: number;
  /** True when the file list was truncated to fit the fixed limit. */
  truncated: boolean;
  /** Total number of dirty files before truncation. */
  totalCount: number;
  /** Upstream summary (null when the branch has no tracking ref). */
  upstream: UpstreamStatus | null;
  /** Unpushed commits (newest first, capped at a fixed limit). Empty when
   *  there's no upstream or the branch is in sync. */
  unpushedCommits: UnpushedCommit[];
  /** True when the unpushed-commit list was truncated to fit the cap. */
  unpushedTruncated: boolean;
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
  /** Upstream tracking summary; null when the branch has no upstream
   *  (fresh local branch, detached HEAD, etc.). Drives the per-branch
   *  upstream badge alongside `dirty`. */
  upstream?: UpstreamStatus | null;
}

export interface RepoEntry {
  /** Display name (typically the repo directory name; submodules use `parent/child`). */
  name: string;
  /** Canonical `#handle` (no leading `#`) — the app's one public identity.
   * The Code-pane pill renders `#{handle}`; the colour hashes it. Explicit
   * `handle:` in condash.json, else derived from the directory name. */
  handle: string;
  /** Optional human-friendly label from `condash.json`. Rendered as a
   * small subtitle on the card when present — useful when the directory name
   * is a slug and a friendlier descriptor is wanted alongside it. */
  label?: string;
  /** Absolute path on disk. */
  path: string;
  /** When set, this entry is a submodule of the named parent repo. */
  parent?: string;
  /** Count of modified+staged+untracked files; null if git status couldn't run. */
  dirty: number | null;
  /** True when path doesn't exist or isn't a git repo. */
  missing: boolean;
  /** True when the path exists and is a git repository. False or omitted
   *  for plain directories that are not under git. */
  isGit?: boolean;
  /** True when condash.json sets a `force_stop:` for this entry. */
  hasForceStop?: boolean;
  /** True when condash.json sets a `run:` for this entry. The renderer
   * uses this to decide whether to render the per-branch run button — REPO
   * cards without a configured run target should not surface it. */
  hasRun?: boolean;
  /** Worktrees attached to this repo (always includes the primary checkout). */
  worktrees?: Worktree[];
  /** Name of the most-recent `{ section: … }` marker that preceded this
   *  entry in `repositories[]`. Undefined for entries before the first
   *  marker (the implicit default bucket). Submodules inherit their parent's
   *  section. Drives Code-pane card grouping. */
  section?: string;
}

/** Repo-tree event broadcast by the per-repo FS watcher (worktree + .git/
 *  meta) so the renderer can patch one repo (or one worktree) in place
 *  without re-fetching the whole repo list. `path` matches a `RepoEntry.path`
 *  or one of its `worktrees[].path`.
 *
 *  - `repo-dirty`: dirty-file count changed (or recomputed); null when git
 *    couldn't run.
 *  - `repo-upstream`: upstream tracking summary changed (push, fetch, local
 *    commit, branch switch); null when the branch has no upstream.
 *  - `repo-worktrees-changed`: structural change for a primary repo — a
 *    worktree was added/removed, or the primary checkout itself switched
 *    branches. The renderer responds by reloading just this primary
 *    (and its submodule children) rather than the whole repo list.
 *    `repoPath` is the primary's `RepoEntry.path`. */
export type RepoEvent =
  | { kind: 'repo-dirty'; path: string; dirty: number | null }
  | { kind: 'repo-upstream'; path: string; upstream: UpstreamStatus | null }
  | { kind: 'repo-worktrees-changed'; repoPath: string };
