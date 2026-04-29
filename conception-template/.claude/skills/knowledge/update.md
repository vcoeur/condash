# /knowledge — update (add or edit a body file)

Add or edit a body file under `knowledge/`, with enforced citation and stamp discipline.

Trigger: `/knowledge update [path]` — path is optional; if omitted, the skill asks what's being recorded and picks the right location.

## When this is the right action

Use `/knowledge update` when the fact being recorded is:

- **Durable** — true beyond the current project, incident, or conversation.
- **Load-bearing** — a future Claude session should find it when asked about the topic.
- **Not already** in an app's `CLAUDE.md` (for app internals, write there instead).

If the fact is in-flight project work or a point-in-time finding, write it to the item's `notes/` instead via `/projects update`.

## Steps

1. **Confirm the target location** using the "When to create vs. extend" rules from `SKILL.md`:

   - durable team rule surfaced in session → `conventions.md` (root-level)
   - third-party service → `external/<system>.md`
   - shared self-hosted service → `internal/<service>.md`
   - cross-cutting topic → `topics/<slug>.md`
   - new app → create `internal/<app>.md` (short pointer to the app's `CLAUDE.md` + any conception-side knowledge) and add an entry to `internal/index.md`
   - single-app detail → route to that app's `CLAUDE.md`, not here

2. **Read the target file** (if it exists) before writing. Check existing structure, headings, and stamp dates.

3. **Draft or edit the content.** Enforce the core rules from `SKILL.md` (one topic per file, citations, verification stamps). `<where>` values for stamps are also defined there.

4. **Cross-link.** Link the body file to the `projects/` item (if any) that produced the knowledge. From the item, link back — update its `## Notes` section (all kinds). If invoked from inside a `/projects close` flow, the stamping of `**Transferred:** YYYY-MM-DD → <path>` on the origin paragraph happens automatically; otherwise stamp it manually.

5. **Dirty the knowledge index** when the change is index-relevant. `touch knowledge/.index-dirty` if this action **added**, **renamed**, or **substantially rewrote the scope** of a body file. Pure body edits that don't change scope (no new heading, no renamed concept) do **not** stale the index — skip the touch. `/knowledge index` clears the marker; `/projects close` auto-refreshes when the marker is set. Remind the user in chat — the index is not auto-triggered; the user runs it when the batch of edits is finalised.

## Rules

- **Core rules live in `SKILL.md`** (durable only, one topic per file, no duplicate app internals, stamp discipline). Don't restate them here — read them before writing.
- **Preserve citations on edits.** When refactoring existing prose, keep existing `([source]…)` and `(`path:line`…)` citations anchored to the right claims.
- **Do not commit.** Write the file; user commits when ready.

## After writing

Mention:

- The path written.
- Whether `/knowledge index` needs running (anything other than a pure body edit → yes).
- Any existing projects/items that should cross-link back to the new knowledge file.
