# /projects — create

Create a new item (project / incident / document) in the current month's bucket.

Trigger: `/projects create <kind>` with kind ∈ {`project`, `incident`, `document`}.

## Steps

1. **Confirm kind.** Must be one of `project`, `incident`, `document`. If the user omitted it, ask:

   - project — new feature or planned behaviour change.
   - incident — bug, outage, unexpected behaviour.
   - document — plan, report, investigation, audit. Use this only when neither "project" nor "incident" fits.

2. **Gather core fields** with one `AskUserQuestion` round unless the user already said them:

   - Title (becomes the H1 heading).
   - Short slug (lowercase, hyphen-separated; will be prefixed with today's date).
   - Apps (comma-separated, e.g. `condash, conception`).
   - Branch (optional).
   - Kind-specific:
     - incident → Environment (`PROD` / `STAGING` / `DEV`) + Severity (`low` / `medium` / `high` — one-line impact).

3. **Compute the path.**

   - Date: today's date.
   - Month: today's `YYYY-MM`.
   - Folder: `projects/<YYYY-MM>/<YYYY-MM-DD>-<slug>/`.
   - If the folder already exists, flag to the user and ask for a different slug.

4. **Create the directories.**

   ```bash
   mkdir -p ~/src/vcoeur/conception/projects/<YYYY-MM>/<YYYY-MM-DD>-<slug>/notes
   ```

5. **Write the README** using the matching template below. Substitute all `<placeholder>` values. The first timeline entry is `<today> — Created.`.

   **project:**

   ```markdown
   # <Project title>

   **Date**: YYYY-MM-DD
   **Kind**: project
   **Status**: now
   **Apps**: <list of affected apps/repos>
   **Branch**: <branch name, if applicable>
   <!-- **Base**: <branch> — optional, override default PR base branch -->

   ## Goal

   <What this project aims to achieve — the user-facing outcome.>

   ## Scope

   <What is in scope and what is explicitly out of scope.>

   ## Steps

   - [ ] <first task>

   ## Timeline

   - YYYY-MM-DD — Project created.

   ## Notes
   ```

   **incident:**

   ```markdown
   # <Incident title>

   **Date**: YYYY-MM-DD
   **Kind**: incident
   **Status**: now
   **Apps**: <list of affected apps/repos>
   **Branch**: <branch name, if applicable>
   <!-- **Base**: <branch> — optional, override default PR base branch -->
   **Environment**: <PROD/STAGING/DEV, pod/service name>
   **Severity**: <low/medium/high — one-line impact summary>

   ## Description

   <What happened — observable symptoms, scope, when it started.>

   ## Symptoms

   <Bullet list of error messages, user-facing effects, log patterns.>

   ## Analysis

   <Investigation findings, hypotheses, references to `notes/`.>

   ## Root cause

   _Not yet identified._

   ## Steps

   - [ ] <action items>

   ## Timeline

   - YYYY-MM-DD — Incident created.

   ## Notes
   ```

   **document:**

   ```markdown
   # <Title>

   **Date**: YYYY-MM-DD
   **Kind**: document
   **Status**: now
   **Apps**: <list of affected apps/repos>
   **Branch**: <branch name, if applicable>
   <!-- **Base**: <branch> — optional, override default PR base branch -->

   ## Goal

   <Purpose — what this document aims to achieve or answer.>

   ## Steps

   - [ ] Step 1
   - [ ] Step 2

   ## Timeline

   - YYYY-MM-DD — Created.

   ## Notes
   ```

6. **Worktree check.** If `**Branch**` was provided:

   - If worktrees exist at `<worktrees_path>/<branch>/`, remind the user that code edits must go through the worktree paths.
   - Otherwise, offer to run `/projects worktree setup <branch>` right now.

7. **Dirty the projects index.** `touch projects/.index-dirty` — this sentinel signals that `projects/index.md` and the month index are now stale. `/projects index` clears it. `/projects close` auto-refreshes when set. Do **not** regenerate indexes automatically from create.

8. **Report** the path created and the next sensible action (usually: fill in `## Goal` / `## Description`, add a first note, or run `/projects worktree setup`).

## Rules

- The creation date and month are always **today**, not a date the user gives you. If they want to backdate an item, that is a `git mv` + README edit, not a create — ask what they're trying to do.
- Never create an item at the top level of `projects/` (i.e. outside a month directory). The layout is strict.
- **Folder name must match** `^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$`. Reject at create time — the index regenerator only warns after the fact.
- **Status must be in the canonical enum** — see `SKILL.md`. Reject near-misses (`active`, `wip`, `in-progress`, …); condash's parser silently coerces unknowns to `backlog`.
