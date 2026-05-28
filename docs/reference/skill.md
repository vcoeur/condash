---
title: Management skills · condash reference
description: Reference for the three shipped Claude Code skills — /projects, /knowledge, /pr — and how they shell out to the condash CLI.
---

# Management skills

> **Audience.** Daily user.

## At a glance

condash ships three [Claude Code](https://docs.claude.com/en/docs/claude-code/) skills. They live under [`conception-template/.agents/skills/`](https://github.com/vcoeur/condash/tree/main/conception-template/.agents/skills) in the repo and land at `<conception>/.agents/skills/` after running `condash skills install`. Each skill is placed verbatim — `SKILL.md` plus any task `.md` files and an optional `SKILL.<harness>.md` overlay. condash does not compile them to per-harness directories; the harness launcher renders them per agent at run time.

| Skill | Scope | What it does |
|---|---|---|
| **`/projects`** | items + worktrees | Create / read / update / close projects, incidents, and documents. Manage worktrees per branch. |
| **`/knowledge`** | knowledge tree | Retrieve, update, index, and verify durable reference material in `<conception>/knowledge/`. Audits (orphans, dangling links, cross-repo refs, worktree drift, LFS coverage, large binaries, stale stamps) flow through `verify`. |
| **`/pr`** | git | Open a GitHub PR from the current branch with the project README's timeline-append rule applied. |

The skills are **editorial only**. Every mechanical step shells out to `condash`, so the dashboard, the CLI, and the skills always see the same canonical view of the tree. A skill never re-implements parsing or validation in `bash + grep + sed`.

The pre-reframe `/tidy` and `/skills` skills were dropped: tidy's audits are now reachable from `/knowledge verify` (which wraps `condash audit` + `condash knowledge verify`), and `/skills` was a thin wrapper over `condash skills install` — call the CLI directly.

## `/projects`

Manage items in `projects/YYYY-MM/YYYY-MM-DD-slug/`. The skill drives the matching CLI verbs through `condash projects ...`.

| Action | Trigger | Wraps |
|---|---|---|
| `list` | `/projects list [kind=…] [status=…] [apps=…] [branch=…]` | `condash projects list` |
| `read` | `/projects read <slug>` | `condash projects read` |
| `search` | `/projects search <keyword>` | `condash projects search` |
| `validate` | `/projects validate [<slug>]` | `condash projects validate` |
| `create` | `/projects create <kind>` (project / incident / document) | `condash projects create` |
| `update` | `/projects update <slug>` | direct file edits, drift-checked |
| `close` | `/projects close <slug>` | `condash projects close` |
| `check-knowledge` | `/projects check-knowledge <slug>` — signal / `--record` / `--backfill` | `condash projects check-knowledge` |
| `reopen` | `/projects reopen <slug>` | `condash projects reopen` |
| `index` | `/projects index` | `condash projects index` |
| `worktree` | `/projects worktree {setup\|remove\|check\|list\|status} [branch]` | `condash worktrees …` |

The `create` action enforces the canonical kind templates and the `^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$` slug regex. The `close` action appends the `Closed.` timeline entry then records the dated `Checked knowledge promotion` marker; `reopen` appends `Reopened.`. `check-knowledge` is the standalone recorder for that marker (`--record` after a review, `--backfill` for the legacy batch) — the date and format are always written by condash, never hand-typed.

## `/knowledge`

Manage durable reference material in `<conception>/knowledge/`.

| Action | Trigger | Wraps |
|---|---|---|
| `retrieve` | `/knowledge retrieve <query>` — triage walk (`triage` / `grep` / `both`) | `condash knowledge retrieve` |
| `update` | `/knowledge update <path>` — add or edit a body file with citation + verification stamp | direct file edits + `condash knowledge stamp` |
| `index` | `/knowledge index` — regenerate every `knowledge/**/index.md` | `condash knowledge index` |
| `verify` | `/knowledge verify` — the conception-wide sweep: stamp freshness + every audit (orphans, dangling links, cross-repo refs, worktree drift, LFS coverage, large binaries, deferred + missing knowledge-promotion checks) | `condash knowledge verify` + `condash audit --include all` |

Every body file carries a `**Verified:** YYYY-MM-DD` stamp; `verify` flags ones older than the freshness threshold and surfaces tree-wide audit findings in the same punch-list.

## `/pr`

Open a GitHub PR from the current branch with condash's standard PR shape: title stating the objective, a short Summary, a Changes list, and the optional Impact / Watchpoints sections when relevant. Project-level wrappers (e.g. conception's `/pr`) defer body shape to this skill — read it before drafting.

## Install

```bash
# Once per conception, after first install
condash skills install

# After upgrading condash (walks the diff for files you may have edited)
condash skills install
```

The skill sources land at `<conception>/.agents/skills/`. With a harness launcher set up to render them, `/projects`, `/knowledge`, `/pr` become available in a session.

`condash skills install` writes one file at a time and asks for confirmation per file when local content differs from the shipped version — your customisations don't get clobbered silently. It records what it shipped in one manifest at `<conception>/.agents/.condash-skills.json` (v3 schema: a `skills.<name>` namespace for skill sources plus a `files.<path>` namespace retained for legacy entries; condash ≤ 4.0.1 shipped a region-delimited `.gitignore` and no longer ships any top-level file). Each tracked file carries its shipped version + SHA256, so a re-install can tell an unchanged file from a locally-edited one and refuse to clobber edits without `--force`. `AGENTS.md` is **not** manifest-tracked — its marker line is the boundary, so there's no hash to reconcile.

### The skill source is committed; nothing is compiled

The `.agents/skills/` source tree is the committed, canonical copy of each skill. condash no longer produces any per-harness compiled output and no compiled instruction files. The harness launcher (shipped separately) reads the verbatim source and renders it per agent at run time. condash's only generated top-level artefact is the `AGENTS.md` marker region (head regenerated, `## Specifics` tail preserved).

## Conception-path resolution

The skills resolve the conception path the same way the CLI does:

1. `--conception <path>` flag (when invoked with explicit args).
2. The `CONDASH_CONCEPTION` environment variable.
3. `lastConceptionPath` in `${XDG_CONFIG_HOME:-~/.config}/condash/settings.json`.
4. Walk-up from the current working directory looking for `.condash/settings.json` (or legacy `condash.json` / `configuration.json`) next to a `projects/` directory.

See [Environment variables](env.md) for the full list.

## What the skills do **not** do

| Not included | Why |
|---|---|
| Generate PDFs | Out of scope. Use [`scripts/md_to_pdf.sh`](https://github.com/vcoeur/condash/tree/main/scripts) or your own pipeline. |
| Move or archive items | Items live at `projects/YYYY-MM/YYYY-MM-DD-slug/` for life. Status flips, directories don't. |
| Edit `.condash/settings.json` | Use the dashboard's Settings modal or your editor. |
| Push to a remote without confirmation | The `/pr` skill always confirms before `git push`. |

## Related

- [Get started](../get-started/index.md) — install + first-launch + first project.
- [Guides — extending the skills](../guides/skill-extensions.md) — concrete extension patterns.
- [Mutation model](mutations.md) — the **dashboard's** mutation surface; disjoint from the skills'.
