---
title: Extend the management skills · condash guide
description: How to fork or wrap the shipped /projects, /knowledge, /tidy, /skills, /pr Claude Code skills with team-specific behaviour.
---

# Extend the management skills

> **Audience.** Daily user and Developer.

**When to read this.** You ran `condash skills install` to drop the shipped skills into `<conception>/.agents/skills/`, used them for a week, and hit "I wish this also did X". This page shows how to add team-specific behaviour without losing access to upstream updates.

The shipped skills are intentionally minimal — they cover the conception convention itself, not your team's workflow on top of it. Two extension paths exist; pick whichever matches your update cadence.

For the base reference (every action, every CLI verb each one wraps), see [the management skills reference](../reference/skill.md).

## Where the skills live

```bash
# After running `condash skills install`
<conception>/.agents/skills/projects/
<conception>/.agents/skills/knowledge/
<conception>/.agents/skills/tidy/
<conception>/.agents/skills/skills/
<conception>/.agents/skills/pr/
```

Each directory contains a `SKILL.md` (the entry point) plus per-action detail files (e.g. `create.md`, `close.md` for `/projects`) and, where a harness needs its own frontmatter, an optional `SKILL.<harness>.md` overlay (e.g. `SKILL.claude.md`). The sources are placed verbatim — the harness launcher renders them per agent at run time.

The manifest at `<conception>/.agents/.condash-skills.json` tracks the shipped version + SHA256 per file. `condash skills install` walks the diff one file at a time and asks for confirmation when local content differs — your customisations don't get clobbered silently.

## Path 1 — fork the shipped files

The simplest extension: edit the file in place. Add a section to `SKILL.md`, change a step in `create.md`, override a default flag in `close.md`. Next `condash skills install` will detect the drift, show you the diff, and ask whether to overwrite — answer "no" to keep your local copy.

This is the right path when:

- The change is small (a few lines).
- The change is universally appropriate for your team.
- You're willing to manually re-merge upstream changes once or twice a year.

It is the wrong path when the change is large or speculative — those go in path 2.

## Path 2 — wrap with a custom skill

Write a separate `/my-team-projects` (or whatever name) skill that runs your extra logic and then delegates to the shipped one. Example shape:

```markdown
# /my-team-projects — wrapper

Trigger: `/my-team-projects <action> [args]`

When invoked, run the team-specific pre-step (below), then dispatch to the shipped `/projects` skill for the base operation.

## Action: create

1. Ask the user the standard fields plus the team-specific `**Linear ID**:` header.
2. Run `/projects create` with the gathered fields.
3. After creation, append the Linear ID line to the README header, between `apps` and `## Goal`.
4. Open the matching Linear ticket in the browser via `condash openExternal`.
```

This keeps upstream `/projects` updates painless: the shipped skill evolves without touching your wrapper.

It is the right path when:

- The change is large or has side effects (creating tickets, posting Slack, generating PDFs).
- The change is project-specific (you don't want it loaded in every conception).
- You want to share the wrapper as a separate package or repo.

## Worked extensions

The patterns below are realistic shapes — copy and adapt to your tree.

### Branch isolation on create

**Problem.** Your projects-that-touch-code need to work in a git worktree, not the main checkout. The shipped `/projects create` writes the README and stops; you want it to also scaffold the worktree when the item declares a `branch`.

**Wrapper sketch.** After `/projects create` returns:

```bash
condash worktrees setup <branch> --copy-env
```

Run it only when the new item has a `branch` field. The shipped `/projects create` already prompts for it; the wrapper just observes the result and runs the setup command. `condash worktrees setup` itself is the canonical path — it knows where worktrees live (the `worktrees_path` key in `.condash/settings.json`), runs the per-repo `install:` hook by default, and copies env files from the main checkout when `--copy-env` is set.

### Deliverable generation on close

**Problem.** When a `document` kind item closes, you want the deliverable PDF regenerated from the latest notes without anyone remembering.

**Wrapper sketch.** Override the `close` action: before calling `/projects close`, locate the canonical note (look for a `## Deliverables` line pointing at a `.md` source, or fall back to the longest note body) and run your `md_to_pdf` pipeline. Verify the output is non-empty, then delegate to `/projects close`. Fail loudly if the PDF generation fails — a stale deliverable in a `done` item is worse than an item stuck in `review`.

This pattern only fits `document`-kind items; `project` and `incident` items rarely have a single canonical deliverable.

### Notes index on add-note

**Problem.** Items accumulate notes. Without an index, the only way to discover what's in the `notes/` folder is the Files panel.

**Wrapper sketch.** After creating a note (the shipped `/projects` skill does this via `condash`'s `createProjectNote` IPC verb), edit the README:

1. Locate `## Notes`. If absent, append one before `## Timeline`.
2. Add a bullet `- [filename](notes/filename.md) — <first 80 chars of body>`.
3. Keep bullets in alphabetical order; update existing bullets in place rather than duplicating.

Don't touch hand-written bullets for other files — only manage the bullet for the file you just created.

## Why not ship these by default

Each pattern assumes something the conception convention itself doesn't:

- Branch isolation assumes you have a `worktrees_path` configured and that `branch` is part of your workflow.
- Deliverable generation assumes a specific `md_to_pdf` pipeline is available and that `document` items have a canonical note.
- Notes index assumes the README has a `## Notes` section and that notes have first-paragraph summaries.

None of these are universal. The shipped skills stay at the intersection of what every conception tree needs; team-specific conventions are one fork (or one wrapper) away.

## Reference

- [Management skills reference](../reference/skill.md) — every shipped action and the CLI verb it wraps.
- [Get started — your first project](../get-started/index.md#your-first-project) — the skills in use end to end.
- [CLI reference](../reference/cli.md) — every CLI verb a skill could shell out to.
