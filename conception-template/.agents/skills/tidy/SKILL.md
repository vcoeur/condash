---
name: tidy
description: Audit the conception tree (knowledge index orphans + dangling links, cross-repo refs, branch ↔ worktree drift, LFS coverage, large binaries, stale verification stamps), batch the auto-fixable issues into a single confirm-then-apply round, and surface the rest as a punch-list. Wraps `condash audit --include all --json` and `condash knowledge verify --json`.
---

# /tidy — audit + batched fix the conception tree

`/tidy` runs every condash audit + the knowledge verification stamp check, groups the results, applies auto-fixable items in one batch after the user confirms once, and reports the rest as manual work to do later.

## When to use

- Periodically — once a week, or before opening a release-shaped PR off `main`.
- After a bulk refactor of `knowledge/` or `projects/` — orphans and dangling index links pile up.
- After a worktree-heavy week — branches that were merged or removed often leave stale items declaring `branch` with no on-disk worktree.
- When the dashboard's audit indicator shows issues.

For an at-a-glance read without the triage walk, `condash audit` and `condash knowledge verify` directly are faster.

## Trigger

```
/tidy [check=<list>] [dry-run]
```

| Arg                 | Meaning                                                                                       |
|---------------------|-----------------------------------------------------------------------------------------------|
| `check=<list>`      | Comma-separated subset of `lfs,binaries,cross-repo,worktrees,index,knowledge-recheck,stale_verification`. Default: all. |
| `dry-run`           | Print the proposed fixes but do not apply, even after confirmation.                           |

## Procedure

### 1. Collect issues

Run both probes and concatenate their `issues[]` arrays:

```bash
condash audit --include all --json
condash knowledge verify --json
```

If the user passed `check=...`:

- For values in `lfs,binaries,cross-repo,worktrees,index,knowledge-recheck`: forward as `--include <list>` to `audit` (drop `stale_verification` from the list).
- If the list contains `stale_verification`: still call `verify`. Otherwise skip it.

The two responses share the same per-issue shape:

```json
{
  "check": "<name>",
  "severity": "error | warn | info",
  "file": "<path or null>",
  "line": "<number or null>",
  "message": "<human-readable>",
  "fix": { "action": "<symbolic>", "autoFix": true | false, "...payload": "..." }
}
```

`fix.autoFix` is the source of truth for whether the skill can mechanically apply the fix. Do not derive it from the check name.

### 2. Group + partition

- Group `issues[]` by `fix.action`.
- Partition each group by `fix.autoFix`.
- For `cross-repo` only, do the rename hunt described in step 3 *before* classifying as punch-list.

### 3. Cross-repo special case (rename hunt)

For each issue with `fix.action === 'flag_for_user_edit'`:

1. Take the dangling reference's basename and the parent directory's last segment.
2. Search the conception tree for a markdown file with a similar name (Levenshtein within 3, or same basename in a different parent path).
3. If exactly one candidate exists, propose a *redirect*: rewrite the dangling link to point at the candidate.
4. If zero or several candidates exist, leave the issue in the punch-list — the user has to decide.

Promote redirect proposals from punch-list to auto-fix list (their effective `autoFix` becomes `true` once a single-candidate redirect is found).

### 4. Single confirmation round

Build one `AskUserQuestion` listing every proposed auto-fix grouped by check. Example shape:

```
Found 7 fixable issues across 4 checks:

  lfs (2)
    + git lfs track projects/2026-04/.../diagram.png  (122 kB)
    + git lfs track projects/2026-04/.../slides.pdf   (310 kB)
  worktrees (1)
    + condash worktrees setup retire-feature-x
  index (3)
    + remove dangling line in knowledge/topics/index.md:14
    + remove dangling line in knowledge/internal/index.md:8
    + condash knowledge index  (orphan body files)
  cross-repo (1)
    + redirect ../conception/projects/2026-03/old-slug → ../conception/projects/2026-03/new-slug

Apply all? (y / n / pick)
```

Decisions:

- **y** — apply every line.
- **n** — skip every line; jump to the punch-list and final report.
- **pick** — present the same list as a multi-select; only checked items get applied.

The single-round rule is non-negotiable. Never per-issue ping-pong; always one `AskUserQuestion`.

### 5. Apply

For each confirmed auto-fix:

| `fix.action`              | How to apply                                                                                  |
|---------------------------|-----------------------------------------------------------------------------------------------|
| `lfs_track_path`          | `git lfs track <fix.path>` from the conception root, then `git add .gitattributes`. Tell the user to commit + push so the migration is durable. |
| `offer_worktree_setup`    | `condash worktrees setup <fix.branch> --json`.                                            |
| `remove_index_line`       | `Edit` the index.md file: delete the matching `[label](path)` line whose `path` equals `fix.path` and whose `label` equals `fix.label`. |
| `run_knowledge_index`     | `condash knowledge index --json` once at the end of the batch (deduplicate; running it once covers every per-orphan instance). |
| (rename redirect)         | `Edit` the dangling-reference file: replace the old path with the candidate path. The candidate file lives in the conception tree; both relative and same-branch absolute references resolve through `path.resolve` against `dirname(<file>)`. |

After every batch, re-run the matching probe with `--json` to confirm the issue is gone — then collapse the result into the final report.

### 6. Punch-list

Surface every issue with `fix.autoFix === false` as a numbered list, grouped by check. Per-check guidance:

- `binaries` — "consider migrating to LFS or removing". Decision is per-file: large fixtures legitimately stay; cached PDFs should usually go.
- `cross-repo` (after the rename hunt found nothing) — print the file + line and the dangling reference. The user has to decide whether to update the link or drop the source paragraph.
- `knowledge-recheck` — print the project + the `opened` date + the deferred fact from the message. A finding was parked (durable + cross-cutting, but its truth waited on a PR) and never re-tested. If that PR has merged, re-run the three-question durability test now: promote via `/knowledge update` then append a `[knowledge-recheck:done]` timeline marker, or drop with a `done` marker noting why. Never auto-promote — condition 3 needs human judgement, which is why `autoFix` is `false`.
- `stale_verification` — print the path:line, the date, and the `**Verified:**` `where` field. Ask the user to either *re-confirm* (re-read the source, then `condash knowledge stamp <path>` to bump the date) or *update the surrounding text*. Never bump the date on the user's behalf — that lies about freshness.
- `install_git_lfs` (info from `lfs` check) — only emitted when `git-lfs` is missing on the host. One-line "install git-lfs to enable this check".
- `create_knowledge_dir` — only emitted when `knowledge/` is missing. Could be intentional (early-stage conception). Surface and move on.
- `unknown_check` / `investigate_crash` — bugs in condash itself; report the message verbatim and stop.

### 7. Final report

```
=== /tidy report ===
Tree:           <conception root>
Issues found:   <total>
By severity:    error=N, warn=N, info=N
Fixed:          <count> (across <K> checks)
  lfs:          tracked <N> file(s) → commit & push to publish
  worktrees:    set up <N> worktree(s)
  index:        cleaned <N> dangling line(s); regenerated <N> index.md
  cross-repo:   redirected <N> reference(s)
Deferred (punch-list, <count>):
  binaries:     <N>
  cross-repo:   <N>
  stale_verification: <N>
Re-run /tidy after committing the auto-fix changes.
```

If `dry-run` was passed: every "Fixed" line becomes "Would fix", and skip the re-run line.

## Rules

- **Never auto-bump `**Verified:**` stamps.** A stale stamp means "human must reread the source"; bumping the date silently is a freshness lie. The skill always emits stale stamps as punch-list items.
- **Never auto-delete cross-repo references.** Always look for a likely-renamed file first (step 3); only the user can choose to drop a reference outright.
- **`git lfs track` is reversible but changes history.** The single-confirmation round is the user's chance to opt out — do not skip it even on a bare `y`-then-go session.
- **One `AskUserQuestion` per `/tidy` run.** Step 4 is the *only* prompt; step 6 (the punch-list) is informational, never a question.
- **Re-run, don't loop.** After applying fixes, tell the user to commit and re-run `/tidy` rather than iterating in the same session — fresh probe runs against committed state are the source of truth, not stale in-memory deltas.
- **`dry-run` skips writes everywhere**, including the `Edit` calls for `remove_index_line` and the rename-redirect step.

## Why this skill exists

The CLI alone covers every check (`audit --include all`, `knowledge verify`). What it can't do alone is the editorial layer: investigate dangling cross-repo refs for likely renames, batch every safe fix into one confirmation, and produce a single human-readable end-of-run report. That layer was previously per-conception code (`tidy.py` + a per-conception `SKILL.md`) — same logic copy-pasted across trees. Owning it in condash means fixes ship once and version with the audit they triage.

Out of scope (intentionally):

- The `memory_index` check from older per-conception versions — some conceptions ban the auto-memory feature it audits, so it is not universal. Re-add as an opt-in audit if a future conception needs it.
- Folding `audit` and `knowledge verify` into one verb — they audit semantically distinct concerns (structural drift vs. content freshness). Two probes, one skill.
