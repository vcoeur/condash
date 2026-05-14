# /knowledge — update (add or edit a body file)

Add or edit a body file under `knowledge/`, with enforced citation and stamp discipline.

Trigger: `/knowledge update [path]` — path is optional; if omitted, the skill asks what's being recorded and picks the right location.

## When this is the right action

Use `/knowledge update` when the fact being recorded is:

- **Durable** — true beyond the current project, incident, or conversation.
- **Load-bearing** — a future Claude session should find it when asked about the topic.
- **Not already** in an app's `CLAUDE.md` (for app internals, write there instead).

If the fact is in-flight project work or a point-in-time finding, it goes under the item's `notes/` via `/projects update`.

## Steps

1. **Confirm target location** using the bucket-picking rubric in `SKILL.md`.

2. **Read the target file** (if it exists) before writing. Check existing structure, headings, and stamp dates.

3. **Draft or edit the content.** Enforce the core rules from `SKILL.md` (one topic per file, citations, verification stamps).

   For the verification stamp, use the CLI rather than hand-templating the line — it's idempotent (replaces an existing stamp or inserts a new one):

   ```bash
   condash knowledge stamp <path> --where "<app>@<sha> on <branch>" [--date YYYY-MM-DD]
   ```

   `--date` defaults to today; pass it only when backstamping. To compute `<sha>` and `<branch>`:

   ```bash
   git -C <workspace_path>/<app> rev-parse --short HEAD
   git -C <workspace_path>/<app> rev-parse --abbrev-ref HEAD
   ```

   `<workspace_path>` comes from `condash config get workspace_path`.

4. **Cross-link.** Link the body file to the `projects/` item (if any) that produced the knowledge. Update the item's `## Notes` section.

5. **Dirty the knowledge index.** Default to running:

   ```bash
   condash dirty touch knowledge --json
   ```

   Skip only on a literal one-line typo or wording fix to existing prose. Anything that adds, renames, restructures, or rewrites a paragraph dirties the index — when in doubt, touch it. Cost of a false-positive is one quick `/knowledge index` run; cost of a false-negative is stale tags / descriptions teammates rely on for triage. `/knowledge index` clears the marker; the index is not auto-triggered, so remind the user to run it.

## Rules

- Core rules live in `SKILL.md` — read before writing.
- Preserve citations on edits. When refactoring existing prose, keep `([source]…)` and `(`path:line`…)` citations anchored to the right claims.
- Do not commit. Write the file; user commits when ready.

## After writing

Mention:

- The path written.
- Whether `/knowledge index` needs running (anything other than a pure body edit → yes).
- Any existing projects/items that should cross-link back.
