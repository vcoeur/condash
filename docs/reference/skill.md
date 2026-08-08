---
title: Management skills · condash reference
description: Reference for the five shipped skills for AI coding agents — /projects, /knowledge, /pr, /applications, /visual — and how they shell out to the condash CLI.
---

# Management skills

> **Audience.** Daily user.

## At a glance

condash ships five skills for AI coding agents, in the [Claude Code](https://docs.claude.com/en/docs/claude-code/) SKILL.md format. They live under [`conception-template/.agents/skills/`](https://github.com/vcoeur/condash/tree/main/conception-template/.agents/skills) in the repo and land at `<conception>/.agents/skills/` after running `condash skills install`. Each skill is placed verbatim — `SKILL.md` plus any task `.md` files and an optional `SKILL.<harness>.md` overlay. condash does not compile them to per-harness directories; the [harness launcher](#the-harness-launcher-agedum) renders them per agent at run time.

| Skill | Scope | What it does |
|---|---|---|
| **`/projects`** | items + worktrees | Create / read / update / close projects, incidents, and documents. Manage worktrees per branch. |
| **`/knowledge`** | knowledge tree | Retrieve, update, index, and verify durable reference material in `<conception>/knowledge/`. Audits (orphans, dangling links, cross-repo refs, worktree drift, LFS coverage, large binaries, stale stamps) flow through `verify`. |
| **`/pr`** | git | Open a GitHub PR from the current branch with the project README's timeline-append rule applied. |
| **`/applications`** | app registry | Manage the `#handle` app registry (list / add / set / rename / sync-docs / validate) — the single source of truth for how apps are referenced across the tree. |
| **`/visual`** | visual notes (`.mdx`) | Author MDX documents of typed blocks — wireframes, diagrams, data models, API contracts, annotated diffs, question forms — that render in the in-app viewer. One skill, four postures set by frontmatter `kind`: **design**, **plan**, **review**, **note**. Owns the block vocabulary and wraps [`condash mdx`](cli.md#mdx). |

The skills are **editorial only**. Every mechanical step shells out to `condash`, so the dashboard, the CLI, and the skills always see the same canonical view of the tree. A skill never re-implements parsing or validation in `bash + grep + sed`.

The pre-reframe `/tidy` and `/skills` skills were dropped: tidy's audits are now reachable from `/knowledge verify` (which wraps `condash audit` + `condash knowledge verify`), and `/skills` was a thin wrapper over `condash skills install` — call the CLI directly.

`condash skills list`, `status`, and `install` track only the five shipped skills. A conception-local skill — a hand-written `.agents/skills/<name>/SKILL.md` that condash doesn't ship — is not tracked and never appears in `skills list` / `status`; it still works as a slash-command skill and shows in the Skills pane.

## How the pieces fit

A new user's first question is usually "I installed the skills — how do I actually use `/projects` in my agent?" The answer is one end-to-end chain, and every link has its own page:

- The **app** — the dashboard — *renders* the tree. It reads the Markdown on disk and shows it as cards and panes; its write surface is deliberately tiny ([mutation model](mutations.md)).
- The **`condash` CLI** *mutates* the tree — every create, update, close, index, and sync is a command against the same files ([CLI](cli.md)).
- The five **skills** are agent-facing wrappers over the CLI. Each is "editorial only": it decides what the agent should do and shells out to `condash` for every mechanical step, so the app, the CLI, and the skills always see the same canonical view ([extend them](../guides/skill-extensions.md)).
- The **harness launcher** turns each skill's source into a slash-command in an agent session — [the harness launcher (agedum)](#the-harness-launcher-agedum) below.
- The **sweeper** (`condash sync run`) is the only git writer: one process commits settled changes and pushes, so parallel agent sessions never race the shared index ([values](../explanation/values.md) · [auto-commit](../guides/auto-commit.md)).

```
              ┌───────────────┐
              │   the tree    │   the Markdown: projects/, knowledge/, …
              └───────┬───────┘
                      │  rendered by the app (dashboard) — reads only
                      │  mutated by the condash CLI — every mechanical step
              ┌───────┴───────┐
              │  five skills  │   agent-facing wrappers over the CLI
              └───────┬───────┘
                      │  rendered as slash-commands by
              ┌───────┴───────┐
              │  harness      │
              │  launcher     │
              │  (agedum)     │
              └───────────────┘

The sweeper (`condash sync run`) is the only git writer — it commits
and pushes the tree; every other piece leaves git alone.
```

### The harness launcher (agedum)

**agedum** is the harness launcher: the separate tool — shipped independently of condash, never part of its bundle — that compiles each app's skills into agent-specific slash-commands at launch. condash only surfaces agedum's sources (the `.agents/skills/` and `~/.config/agents/skills/` trees it installs and the Skills pane displays read-only); it never compiles or rewrites them. If you don't use an AI coding agent, you don't need agedum at all — the app and the CLI stand alone.

## Which skill should I use?

| Task | Slash command | Guide |
|---|---|---|
| Manage projects, incidents, documents + worktrees | `/projects` | [Guides index](../guides/index.md) · [worktrees tutorial](../tutorials/worktrees.md) |
| Durable reference notes in `knowledge/` | `/knowledge` | [The knowledge tree](../guides/knowledge-tree.md) |
| App identity / `#handle` registry | `/applications` | [Applications and handles](../guides/applications-and-handles.md) |
| Open a PR | `/pr` | your `/git pr` rules (body shape — [the `/pr` section](#pr)) |
| Visual notes (`.mdx` plans / reviews / designs) | `/visual` | [Visual notes (plans, reviews, designs)](../guides/plan-documents.md) |

Two *tooling* surfaces sit beside the slash commands: the **Skills pane** (a read-only viewer of everything under `.agents/skills/`) and the CLI (`condash skills install` / `status` / `validate`). The pane is for browsing; the CLI installs, reports install state, and lints.

## `/projects`

Manage items in `projects/YYYY-MM/YYYY-MM-DD-slug/`. The skill drives the matching CLI verbs through `condash projects ...`.

| Action | Trigger | Wraps |
|---|---|---|
| `list` | `/projects list [kind=…] [status=…] [apps=…] [branch=…] [parent=…]` | `condash projects list` |
| `read` | `/projects read <slug>` | `condash projects read` |
| `search` | `/projects search <keyword>` | `condash projects search` |
| `validate` | `/projects validate [<slug>]` | `condash projects validate` |
| `create` | `/projects create <kind>` (project / incident / document) | `condash projects create` |
| `update` | `/projects update <slug>` | direct file edits, drift-checked |
| `close` | `/projects close <slug>` | `condash projects close` |
| `check-knowledge` | `/projects check-knowledge <slug>` — signal; `--record` after a real review | `condash projects check-knowledge` |
| `reopen` | `/projects reopen <slug>` | `condash projects reopen` |
| `index` | `/projects index` | `condash projects index` |
| `worktree` | `/projects worktree {setup\|remove\|check\|list\|status} [branch]` | `condash worktrees …` |

The `create` action enforces the canonical kind templates and the `^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$` slug regex, and carries `--branch` / `--base` / `--parent` through to the header ([`parent` links a spin-off to its plan](readme-format.md#parent-subprojects)). The `close` action appends the `Closed.` timeline entry then records the dated `Checked knowledge promotion` marker; `reopen` appends `Reopened.`. Both take an optional `--summary` appended to that entry, which lands in its bare form when the flag is omitted. `check-knowledge` is the standalone recorder for that marker (`--record`, after a real `/knowledge` review) — the date and format are always written by condash, never hand-typed. There is no mass/backfill writer: a done project gets the marker only once it has actually been reviewed.

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

## `/visual`

Author a **visual note**: Markdown prose interleaved with capitalised JSX-like block tags whose props are static JSON literals (`<Diff>`, `<DataModel>`, `<WireframeBlock>`, `<QuestionForm>`, …). condash renders it natively — there is no hosted service and nothing leaves the machine.

| Action | Trigger | Wraps |
|---|---|---|
| author | "visual note / plan / design / review" | direct file edits |
| validate | before handing the document over | `condash mdx check <path>` |
| vocabulary | "what blocks are there?" | `condash mdx blocks` |

The frontmatter `kind` picks the posture: a **design** explores directions, a **plan** is the approval gate before code, a **review** is built from a landed diff, and a plain **note** is for anything a visual layout serves better than prose. The skill ships its own `blocks.md`, `wireframe.md`, `document-quality.md`, `exemplar.md`, and `review.md` alongside `SKILL.md`.

The parser, the zod schemas, the in-app viewer, and `condash mdx check` are one code path, so a green check means the document matches the viewer by construction. See the [visual notes guide](../guides/plan-documents.md).

## Install

```bash
# Once per conception, after first install
condash skills install

# After upgrading condash (walks the diff for files you may have edited)
condash skills install
```

The skill sources land at `<conception>/.agents/skills/`. With a [harness launcher](#the-harness-launcher-agedum) set up to render them, all five become available in a session.

`condash skills install` writes one file at a time and is **non-interactive** — there is no prompt and no yes/no. When local content differs from the shipped version it **refuses** that file and exits **3** with `N item(s) refused (locally edited). Re-run with --force to overwrite or --diff to inspect.`, so your customisations don't get clobbered silently. It records what it shipped in one manifest at `<conception>/.agents/.condash-skills.json` (v3 schema: a `skills.<name>` namespace for skill sources plus a `files.<path>` namespace retained for legacy entries; condash ≤ 4.0.1 shipped a region-delimited `.gitignore` and no longer ships any top-level file). Each tracked file carries its shipped version + SHA256, so a re-install can tell an unchanged file from a locally-edited one and refuse to clobber edits without `--force`. `AGENTS.md` is **not** manifest-tracked — its marker line is the boundary, so there's no hash to reconcile.

### The skill source is committed; nothing is compiled

The `.agents/skills/` source tree is the committed, canonical copy of each skill. condash no longer produces any per-harness compiled output and no compiled instruction files. The [harness launcher](#the-harness-launcher-agedum) (shipped separately) reads the verbatim source and renders it per agent at run time. condash's only generated top-level artefact is the `AGENTS.md` marker region (head regenerated, `## Specifics` tail preserved).

## Conception-path resolution

The skills resolve the conception path the same way the CLI does, because they *are* the CLI — every step below is [`condash`'s own chain](cli.md#conception-path-resolution):

1. `--conception <path>` flag (when invoked with explicit args).
2. `CONDASH_CONCEPTION_PATH` (legacy alias `CONDASH_CONCEPTION` still accepted).
3. `CLAUDE_PROJECT_DIR` — the variable a Claude Code session already sets, which is why a skill invoked from inside a conception checkout usually needs no configuration at all.
4. Walk-up from the current working directory looking for `.condash/settings.json` (or legacy `condash.json` / `configuration.json`) next to a `projects/` directory.
5. `lastConceptionPath` in `${XDG_CONFIG_HOME:-~/.config}/condash/settings.json`.
6. Hard error (exit 5), listing every candidate it tried.

The cwd walk-up comes **before** `lastConceptionPath`, so running a skill inside one conception never silently targets the one the GUI happens to have open. See [Environment variables](env.md) for the full list.

## What the skills do **not** do

| Not included | Why |
|---|---|
| Generate PDFs | Out of scope — condash ships no conversion script. Use your own pandoc pipeline, or the dashboard's **Export as PDF** button in the note viewer. |
| Move or archive items | Items live at `projects/YYYY-MM/YYYY-MM-DD-slug/` for life. Status flips, directories don't. |
| Edit `.condash/settings.json` | Use the dashboard's Settings modal or your editor. |
| Push to a remote without confirmation | The `/pr` skill always confirms before `git push`. |

## Related

- [Get started](../get-started/index.md) — install + first-launch + first project.
- [Guides — extending the skills](../guides/skill-extensions.md) — concrete extension patterns.
- [Mutation model](mutations.md) — the **dashboard's** mutation surface; disjoint from the skills'.
