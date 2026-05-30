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

5. **Worktree check.** If the update involves code and `branch` is set, enforce branch isolation (edits go through `<worktrees_path>/<branch>/<repo>/`).

## Rules

- Read before writing.
- One topic per note file.
- Don't commit.
- Section headings always in English; body content in the language the item is written in.

## Promoting durable knowledge

After every notes write — not just at close — re-read the paragraph you just wrote and apply the durability test from `knowledge/conventions.md`:

1. Does it hold beyond this task? (Not specific to the in-flight work.)
2. Does it apply to more than one app, or to the ecosystem?
3. Does it stay true regardless of the current PR's outcome?

Three yes → invoke `/knowledge update` now (don't wait for `/projects close`), link the resulting body file under `## Notes` in the project README, and stamp the origin paragraph in the note: `**Transferred:** YYYY-MM-DD → <knowledge-path>`. Any no → leave it in `notes/` only.

Catching durable findings at write-time keeps `knowledge/` fresh while context is loaded; deferring them all to `/projects close` risks losing the fact in heuristic-grep blind spots. `/projects close` still performs a final pass and stamping for anything that slipped through.

### Deferred promotion — when the *only* failing answer is #3

A finding can be durable (#1) and cross-cutting (#2) yet fail #3 because its truth is *established by this PR* (a field rename, a new convention, a behaviour the change introduces) — until the PR merges, writing it to `knowledge/` would assert something a review could still invalidate. Don't promote it, but don't silently drop it either: record a **deferred promotion** so it gets re-tested after merge.

Append a `## Timeline` entry carrying the open marker, naming the fact and the candidate location:

```
- YYYY-MM-DD — [knowledge-recheck:pending] <fact one-liner>; re-test after PR #NNN merges → candidate knowledge/<path>.md
```

When the PR merges, re-run the three-question test. Whatever the outcome — promote via `/knowledge update`, or drop because it didn't survive review — append the closing marker:

```
- YYYY-MM-DD — [knowledge-recheck:done] promoted → knowledge/<path>.md   (or: dropped — <reason>)
```

The `knowledge-recheck` audit check (`condash audit`, `/knowledge verify`) flags any `[knowledge-recheck:pending]` not matched by a later `[knowledge-recheck:done]`, **including in `done` projects** — so a deferral closing the project doesn't bury it. Matching is by chronological order (each close resolves the most recent open), so re-deferral and multiple concurrent deferrals both work.
