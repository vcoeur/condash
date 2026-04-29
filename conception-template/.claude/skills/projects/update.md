# /projects — update

Append notes, bump status, add timeline entries on an existing item.

Trigger: `/projects update <slug>` or implicit "add a note to <slug>", "change <slug> status to review".

## Steps

1. **Resolve slug** per `SKILL.md`. Error if not found.

2. **Read the README in full.** Understand kind, current status, latest timeline entries, and any existing notes.

3. **Decide the write:**

   - **New finding / work log** → create or update a file under `notes/`. Filename is `NN-<descriptive-slug>.md` — two-digit zero-padded prefix, next available number for the item (check with `ls notes/`), descriptive slug (`notes/03-backend-implementation-plan.md`, not `notes/update-1.md` or unprefixed `notes/backend-implementation-plan.md`). If a single-summary note exists, update it rather than fragmenting.
   - **Status change** → edit the `**Status**` line in the README header. Add a timeline entry explaining the change. Reject values outside the canonical enum — see `SKILL.md`. Never silently accept a near-miss.
   - **Field edit** (Apps, Branch, Severity, …) → edit the header line + a timeline entry if material.
   - **Step completion** → flip `[ ]` → `[x]` (or `[~]` for in-progress, `[!]` for blocked). Add a timeline entry.
   - **Follow-ups parked elsewhere** → work that's intentionally deferred to another item (or left open for a future owner) does not belong in `## Steps`. Put it under `## Notes` or a dedicated `## Follow-ups` subsection. If it must stay in `## Steps` for visibility, tag it with `(outside this item)`, `(out of scope)`, `(follow-up)`, or `(tracked in <slug>)` so `/projects close` doesn't flag it as unfinished work.

4. **Timeline entries.** Use today's date in `YYYY-MM-DD` form. One line: `<date> — <what happened>`. Keep them terse.

5. **Notes section.** After writing a new `notes/<name>.md`, add a line to `## Notes` in the README: `` - [`notes/<name>.md`](notes/<name>.md) — <one-line hook>. ``.

6. **Never move the folder.** The layout is path-stable. Status changes, even to `done`, leave the folder exactly where it is — in its creation-month bucket.

7. **Worktree check.** If `**Branch**` is set and the update involves code, enforce the branch isolation rules from `SKILL.md` (edit through `<worktrees_path>/<branch>/<repo>/`, never `<workspace_path>/<repo>/`).

8. **Dirty the projects index only when the change is index-relevant.** `touch projects/.index-dirty` if the update changed the item's `**Kind**`, `**Status**`, `**Apps**`, title (H1), or renamed the folder. Pure body/timeline/note edits do **not** stale the index — skip the touch.

## Rules

- **Read before writing.** Don't overwrite a note you haven't read.
- **One topic per note file.** If a note grows past one topic, split it.
- **Short Steps list.** If you feel tempted to add sub-sub-bullets to `## Steps`, that detail belongs in a note, not the README.
- **Do not commit.** The user commits when ready.
- **Language convention.** Section headings always in English. Body content in the language the item is written in.

## When the update produces durable knowledge

Apply the three-question durability test from [`knowledge/conventions.md#promote-durable-findings-from-project-notes-to-knowledge`](../../../knowledge/conventions.md). Three yes → write to `knowledge/` via `/knowledge update`, link under the item's `## Notes` section, and stamp the origin paragraph `**Transferred:** YYYY-MM-DD → <knowledge-path>`.

The `## Notes` link is a pointer at the item level; the stamp marks the specific passage that was promoted, and survives even if `## Notes` is later reorganised. Transfer stamps never expire — they are historical. `/projects close` performs this stamping automatically when a candidate is confirmed during its scan.
