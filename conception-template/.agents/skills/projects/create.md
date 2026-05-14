# /projects — create

Create a new item (project / incident / document) in the current month's bucket. The CLI owns the templates, slug regex, date↔folder invariant, canonical Status/Kind enum, and atomic directory creation — the skill just gathers fields and reports.

Trigger: `/projects create <kind>` with kind ∈ {`project`, `incident`, `document`}.

## Steps

1. **Confirm kind.** If the user omitted it, ask with one `AskUserQuestion`:

   - project — new feature or planned behaviour change.
   - incident — bug, outage, unexpected behaviour.
   - document — plan, report, investigation, audit (use only when neither "project" nor "incident" fits).

2. **Gather core fields** in one `AskUserQuestion` round unless the user already supplied them:

   - Title (becomes the H1 heading).
   - Short slug (`^[a-z0-9-]+$`; CLI rejects violations).
   - Apps (comma-separated, e.g. `condash, conception`).
   - Branch (optional).
   - Base (optional, only when targeting a non-default base branch).
   - Kind-specific:
     - incident → Environment (`PROD` / `STAGING` / `DEV`) + Severity (`low` / `medium` / `high`) + a one-line impact.

3. **Shell out:**

   ```bash
   condash projects create \
     --kind <project|incident|document> \
     --slug <slug> \
     --title "<Title>" \
     --apps "<a,b,c>" \
     [--branch <branch>] [--base <base>] \
     [--severity <low|medium|high>] [--severity-impact "<text>"] \
     [--environment <PROD|STAGING|DEV>] \
     --json
   ```

   The CLI:
   - validates slug + enums + date↔folder invariant,
   - rejects collisions (item already exists),
   - creates `projects/<YYYY-MM>/<YYYY-MM-DD>-<slug>/{README.md, notes/}`,
   - writes the matching template (kind-specific sections, header fields, first timeline entry),
   - touches `projects/.index-dirty`.

   On success, parse the envelope's `data.path` and `data.relPath`.

4. **Worktree check.** If `branch` was provided, run `condash worktrees check <branch> --json`:
   - If `data.repos[].worktreeExists` is true everywhere expected, remind the user that code edits go through the worktree paths.
   - Otherwise, offer `/projects worktree setup <branch>`.

5. **Report** the path created and the next sensible action (usually: fill in `## Goal` / `## Description`, add a first note, or set up worktrees).

## Rules

- The creation date and month are always **today** (CLI default), not a date the user gives. Backdating an item is a `git mv` + README edit, not a create.
- Folder name must match `^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$` — CLI rejects violations.
- Status / Kind values must be in the canonical enums — CLI rejects near-misses.
- Never edit the README templates by hand. They live in the CLI; if a template needs to change, change it there and ship a new condash release.
