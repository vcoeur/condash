---
title: Management skills · condash reference
description: Reference for the five shipped Claude Code skills — /projects, /knowledge, /tidy, /skills, /pr — and how they shell out to the condash CLI.
---

# Management skills

> **Audience.** Daily user.

## At a glance

condash ships five [Claude Code](https://docs.claude.com/en/docs/claude-code/) skills. They live under [`conception-template/.agents/skills/`](https://github.com/vcoeur/condash/tree/main/conception-template/.agents/skills) in the repo and land at `<conception>/.agents/skills/` after running `condash skills install` (or `/skills install` from a session). Each skill is placed verbatim — `SKILL.md` plus any task `.md` files and an optional `SKILL.<harness>.md` overlay. condash does not compile them to per-harness directories; the harness launcher renders them per agent at run time.

| Skill | Scope | What it does |
|---|---|---|
| **`/projects`** | items + worktrees | Create / read / update / close projects, incidents, and documents. Manage worktrees per branch. |
| **`/knowledge`** | knowledge tree | Retrieve, update, index, and verify durable reference material in `<conception>/knowledge/`. |
| **`/tidy`** | health | Run every audit + verify stamp check, batch the auto-fixable ones into one confirmation, surface the rest as a punch-list. |
| **`/skills`** | meta | Install or update the shipped skills themselves — wraps `condash skills install`. |
| **`/pr`** | git | Open a GitHub PR from the current branch with the project README's timeline-append rule applied. |

The skills are **editorial only**. Every mechanical step shells out to `condash`, so the dashboard, the CLI, and the skills always see the same canonical view of the tree. A skill never re-implements parsing or validation in `bash + grep + sed`.

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
| `reopen` | `/projects reopen <slug>` | `condash projects reopen` |
| `index` | `/projects index` | `condash projects index` |
| `worktree` | `/projects worktree {setup\|remove\|check\|list\|status} [branch]` | `condash worktrees …` |

The `create` action enforces the canonical kind templates and the `^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$` slug regex. The `close` action appends the `Closed.` timeline entry; `reopen` appends `Reopened.`.

## `/knowledge`

Manage durable reference material in `<conception>/knowledge/`.

| Action | Trigger | Wraps |
|---|---|---|
| `retrieve` | `/knowledge retrieve <query>` — triage walk (`triage` / `grep` / `both`) | `condash knowledge retrieve` |
| `update` | `/knowledge update <path>` — add or edit a body file with citation + verification stamp | direct file edits + `condash knowledge stamp` |
| `index` | `/knowledge index` — regenerate every `knowledge/**/index.md` | `condash knowledge index` |
| `verify` | `/knowledge verify` — audit stale `**Verified:** YYYY-MM-DD` stamps + tree audits | `condash knowledge verify` |

Every body file carries a `**Verified:** YYYY-MM-DD` stamp; `verify` flags ones older than the freshness threshold.

## `/tidy`

Run every audit and verification check the CLI knows about, batch the safely auto-fixable issues into a single confirmation, and surface the rest as a punch-list.

| Action | Trigger | Wraps |
|---|---|---|
| (default) | `/tidy [check=<list>] [dry-run]` | `condash audit --include all --json` and `condash knowledge verify --json` |

The skill never auto-bumps `**Verified:**` stamps (a stale stamp means "human re-reads the source") and never auto-deletes cross-repo references — instead it searches for likely-renamed targets and proposes a redirect when there's a single candidate. Every other auto-fix (LFS track, worktree setup, dangling-index-line removal, `knowledge index` regen) goes through one `AskUserQuestion` round before applying.

Each issue carries a `fix.action` symbol and a `fix.autoFix: bool` flag — the skill reads `autoFix` directly rather than deriving fixability from check names.

## `/skills`

Install or refresh the shipped skills. Use it after upgrading condash to pull updated skill content while keeping local edits.

| Action | Trigger | Wraps |
|---|---|---|
| `status` | `/skills status` | `condash skills status` (compare local vs shipped via SHA256) |
| `install` | `/skills install` | `condash skills install` (per-file diff + confirmation walk) |

`condash skills install` records what it shipped in one manifest at `<conception>/.agents/.condash-skills.json` (v3 schema: a `skills.<name>` namespace for skill sources plus a `files.<path>` namespace for the region-delimited `.gitignore`). Each tracked file carries its shipped version + SHA256, so a re-install can tell an unchanged file from a locally-edited one and refuse to clobber edits without `--force`. `AGENTS.md` is **not** manifest-tracked — its marker line is the boundary, so there's no hash to reconcile.

### The skill source is committed; nothing is compiled

The `.agents/skills/` source tree is the committed, canonical copy of each skill. condash no longer produces any per-harness compiled output — there are no `.claude/skills/`, `.kimi/skills/`, or `.opencode/skills/` directories to regenerate, and no compiled instruction files (`.claude/CLAUDE.md`, `.kimi/AGENTS.md`, `.opencode/AGENTS.md`). The harness launcher (shipped separately) reads the verbatim source and renders it per agent at run time. condash's only generated top-level artefact is the `AGENTS.md` marker region (head regenerated, `## Specifics` tail preserved).

## `/pr`

Open a GitHub PR from the current branch with condash's standard PR shape: title stating the objective, a short Summary, a Changes list, and the optional Impact / Watchpoints sections when relevant. Project-level wrappers (e.g. conception's `/pr`) defer body shape to this skill — read it before drafting.

## Install

```bash
# Once per conception, after first install
condash skills install

# After upgrading condash (walks the diff for files you may have edited)
condash skills install
```

The skill sources land at `<conception>/.agents/skills/`. With a harness launcher set up to render them, `/projects`, `/knowledge`, `/tidy`, `/skills`, `/pr` become available in a session.

`condash skills install` writes one file at a time and asks for confirmation per file when local content differs from the shipped version — your customisations don't get clobbered silently.

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
