# /projects — retrieve (list / read / search)

Read-only actions over the `projects/` tree.

## `list`

Trigger: `/projects list [kind=<k>] [status=<s>]`.

1. **Enumerate.** Glob `${CLAUDE_PROJECT_DIR}/projects/*/README.md` — this yields every item's README across all months.
2. **Parse header.** For each, read the first ~20 lines and extract `**Date**`, `**Kind**`, `**Status**`, `**Apps**`, `**Branch**`.
3. **Filter.** Apply `kind=` and `status=` if passed. Multiple values are comma-separated (`kind=incident,document`).
4. **Group.** Default grouping: by `Status` (urgency-first order `now → review → later → backlog → done`), then by `Kind` within each status block.
5. **Output.** One line per item:

   ```
   <status>  <kind>  <title>  — projects/<month>/<slug>/  [apps]  (branch)
   ```

   Truncate title and apps to keep it one line each. If the list is long, print counts per status at the top.

Fast path — no filters, no grouping, just "what's active": `/projects list status=now,review` is usually what the user means.

## `read`

Trigger: `/projects read <slug>`.

1. **Resolve the slug** using the rules in `SKILL.md` (full dated / short / month-qualified). If ambiguous, ask the user.
2. **Read the README in full.** Don't summarise yet.
3. **Read every file in `notes/`.** Short files — just read them. If there are many large files, skim titles and offer a list.
4. **Summarise** the item to the user: title, kind, status, apps, branch, what's done, what's pending, recent timeline entries.

## `search`

Trigger: `/projects search <keyword> [kind=<k>] [status=<s>]`.

1. **Grep** with `rg` / `Grep` against `${CLAUDE_PROJECT_DIR}/projects/**/README.md` and `${CLAUDE_PROJECT_DIR}/projects/**/notes/*.md`.
2. **Report** one line per match: `<month>/<slug>: <file>: <snippet>`.
3. **Include kind + status** from the README header on each match line so the user can triage. Parse once per item, cache across hits in that item.
4. **Apply `kind=` / `status=` filters** against the item's parsed header before reporting. Cross-kind search is the default.

## Notes on performance

The flat layout means one glob covers everything. No need to walk three separate trees; no need to check top-level vs. `YYYY-MM/` subdirs. If an item folder ever appears directly under `projects/` (no month dir), it's a layout violation — flag it to the user and suggest moving it into the right month bucket before continuing.
