---
name: projects
description: Manage projects, incidents, and documents in the conception tree (`projects/YYYY-MM/YYYY-MM-DD-slug/`), plus the worktrees that back their code work. Every mechanical operation goes through `condash`. Invoke as /projects <action> [args].
---

# /projects — conception items + worktrees

Every conception item — feature project, incident, or document — lives at `projects/YYYY-MM/YYYY-MM-DD-slug/` with a `README.md` and a `notes/` directory. Items never move once created; the `status` field alone signals done-ness.

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
| `validate` | `/projects validate [<slug>]` — header sanity check                         | [retrieve.md](retrieve.md) |
| `create`   | `/projects create <kind>` — kind ∈ {project, incident, document}            | [create.md](create.md)     |
| `update`   | `/projects update <slug>`                                                   | [update.md](update.md)     |
| `close`    | `/projects close <slug>`                                                    | [close.md](close.md)       |
| `reopen`   | `/projects reopen <slug>` — done → now (or `--status <s>`)                  | [close.md](close.md)       |
| `index`    | `/projects index`                                                           | [index.md](index.md)       |
| `worktree` | `/projects worktree <setup\|remove\|check\|list\|status> [branch]`          | [worktree.md](worktree.md) |

For a trivial read or appending one note, edit files directly. The skill is mainly worth invoking for `create`, `close`, `reopen`, `index`, `search`, and any `worktree` action.

One-off CLI verb without a skill action: `condash projects backfill-closed [--dry-run]` appends a `Closed.` timeline entry to legacy done items missing one. Run by hand on a tree-wide migration; the action isn't surfaced because it's not part of the day-to-day flow.

## README header

```markdown
---
date: YYYY-MM-DD
kind: project    # or incident | document
status: now      # now | review | later | backlog | done
apps:
  - app1
  - app2/sub-path
branch: branch-name   # optional
base: branch-name     # optional
---

# <Title>
```

Legacy bold-prose headers (`**Date**: …`, etc.) are still accepted by the parser; YAML is canonical.

Status meanings:

- `now` — actively being worked on.
- `review` — code shipped or proposal drafted; awaiting an external signal (PR merge, deploy, stakeholder ack) before close. Closes on signal, reverts to `now` if negative.
- `later` — queued; will be picked up.
- `backlog` — acknowledged but not scheduled.
- `done` — finished. Folder does not move.

Kind-specific additions (incidents only): `environment: <PROD/STAGING/DEV>`, `severity: <low/medium/high — impact>`.

`apps` is a YAML list (one entry per line). `branch`'s value is authoritative. `date` always matches the month directory — changing it requires a `git mv`.

## Deliverables

A `## Deliverables` section lists an item's tangible outputs. condash renders them on the project card and in the **Deliverables** pane, and opens each by type. One bullet per item, in one of two forms:

```markdown
- [<label>](<target>) — <optional comment>      # local file or http(s) URL
- [[<slug>]] — <optional comment>                # wikilink (or [[<slug>|<label>]])
```

- **Target** — a local file relative to the item's directory (any extension: pdf, md, html, image, …), an `http(s)://` URL kept verbatim, or a `[[slug]]` wikilink to another conception item. `mailto:` and in-page `#anchor` links are ignored.
- **Comment** — optional, after ` — ` (or `-` / `:`); shown next to the label in the Deliverables pane.
- **Opens by type**: wikilink → navigates within condash; URL → external browser; `.pdf` / `.html` → in-app viewer; `.md` → read-only; anything else → OS default app.
- Links **are allowed** here — this is the one README section exempt from the "no links in `## Steps`" rule, because deliverables are meant to be links.

## Slug resolution

Item folder names match `^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$`. `<slug>` accepts three forms:

- Full dated: `2026-04-17-foo`
- Short: `foo` (substring after the date prefix)
- Month-qualified: `2026-04/2026-04-17-foo`

`condash projects resolve <slug> --json` returns the canonical match (or `AMBIGUOUS` with the candidate list).

## Branch isolation

When an item has a `branch` field:

1. Code edits go through the worktree at `<worktrees_path>/<branch>/<repo>/`. Both paths come from `condash.json` at the conception root (`condash config get worktrees_path`, `condash config get workspace_path`).
2. **Never edit code in `<workspace_path>/<repo>/`** — those are the main checkouts on different branches.
3. Use `condash worktrees check <branch>` to inspect state, `condash worktrees setup <branch>` to create, `condash worktrees remove <branch>` to clean up. `condash worktrees mismatch` lists every active item declaring a `branch` that has no on-disk worktree — run it when something feels off.

When no `branch` field is set, the main checkouts at `<workspace_path>/<repo>/` are fine.

## Shared rules

- Read before writing.
- Notes go in `notes/` as `NN-<descriptive-slug>.md` files.
- Section headings always in English; body content in any language.
- Do not commit or push.
- `## Steps` stays high-level (3–8 milestones). Per-file work goes in `notes/`. Each step line is **one short sentence** — the Projects tab card renders the steps verbatim, and verbose lines blow up the card height. Long-form scope, suggested wording, and acceptance criteria belong in a notes file at `notes/NN-<descriptive-slug>.md`, not in the step line itself. A `## Step details` section in the README is acceptable only for short clarifications that fit in a few lines; anything longer goes to notes.
- **Link steps to their notes.** When a step has a backing note, end the step line with `— see note NN` (the note file's two-digit prefix, e.g. `- [ ] do X — see note 02`). Add a `## Notes` section near the bottom of the README that indexes every `notes/NN-*.md` by short label. The README stays a thin coordinator — Goal, Scope, milestone Steps, Timeline, Notes index — and the cold reader can jump straight from a step to its detail.
- **No links inside step lines.** No markdown `[label](path)` and no wikilinks (`[[…]]`) — the card renderer surfaces them as raw text and they wrap unhelpfully. The `— see note NN` reference above is plain prose, which is fine; a backticked code/path token in essential cases is fine too. Put the actual link in `## Notes` (or `## Step details` when used) and have the step line refer to it by name.
- **Transfer stamps** (`**Transferred:** YYYY-MM-DD → <knowledge-path>`) mark passages promoted to `knowledge/`. Historical, never expire.
- Status markers in checklists: `[ ]`, `[~]`, `[x]`, `[!]`, `[-]`.
- Each item may have an optional `local/` directory next to `notes/` — gitignored, for raw inputs and intermediate renders that are useful while active but not versioned.
- **Project folder root**: the only file at the root of an item folder is `README.md` — everything else lives in a subdirectory. `notes/` holds the narrative content (numbered `NN-*.md` notes, plus `.pdf` / images when they support a note). `local/` is gitignored, for raw inputs and intermediate renders. **Sibling directories** alongside `notes/` and `local/` (`scripts/`, `pictures/`, `files/`, `deliverables/`, …) are fine when they organise topic-specific assets that don't fit `notes/` — keep them flat next to `notes/`, don't fold them under it. A loose file at the root (a stray `rapport.md` / `rapport.pdf` pair, a deliverable PDF, …) belongs in `notes/`, or in a sibling like `deliverables/` if that's where it actually lives — not at the root.

$ARGUMENTS
