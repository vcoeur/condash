# /projects — close

Mark an item as `done`. Under the flat layout, this is a status change only — no folder move.

Trigger: `/projects close <slug>`.

## Steps

1. **Resolve slug:** `condash projects resolve <slug> --json`.

2. **Read state:** `condash projects read <slug> --with-notes --json`. Use `data.steps`, `data.status`, `data.notes[]` to assess.

3. **Sanity check.** If any step is still `[ ]` or `[~]` and the user hasn't said the item is done despite incomplete steps, ask:

   > "Steps N and M are still open. Close anyway, mark them done, or leave the item in `review` status?"

   **Exception — intentional deferrals.** Treat as silently complete any step whose text carries `(outside this item)`, `(out of scope)`, `(follow-up)`, or `(tracked in <slug>)`.

4. **Knowledge promotion review.** Editorial step — Claude reads, the CLI is a backstop.

   a. **Read the README and every `notes/*.md` body** returned by step 2's `read --with-notes`, and apply the three-question durability test (canonical definition in the `/knowledge` skill) to each candidate paragraph:

      1. Holds beyond this task? (Not specific to the in-flight work.)
      2. Applies to more than one app, or to the ecosystem?
      3. Stays true regardless of this PR's outcome? (Survives both merge and abandonment.)

      Three yes → keep. Any no → drop silently — **except** when the only failing answer is #3 (the finding is durable and cross-cutting, but its truth is *established by* the not-yet-merged PR). That is a **deferred promotion**, handled in sub-step (d), not a drop. Findings often hide outside the heuristic's reach — `## Description`, `## Steps` prose, `## Timeline`, or observation-phrased notes — so don't rely on the backstop alone.

   b. **Run the heuristic backstop:**

      ```bash
      condash projects scan-promotions <slug> --json
      ```

      Grep-walks `notes/*.md` for `always|never|must|convention|rule|pattern|whenever|all (apps|sites|projects)` and returns `data.candidates[]` with `relPath`, `line`, `match`, and the surrounding `paragraph`. Re-apply the three-question test on anything new. Skip paragraphs already carrying a `**Transferred:**` stamp.

   c. **Present surviving candidates** (yours + new) as a numbered list with `<file>:<line>`, the exact paragraph, and the proposed `knowledge/` location (bucket-picking rubric in `knowledge/SKILL.md`). Per row: *"Promote to `knowledge/<path>`? (y / n / edit-first)"*.

   - **y** → `/knowledge update`, then stamp the origin paragraph with `**Transferred:** YYYY-MM-DD → <knowledge-path>`.
   - **edit-first** → refine wording or target, re-present, re-ask.
   - **n** → skip.

   Zero candidates from both reading and scan → say so and move on. Don't synthesise a prompt to fish for one.

    d. **Deferred promotions.** A candidate that fails *only* #3 (durable and cross-cutting, but its truth is established by this not-yet-merged PR) is not a drop — record it exactly as `/projects update` does: append a `[knowledge-recheck:pending]` `## Timeline` marker naming the fact, the blocking PR, and the candidate `knowledge/` path. The `knowledge-recheck` audit (`/knowledge verify`) re-surfaces it after the PR merges — **including in `done` projects**, so deferring at close never buries it. Marker format and the closing `[knowledge-recheck:done]` step live in [update.md](update.md) — use that form, not a prose checklist, or the audit can't see it.

5. **Flip status + append timeline:**

    ```bash
    condash projects close <slug> --summary "<one-line outcome>" --json
    ```

    The CLI sets the status to `done`, appends `- YYYY-MM-DD — Closed. <summary>.` under `## Timeline`, then **automatically appends** `- YYYY-MM-DD — Checked knowledge promotion`. The check entry is always last — nothing may follow it without re-running the check. Skip `--summary` to land a bare `- YYYY-MM-DD — Closed.`.

6. **Worktree + branch cleanup.** If the item has a `branch` field:

   ```bash
   condash worktrees check <branch> --json
   condash worktrees remove <branch> --json
   ```

   `worktrees check` shows which repos still have worktrees on this branch. `worktrees remove` is **protected-set aware**: it only removes worktrees for repos in the closing item's `apps` that no other active item still claims on the same branch.

   The CLI does **not** delete local branches — that stays here so the `git -C <repo> branch -d` refusal can surface to the user. After `worktrees remove` reports success, for each `data.removed[].repo`:

   ```bash
   git -C <workspace_path>/<repo> branch -d <branch>
   ```

   If `-d` refuses (branch not merged), surface the message and **stop**. Don't fall back to `-D`. Don't touch the remote branch — `origin/<branch>` is GitHub's responsibility.

7. **Refresh dirty indexes.**

   ```bash
   condash dirty list --json
   ```

   - If `data.projects.present` is true → `condash projects index --json`.
   - If `data.knowledge.present` is true → `condash knowledge index --json`.

8. **Milestone commit.** `condash sync` is the conception's only committer — never run `git add` / `git commit` / `git push` here, and never invoke `/commit`. Close the item under the sync lock:

   ```bash
   condash sync commit <slug> --message "<subject>"
   ```

   Build `<subject>` as:

   ```
   Close <slug>. Outcome: <one-line outcome from the closing timeline entry>.

   Knowledge promoted: <list of knowledge/<path> entries with the **Transferred:** stamps just written, or "none">.
   Indexes refreshed: <"projects", "knowledge", "both", or "none">.
   Worktrees removed: <comma-separated list of `<branch>/<repo>`, or "none">.
   Branches deleted: <comma-separated list of `<branch>` (in `<repo>`), or "none">.
   ```

   `sync commit` pushes by default; pass `--no-push` to hold the commit local. It commits **only that item's paths** — any regenerated `index.md` from step 7 is left for the next `condash sync run`. A held lock is an error (exit 3), not a silent skip: report it and stop rather than falling back to `git`.

9. **Report** what changed: status, knowledge promotions, worktrees removed, branches deleted, indexes refreshed, commit created.

## Rules

- **No folder move.** Done items stay in their creation-month bucket.
- **Transfer stamps are historical.** They never expire; no `/verify` action checks them.

## Reopen

Trigger: `/projects reopen <slug>` or "reopen <slug>".

```bash
condash projects reopen <slug> [--status <now|review|later|backlog>] --summary "<reason>" --json
```

Default target status is `now`. The CLI flips the status (in either YAML or bold-prose form), appends `- YYYY-MM-DD — Reopened. <summary>.` under `## Timeline`, and touches `projects/.index-dirty`. If the item carried a `branch` whose worktrees were torn down at close time, offer `/projects worktree setup <branch>` afterwards — reopen is a status edit only, it never re-creates worktrees.
