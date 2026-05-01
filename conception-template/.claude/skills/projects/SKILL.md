---
allowed-tools: Read, Write, Edit, Glob, Grep, AskUserQuestion, Bash(condash *)
description: "Manage projects, incidents, and documents in the conception tree (`projects/YYYY-MM/YYYY-MM-DD-slug/`), plus the worktrees that back their code work. Every mechanical operation goes through `condash`. Invoke as /projects <action> [args]."
---

# /projects — conception items + worktrees

Every conception item — feature project, incident, or document — lives at `projects/YYYY-MM/YYYY-MM-DD-slug/` with a `README.md` and a `notes/` directory. Items never move once created; **Status** alone signals done-ness.

The skill is editorial only. **Every mechanical step shells out to `condash`.** This guarantees one parser owns every read and write of the tree — the dashboard, the CLI, and this skill all see the same canonical view.

## Command surface

```
/projects <action> [args]
```

| Action     | Trigger                                                                     | Details file               |
|------------|-----------------------------------------------------------------------------|----------------------------|
| `list`     | `/projects list [kind=<k>] [status=<s>] [apps=<a>] [branch=<b>]`            | [retrieve.md](retrieve.md) |
| `read`     | `/projects read <slug>`                                                     | [retrieve.md](retrieve.md) |
| `search`   | `/projects search <keyword>`                                                | [retrieve.md](retrieve.md) |
| `create`   | `/projects create <kind>` — kind ∈ {project, incident, document}            | [create.md](create.md)     |
| `update`   | `/projects update <slug>`                                                   | [update.md](update.md)     |
| `close`    | `/projects close <slug>`                                                    | [close.md](close.md)       |
| `index`    | `/projects index`                                                           | [index.md](index.md)       |
| `worktree` | `/projects worktree <setup\|remove\|check\|list\|status> [branch]`          | [worktree.md](worktree.md) |

For a trivial read or appending one note, edit files directly. The skill is mainly worth invoking for `create`, `close`, `index`, `search`, and any `worktree` action.

## README header

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
- `review` — code shipped or proposal drafted; awaiting an external signal (PR merge, deploy, stakeholder ack) before close. Closes on signal, reverts to `now` if negative.
- `later` — queued; will be picked up.
- `backlog` — acknowledged but not scheduled.
- `done` — finished. Folder does not move.

Kind-specific additions (incidents only): `**Environment**: <PROD/STAGING/DEV>`, `**Severity**: <low/medium/high — impact>`.

`**Apps**` is backtick-delimited, comma-separated. `**Branch**`'s first backticked token is authoritative. `**Date**` always matches the month directory — changing it requires a `git mv`.

## Slug resolution

Item folder names match `^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$`. `<slug>` accepts three forms:

- Full dated: `2026-04-17-foo`
- Short: `foo` (substring after the date prefix)
- Month-qualified: `2026-04/2026-04-17-foo`

`condash projects resolve <slug> --json` returns the canonical match (or `AMBIGUOUS` with the candidate list).

## Branch isolation

When an item has a `**Branch**` field:

1. Code edits go through the worktree at `<worktrees_path>/<branch>/<repo>/`. Both paths come from `configuration.json` at the conception root (`condash config get worktrees_path`, `condash config get workspace_path`).
2. **Never edit code in `<workspace_path>/<repo>/`** — those are the main checkouts on different branches.
3. Use `condash worktrees check <branch>` to inspect state, `condash worktrees setup <branch>` to create, `condash worktrees remove <branch>` to clean up.

When no `**Branch**` field is set, the main checkouts at `<workspace_path>/<repo>/` are fine.

## Shared rules

- Read before writing.
- Notes go in `notes/` as `NN-<descriptive-slug>.md` files.
- Section headings always in English; body content in any language.
- Do not commit or push.
- `## Steps` stays high-level (3–8 milestones). Per-file work goes in `notes/`. Each step line is **one short sentence** — the Projects tab card renders the steps verbatim, and verbose lines blow up the card height. Long-form scope, suggested wording, acceptance criteria belong in a dedicated `## Step details` section (or a notes file), not the step line itself.
- **No links inside step lines.** No markdown `[label](path)` and no wikilinks (`[[…]]`) — the card renderer surfaces them as raw text and they wrap unhelpfully. Plain prose with a backticked code/path token is fine when essential. Move the link into `## Step details` or `## Notes` and have the step line refer to it by name.
- **Transfer stamps** (`**Transferred:** YYYY-MM-DD → <knowledge-path>`) mark passages promoted to `knowledge/`. Historical, never expire.
- Status markers in checklists: `[ ]`, `[~]`, `[x]`, `[!]`, `[-]`.
- Each item may have an optional `local/` directory next to `notes/` — gitignored, for raw inputs and intermediate renders that are useful while active but not versioned.

$ARGUMENTS
