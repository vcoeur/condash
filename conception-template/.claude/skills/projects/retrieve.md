# /projects — retrieve (list / read / search)

Read-only actions over the `projects/` tree. All three delegate the mechanical work to the `condash` CLI; the skill keeps only the editorial layer (slug disambiguation, summary phrasing, follow-up prompts).

## `list`

Trigger: `/projects list [kind=<k>] [status=<s>] [apps=<a>] [branch=<b>]`.

```bash
condash projects list [--kind <k>] [--status <s>] [--apps <a>] [--branch <b>] --json
```

The CLI returns one row per item with parsed `kind` / `status` / `apps` / `branch` / `date` / `stepCounts` / `headerWarnings`, sorted by status (urgency-first `now → review → later → backlog → done`), then slug. Multiple values are comma-separated (`--kind incident,document`).

Render to the user as:

```
<status>  <kind>  <title>  — projects/<month>/<slug>/  [apps]  (branch)
```

Truncate title and apps to keep one line each. If long, print counts per status at the top. Surface any `headerWarnings` rows with the bad fields named.

Fast path — no filters: `condash projects list --status now,review --json` is usually what the user means.

## `read`

Trigger: `/projects read <slug>`.

1. **Resolve the slug** with `condash projects resolve <slug> --json`. Exit code 4 → no match (re-prompt). Exit code 6 → ambiguous (the JSON `data.candidates` list carries the disambiguation).
2. **Read the README + notes** in one shot:

   ```bash
   condash projects read <slug> --with-notes --json
   ```

   The CLI returns the full header (title / kind / status / date / apps / branch / base), `summary`, `steps`, `deliverables`, and a `notes[]` array of `{relPath, content}`.
3. **Summarise** the item to the user: title, kind, status, apps, branch, what's done, what's pending, recent timeline entries. Keep the editorial framing in the skill — the CLI gives you the raw fields.

## `search`

Trigger: `/projects search <keyword> [kind=<k>] [status=<s>]`.

```bash
condash projects search "<query>" [--kind <k>] [--status <s>] --limit 50 --json
```

The CLI runs the same scoring/snippet engine the dashboard uses, scoped to projects, and decorates each hit with `headerKind` / `headerStatus` / `headerApps` so the user can triage without a second round-trip. Report one line per match:

```
<month>/<slug>: <file>: <snippet>   [kind, status]
```

`--kind=` / `--status=` filters apply against the item's parsed header before reporting.

## Notes on performance

The CLI shells out once and parses once across the whole tree — no repeated globs, no per-hit re-parses. If a folder layout violation surfaces (item directly under `projects/` with no month dir), the CLI's validation pass will report it through `headerWarnings`; surface that to the user and suggest moving the folder into the right month bucket before continuing.
