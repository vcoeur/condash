# /projects — update

Append notes, bump status, add timeline entries on an existing item. The CLI owns status writes and the dirty-marker; the skill handles editorial decisions and free-form notes.

Trigger: `/projects update <slug>` or implicit ("add a note to <slug>", "change <slug> status to review").

## Steps

1. **Resolve slug:** `condash projects resolve <slug> --json`. Exit code 6 → ambiguous (the JSON `data.candidates` carries the disambiguation list).

2. **Read the item:** `condash projects read <slug> --with-notes --json`. Use `data.title`, `data.kind`, `data.status`, `data.steps`, and `data.notes[]` to understand current state.

3. **Decide the write:**

   - **New finding / work log** → write a `notes/NN-<slug>.md` file (next available number from `data.notes[]`). Add one line under `## Notes` in the README: `` - [`notes/<name>.md`](notes/<name>.md) — <one-line hook>. ``.
   - **Status change** → `condash projects status set <slug> <value> --json`. CLI validates the enum, rewrites the header line idempotently, touches `projects/.index-dirty`. Add a timeline entry explaining the change (one-line `Edit`).
   - **Field edit** (Apps, Branch, Severity, …) → edit the header line + a timeline entry if material. Run `condash dirty touch projects --json` if Apps or Branch changed.
   - **Step completion** → flip `[ ]` → `[x]` (or `[~]`/`[!]`). Add a timeline entry.
   - **Follow-ups parked elsewhere** → put under `## Notes` or `## Follow-ups`. If kept in `## Steps` for visibility, tag with `(outside this item)`, `(out of scope)`, `(follow-up)`, or `(tracked in <slug>)` so `/projects close` doesn't flag them.

4. **Timeline entries.** One line: `<YYYY-MM-DD> — <what happened>`. Terse.

5. **Worktree check.** If the update involves code and `**Branch**` is set, enforce branch isolation (edits go through `<worktrees_path>/<branch>/<repo>/`).

## Rules

- Read before writing.
- One topic per note file.
- Don't commit.
- Section headings always in English; body content in the language the item is written in.

## Promoting durable knowledge

Apply the three-question durability test from `knowledge/conventions.md`. Three yes → `/knowledge update`, link under `## Notes`, stamp the origin paragraph `**Transferred:** YYYY-MM-DD → <knowledge-path>`. `/projects close` performs this stamping automatically when a candidate is confirmed during its scan.
