# /projects — close

Mark an item as `done`. Under the flat layout, **this is a status change only** — no folder move.

Trigger: `/projects close <slug>`.

## Steps

1. **Resolve slug** per `SKILL.md`.

2. **Read the README.** Confirm the item's current status and the state of `## Steps`.

3. **Sanity check.** If any step is still `[ ]` or `[~]` and the user hasn't explicitly said the item is done despite incomplete steps, ask:

   > "Steps N and M are still open. Close anyway, mark them done, or leave the item in `review` status?"

   **Exception — intentional deferrals.** Treat as silently complete any step whose text carries an explicit scope annotation: `(outside this item)`, `(out of scope)`, `(follow-up)`, or `(tracked in <slug>)`. These mark work parked elsewhere by design and shouldn't block close. If you see one, nudge the user *once* toward moving it under `## Notes` or a dedicated `## Follow-ups` subsection next time, then proceed.

4. **Knowledge promotion scan.** Surface durable findings mechanically (see the three-question test in [`knowledge/conventions.md`](../../../knowledge/conventions.md#promote-durable-findings-from-project-notes-to-knowledge)). Run a grep-based candidate scan over the item's notes:

   ```bash
   grep -nEi '(^|\b)(always|never|must|convention|rule|pattern|whenever|all (apps|sites|projects))\b' notes/*.md 2>/dev/null || true
   ```

   Present every hit as a numbered candidate (file:line + the full paragraph). For each, ask the user: *"Promote to `knowledge/`? (y / n / edit-first)"*.

   - **y** → invoke `/knowledge update`, landing the finding in the right body file per the knowledge skill's rules (citation, verification stamp if applicable). Then **automatically** stamp the origin paragraph in the project note with the transfer marker, placed on the next blank line immediately after the promoted passage:

     ```markdown
     **Transferred:** YYYY-MM-DD → <knowledge-path>
     ```

   - **edit-first** → refine the passage, re-present the candidate, re-ask.
   - **n** → skip, no stamp.

   If the grep yields zero hits, mention it to the user: the scan is a best-effort candidate finder, not exhaustive. Offer one manual prompt ("Any specific passage you want promoted before we close?") and move on if the answer is no.

5. **Flip status + append timeline entry** in one CLI call:

   ```bash
   condash projects close <slug> --summary "<one-line outcome>"
   ```

   The CLI sets `**Status**: done`, appends `- YYYY-MM-DD — Closed. <summary>.` under `## Timeline` (creates the section if absent), and `touch`es `projects/.index-dirty`. Returns the previous status, the appended line, and the marker state in JSON when `--json` is set. Skip `--summary` to land a bare `- YYYY-MM-DD — Closed.` and edit the line afterwards.

6. **Worktree + branch cleanup.** If the item has a `**Branch**` field, run the post-merge cleanup mandated by [`knowledge/conventions.md` → Project lifecycle](../../../knowledge/conventions.md#delete-the-feature-branch-and-worktree-at-projects-close). The cleanup is **per-app, not per-branch** — multiple items can share a branch with different `**Apps**`, so closing one item must not yank worktrees out from under another.
   1. **Locate the worktree root.** `<worktrees_path>/<branch>/`. **Branches contain slashes** (`feature/colored-layers`, `fix/inner-rounding`), so `<branch>` nests directories. Check the full path with `test -d <worktrees_path>/<branch>/`, not by listing the worktrees root and eyeballing — a top-level `feature/` entry only tells you *some* `feature/*` branch has a worktree, not whether **this** one does. Cross-check against `git -C <workspace_path>/<repo> worktree list` for each repo in `**Apps**`.
   2. **Resolve sharers.** `/projects list` filtered by the same `**Branch**` value, with this item excluded. Note the union of their `**Apps**` as the *protected set* — those repos must keep their worktree and local branch.
   3. **Confirm with the user** before any deletion: list the worktree dirs about to go (`<worktrees_path>/<branch>/<repo>/` for each `<repo>` in this item's `**Apps**` and **not** in the protected set) and the local branches to delete in those repos. Only proceed on `y`.
   4. **Remove worktrees** per app: `git -C <workspace_path>/<repo> worktree remove <worktrees_path>/<branch>/<repo>` for each `<repo>` in the cleanup list. Do not invoke `/projects worktree remove <branch>` here — that helper is branch-wide and would also yank protected repos. After the per-repo removals, if the `<worktrees_path>/<branch>/` parent directory is empty, `rmdir` it; otherwise leave it standing for the still-active sharers.
   5. **Delete local branches.** `git -C <workspace_path>/<repo> branch -d <branch>` for each repo just cleaned. Always lower-case `-d` (refuses to delete a branch that isn't merged into its upstream — the safety net for "we thought it was merged but it wasn't"). If `-d` refuses, surface the message to the user and **stop**: don't fall back to `-D`. Skip the branch deletion entirely in repos still in the protected set.
   6. **Don't touch the remote branch.** `origin/<branch>` is GitHub's responsibility (the "Delete branch" button on the merged PR). Don't `git push --delete`.

7. **Refresh dirty indexes.** Check via `condash dirty list --json`:

   - If `data.projects.present` is true, run `/projects index`.
   - If `data.knowledge.present` is true, run `/knowledge index`.

   Each index skill clears its own marker on success. If the markers are absent, the indexes are current — skip this step.

8. **Commit prompt.** After all edits are settled, ask the user whether to commit. Run `git status` + `git diff --stat` and propose a commit message inline using this context summary:

   ```
   Close <slug>. Outcome: <one-line outcome from the closing timeline entry>.

   Knowledge promoted: <list of knowledge/<path> entries with the **Transferred:** stamps just written, or "none">.
   Indexes refreshed: <"projects", "knowledge", "both", or "none">.
   Worktrees removed: <comma-separated list of `<branch>/<repo>` paths actually removed, or "none">.
   Branches deleted: <comma-separated list of `<branch>` (in `<repo>`) entries actually deleted, or "none">.
   ```

   All four lines use the literal `"none"` for the empty case so a downstream parser stays consistent. Never auto-push. If the user declines, leave the working tree dirty for them.

9. **Report** what changed. List: status change, knowledge promotions (with target paths), per-app worktrees removed and local branches deleted (if any), indexes refreshed (if any), commit created (if any). Do not commit beyond step 8.

## Rules

- **No folder move.** Under the old layout, closing triggered a move into `YYYY-MM/`. Under the flat layout, the folder is already in the right place from day one. Any logic that "tidies" done items is dead code.

- **Transfer stamps are historical, not freshness claims.** Once written, a `**Transferred:**` stamp never expires and never auto-refreshes — it records that a promotion happened on that date. Unlike `**Verified:**`, the transfer stamp is not checked by any `/verify` action.
