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

5. **Edit the README header**: `**Status**: done`. Then `touch projects/.index-dirty` — the Status change stales the month index's tag set.

6. **Append a closing timeline entry** using today's date:

   ```markdown
   - YYYY-MM-DD — Closed. <one-line summary of the outcome>.
   ```

7. **Offer worktree cleanup.** If the item has a `**Branch**` field, check for a worktree at `<worktrees_path>/<branch>/` — **branches contain slashes** (`feature/colored-layers`, `fix/inner-rounding`), so `<branch>` nests directories. Check the full path with `ls -d <worktrees_path>/<branch>/ 2>/dev/null` (or `test -d`), not by listing the worktrees root and eyeballing — a top-level `feature/` entry only tells you *some* `feature/*` branch has a worktree, not whether **this** one does. Cross-check against the git-authoritative list: `git -C <workspace_path>/<repo> worktree list`. If a worktree is found, ask whether to run `/projects worktree remove <branch>`. Only do it if the user confirms and no other active item shares that branch (`/projects list` filtered by the same branch).

8. **Refresh dirty indexes.** Check for sentinel files:

   - If `projects/.index-dirty` exists, run `/projects index`.
   - If `knowledge/.index-dirty` exists, run `/knowledge index`.

   Each index skill clears its own marker on success. If the markers are absent, the indexes are current — skip this step.

9. **Commit prompt.** After all edits are settled, ask: *"Run `/commit` now? (y / n)"*. If `y`, invoke `/commit` with a context summary built from the closing timeline entry + the mechanical actions that just ran. Use this exact template as the argument to the `/commit` skill:

   ```
   Close <slug>. Outcome: <one-line outcome from the closing timeline entry>.

   Knowledge promoted: <list of knowledge/<path> entries with the **Transferred:** stamps just written, or "none">.
   Indexes refreshed: <"projects", "knowledge", "both", or "none">.
   Worktree: <"removed <branch>", "kept <branch>", or "none">.
   ```

   All three lines use the literal `"none"` for the empty case so the template parses consistently.

   The global `/commit` skill then has enough to write an informative subject + body without reading the whole diff. Never auto-push. If `n`, leave the working tree dirty for the user.

10. **Report** what changed. List: status change, knowledge promotions (with target paths), worktree removed (if any), indexes refreshed (if any), commit created (if any). Do not commit beyond step 9.

## Rules

- **No folder move.** Under the old layout, closing triggered a move into `YYYY-MM/`. Under the flat layout, the folder is already in the right place from day one. Any logic that "tidies" done items is dead code.

- **Transfer stamps are historical, not freshness claims.** Once written, a `**Transferred:**` stamp never expires and never auto-refreshes — it records that a promotion happened on that date. Unlike `**Verified:**`, the transfer stamp is not checked by any `/verify` action.
