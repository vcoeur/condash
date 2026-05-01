# /projects — close

Mark an item as `done`. Under the flat layout, this is a status change only — no folder move.

Trigger: `/projects close <slug>`.

## Steps

1. **Resolve slug:** `condash projects resolve <slug> --json`.

2. **Read state:** `condash projects read <slug> --with-notes --json`. Use `data.steps`, `data.status`, `data.notes[]` to assess.

3. **Sanity check.** If any step is still `[ ]` or `[~]` and the user hasn't said the item is done despite incomplete steps, ask:

   > "Steps N and M are still open. Close anyway, mark them done, or leave the item in `review` status?"

   **Exception — intentional deferrals.** Treat as silently complete any step whose text carries `(outside this item)`, `(out of scope)`, `(follow-up)`, or `(tracked in <slug>)`.

4. **Knowledge promotion review.** Editorial step — Claude does the reading, the CLI is a backstop.

   a. **Read the README and every `notes/*.md` body** returned by step 2's `read --with-notes`. Do not skim. Durable findings often land outside the heuristic's reach: in `## Description`, `## Steps` prose, `## Timeline` entries, or notes phrased as observations rather than imperatives.

   b. **Apply the three-question durability test from `knowledge/conventions.md`** to every candidate paragraph you noticed:

      1. Does it hold beyond this task? (Not specific to the in-flight work.)
      2. Does it apply to more than one app, or to the ecosystem? (Or: would a teammate touching another app want to find it.)
      3. Does it stay true regardless of the current PR's outcome? (Survives both merge and abandonment.)

      Three yes → keep as a candidate. Any no → silently drop. Do not present a candidate that fails the test.

   c. **Run the heuristic backstop** to catch anything you missed:

      ```bash
      condash projects scan-promotions <slug> --json
      ```

      The CLI grep-walks `notes/*.md` for `always|never|must|convention|rule|pattern|whenever|all (apps|sites|projects)` and returns `data.candidates[]` with `relPath`, `line`, `match`, and the surrounding `paragraph`. For each row, check whether you already have it in your candidate set; if not, re-apply the three-question test before adding it. Skip any paragraph already carrying a `**Transferred:**` stamp.

   d. **Present surviving candidates** (yours + any new from the scan) as a numbered list, each with the origin `<file>:<line>` reference, the exact paragraph, and the proposed `knowledge/` location (use the bucket-picking rubric from `knowledge/SKILL.md`). For each, ask: *"Promote to `knowledge/<path>`? (y / n / edit-first)"*.

   - **y** → invoke `/knowledge update`, then **automatically** stamp the origin paragraph (in the README or the note) with `**Transferred:** YYYY-MM-DD → <knowledge-path>`.
   - **edit-first** → refine wording or target path, re-present, re-ask.
   - **n** → skip.

   If your reading produced zero candidates and the scan also returned empty, say so and move on — don't synthesise a prompt to fish for one.

5. **Flip status + append timeline:**

   ```bash
   condash projects close <slug> --summary "<one-line outcome>" --json
   ```

   The CLI sets `**Status**: done`, appends `- YYYY-MM-DD — Closed. <summary>.` under `## Timeline`, and touches `projects/.index-dirty`. Skip `--summary` to land a bare `- YYYY-MM-DD — Closed.`.

6. **Worktree + branch cleanup.** If the item has a `**Branch**` field:

   ```bash
   condash worktrees check <branch> --json
   condash worktrees remove <branch> --json
   ```

   `worktrees check` shows which repos still have worktrees on this branch. `worktrees remove` is **protected-set aware**: it only removes worktrees for repos in the closing item's `**Apps**` that no other active item still claims on the same branch.

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

8. **Commit prompt.** Ask the user whether to commit. Run `git status` + `git diff --stat` and propose a commit message inline using:

   ```
   Close <slug>. Outcome: <one-line outcome from the closing timeline entry>.

   Knowledge promoted: <list of knowledge/<path> entries with the **Transferred:** stamps just written, or "none">.
   Indexes refreshed: <"projects", "knowledge", "both", or "none">.
   Worktrees removed: <comma-separated list of `<branch>/<repo>`, or "none">.
   Branches deleted: <comma-separated list of `<branch>` (in `<repo>`), or "none">.
   ```

   Never auto-push.

9. **Report** what changed: status, knowledge promotions, worktrees removed, branches deleted, indexes refreshed, commit created.

## Rules

- **No folder move.** Done items stay in their creation-month bucket.
- **Transfer stamps are historical.** They never expire; no `/verify` action checks them.
