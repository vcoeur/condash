# AGENTS.md — {{ conception_name }}

{{ description }}

## General

This section is shipped by condash and refreshed by `condash skills install`. Edits to it are flagged on the next install. Per-conception content lives in `conception.md` (the `## Specifics` section below).

### Pointers

- Tree roots: [`projects/index.md`](projects/index.md), [`knowledge/index.md`](knowledge/index.md).
- Workflow skills: [`{{ skills_dir }}projects/SKILL.md`]({{ skills_dir }}projects/SKILL.md) drives every project / incident / document mutation; [`{{ skills_dir }}knowledge/SKILL.md`]({{ skills_dir }}knowledge/SKILL.md) drives durable reference material.
- Skill provenance: skills under `{{ skills_dir }}` are conception-scoped (not user-scoped). condash ships and refreshes a fixed set on `condash skills install` — `projects`, `knowledge`, `pr`, `skills`, `tidy`, sourced from `.agents/skills/<name>/` — so to change one of those, edit it in condash. A conception may also carry additional skills here that condash does **not** ship; condash leaves them untouched, and `## Specifics` records where they come from.
- [`condash.json`](condash.json) — per-conception overrides read by condash. Top-level keys here replace the matching keys in `~/.config/condash/settings.json`. Legacy filename `configuration.json` is still read as a fallback.
- Workspace paths: `condash config get workspace_path` (main app checkouts) and `condash config get worktrees_path` (PR worktrees) — read them rather than hardcoding `~/src/...`.

### Workflow

- **Autonomy**: when the next action is obvious from context, proceed — don't ask. Ask when the call is genuinely ambiguous or the action is hard to reverse. Terse prompts like "redo now", "close it", "ship" are explicit permission to run end-to-end without per-step confirmation.
- **Project READMEs are the cold-recovery contract**: as you work, flip the `## Steps` markers (`[ ]` `[~]` `[x]` `[!]`), append a dated `## Timeline` entry on each material event, and lift chat answers into `## Notes` — don't batch to the end. Full conventions in the `projects` skill.
- **Deliverables**: list an item's tangible outputs under `## Deliverables`, one bullet each — `- [label](file-or-URL) — comment` or `- [[slug]] — comment`. They surface on the project card and condash's Deliverables pane. Full spec in the `projects` skill.
- **Durable rules** go in versioned files — `knowledge/` and `conception.md` — never agent auto-memory.
