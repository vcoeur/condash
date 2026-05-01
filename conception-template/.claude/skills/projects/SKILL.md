---
allowed-tools: Read, Write, Edit, Glob, Grep, AskUserQuestion, Bash(ls ${CLAUDE_PROJECT_DIR}/*), Bash(mkdir -p ${CLAUDE_PROJECT_DIR}/*), Bash(ls ${CLAUDE_PROJECT_DIR}/*/*), Bash(git -C ~/src/* worktree *), Bash(git -C ~/src/* branch*), Bash(git -C ~/src/* checkout *), Bash(git -C ~/src/* status*), Bash(git -C ${CLAUDE_PROJECT_DIR} mv *), Bash(mkdir -p ~/src/worktrees/*), Bash(rmdir ~/src/worktrees/*), Bash(ls ~/src/worktrees*), Bash(npm install --cache * --prefix ~/src/worktrees/*), Bash(cp ~/src/*/.env* ~/src/worktrees/*)
description: "Manage projects, incidents, and documents in the conception tree (`projects/YYYY-MM/YYYY-MM-DD-slug/`), plus the worktrees that back their code work. Unified items skill — every item carries a **Kind** field (project | incident | document). Invoke as /projects <action> [args]."
---

# /projects — conception items + worktrees

Every conception item — feature project, incident, or document — lives at:

```
~/src/vcoeur/conception/projects/YYYY-MM/YYYY-MM-DD-slug/
├── README.md      (carries **Kind**: project | incident | document)
└── notes/
```

Month directory is the item's **creation month**. Items never move for their whole lifecycle — `Status` alone signals done-ness. `YYYY-MM/index.md` and the top-level `projects/index.md` form a self-describing tree (same shape as `knowledge/`).

## Command surface

```
/projects <action> [args]
```

| Action      | Trigger                                                                            | Details file          |
|-------------|------------------------------------------------------------------------------------|-----------------------|
| `list`      | `/projects list [kind=<k>] [status=<s>]`                                           | [retrieve.md](retrieve.md) |
| `read`      | `/projects read <slug>`                                                            | [retrieve.md](retrieve.md) |
| `search`    | `/projects search <keyword>`                                                       | [retrieve.md](retrieve.md) |
| `create`    | `/projects create <kind>` — kind ∈ {project, incident, document}                   | [create.md](create.md)     |
| `update`    | `/projects update <slug>`                                                          | [update.md](update.md)     |
| `close`     | `/projects close <slug>`                                                           | [close.md](close.md)       |
| `index`     | `/projects index`                                                                  | [index.md](index.md)       |
| `worktree`  | `/projects worktree <setup\|remove\|list\|status> [branch]`                        | [worktree.md](worktree.md) |

For a trivial read or appending one note, edit files directly — invoking the skill is heavyweight. The skill is mainly worth invoking for `create`, `close`, `index`, `search`, and any `worktree` action.

## Shared conventions

### README header

```markdown
# <Title>

**Date**: YYYY-MM-DD
**Kind**: project | incident | document
**Status**: now | review | later | backlog | done
**Apps**: `app1`, `app2/sub-path`
**Branch**: `branch-name` (optional)
**Base**: `branch-name` (optional)
```

Status meanings:

- `now` — actively being worked on.
- `review` — code shipped or proposal drafted; awaiting an external signal (PR merge, deploy, stakeholder ack) before the item can close. Closes on signal, or reverts to `now` if the signal is negative.
- `later` — queued; will be picked up but not yet scheduled.
- `backlog` — acknowledged but not scheduled.
- `done` — finished. Under the flat layout, the folder does not move.

Kind-specific additions (only when relevant):

- `**Kind**: incident` → `**Environment**: <PROD/STAGING/DEV>`, `**Severity**: <low/medium/high — impact>`.

Field rules:

- `**Apps**`: backtick-delimited, comma-separated list of affected apps/repos.
- `**Branch**`: optional. The git branch used for code changes. The **first backticked token is authoritative** — any trailing prose is ignored by parsers. Once the branch is gone (merged, abandoned, superseded), **delete the whole line** from the README rather than keeping a post-life annotation. If branches differ per repo (rare): `` `branch-a` (repo-x), `branch-b` (repo-y) ``.
- `**Base**`: optional. Overrides the default base branch used by the PR-creation flow (default is `origin/HEAD` on the repo's main checkout). Omit unless the project targets a non-default base (e.g. `develop`, a release branch). When the item spans repos with different bases, use the `` `base-a` (repo-x), `base-b` (repo-y) `` form.
- `**Date**` **always** matches the month directory (`projects/2026-04/2026-04-17-slug/` → `Date: 2026-04-17`). Changing the date means `git mv`-ing the folder; never drift.

### Directory contract

- Active + done items share the same path. **No item ever moves** because of a status change.
- New items land in `projects/<current-YYYY-MM>/<creation-date>-<slug>/`.
- `projects/index.md` — tree root: intro, kinds summary, link to each month's index, read rules.
- `projects/YYYY-MM/index.md` — one bullet per item in that month: link, italic one-line description, `[kind, status, app-1, keyword-…]` tag list.

Indexes are regenerated by `/projects index`. Hand-curated descriptions and tags are preserved across runs (same idempotence contract as `knowledge/**/index.md`).

### Slug resolution

Item folder names must match `^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$` (zero-padded date + lowercase hyphenated slug). `/projects create` rejects violations; `/projects index` warns on existing drift.

`<slug>` can be passed in three forms:

- Full dated: `2026-04-17-foo` — exact folder name (minus month dir).
- Short: `foo` — any part of the slug after the date prefix.
- Month-qualified: `2026-04/2026-04-17-foo` — relative to `projects/`.

Resolution: glob `projects/*/*-<slug>*/README.md`, pick the unique match, error on ambiguous.

### Shared rules

- Always read before writing — check existing content before modifying.
- Notes go in `notes/` as individual `.md` files named `NN-<descriptive-slug>.md` — zero-padded two-digit prefix, incremented in creation order (`01-inventory.md`, `02-rust-findings.md`, …). The prefix makes the reading order explicit when someone lists the directory, and makes later notes easy to reference by number in chat. If a single summary note exists, update it rather than creating new files.
- **Language**: section headings and structure always in English. Body content can be in any language the user picks per-item.
- Do not commit or push — only write files. The user commits when ready.
- When referencing project code, use paths relative to the **workspace root** (`workspace_path` in `configuration.json`).
- **`## Steps` stays short** — high-level milestones only, 3–8 items. Per-file work, acceptance criteria, implementation checklists go in `notes/` or the PR description.
- **Transfer stamps.** When a durable finding is promoted from a project note to `knowledge/`, stamp the origin paragraph: `**Transferred:** YYYY-MM-DD → <knowledge-path>`. Historical marker — never expires, not checked by any `/verify` action. See [`close.md`](close.md) step 4 for the workflow.
- **Status markers** (for checklists inside `## Steps`, notes, or anywhere in an item): `[ ]` not started, `[~]` in progress, `[x]` done, `[!]` blocked, `[-]` abandoned / will not be done. These are orthogonal to the `**Status**` header field (which tracks the item as a whole).
- **Per-item `local/` scratch directory.** Each item may optionally hold a `local/` subdirectory next to `notes/`. It is **gitignored** (see `.gitignore`) and intended for artifacts useful for reproducibility while the item is active but not meant to be versioned: raw third-party downloads (font TTFs, CSV exports, vendor PDFs), intermediate renders (rasterised PNGs, pre-PDF HTML), generator scripts whose outputs already live in `notes/`. **Do not** reference a `local/` path from the README, `notes/`, or any knowledge file — those links will be broken for anyone else. When a `local/` workflow produces a deliverable, commit the deliverable into `notes/` (LFS-tracked) and leave the raw inputs in `local/`.

## Branch isolation

When an item has a `**Branch**` field:

1. Check if worktrees exist at `<worktrees_path>/<branch>/`.
2. If yes: **all code reads and edits MUST use the worktree paths** (`<worktrees_path>/<branch>/<repo>/...`).
3. If no: **offer to set them up** (`/projects worktree setup <branch>`) before making any code changes.
4. **NEVER edit code in `<workspace_path>/<repo>/`** when a Branch is specified — those are the main working copies, likely on a different branch.

When an item has no `**Branch**` field: use the main working copies at `<workspace_path>/<repo>/` normally.

The conception repo itself is always edited directly — documentation has no per-item branches. `workspace_path` and `worktrees_path` are read from `configuration.json` at the conception tree root.

Violating these rules means editing files on the wrong branch, causing merge conflicts and lost work.

$ARGUMENTS
