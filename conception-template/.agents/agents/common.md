# AGENTS.md — conception

A **systems documentation tree**, not a code project. Everything here is Markdown — there is nothing to run.

## General

This section is shipped by condash and refreshed by `condash skills install`. Edits to it are flagged on the next install. Per-conception content goes under `## Specifics` below.

### Pointers

- Tree roots: [`projects/index.md`](projects/index.md), [`knowledge/index.md`](knowledge/index.md).
- Workflow skills: [`{{ skills_dir }}projects/SKILL.md`]({{ skills_dir }}projects/SKILL.md) drives every project / incident / document mutation; [`{{ skills_dir }}knowledge/SKILL.md`]({{ skills_dir }}knowledge/SKILL.md) drives durable reference material.
- [`condash.json`](condash.json) — per-conception overrides read by condash. Top-level keys here replace the matching keys in `~/.config/condash/settings.json`. Legacy filename `configuration.json` is still read as a fallback.

### Workflow

- **Autonomy**: when the next action is obvious from context, proceed — don't ask. Ask when the call is genuinely ambiguous or the action is hard to reverse. Terse prompts like "redo now", "close it", "ship" are explicit permission to run end-to-end without per-step confirmation.
- **Keep the project README live as you work**: every project under `projects/YYYY-MM/<slug>/` is the cold-recovery contract. The moment you start, finish, partially complete, or get blocked on a `## Steps` item, flip its marker (`[ ]` `[~]` `[x]` `[!]`); append a one-line dated timeline entry on each material event (decision, PR opened, blocker found); lift inline user answers from chat into `## Notes` or `notes/NN-…md`. Goal: if this session crashes or is interrupted right now, the next reader answers "what shipped, what's left, what's blocking" from the README alone. Don't batch updates to the end of a pass.

## Specifics

The general section above is shipped by condash and applies to every conception. Add rules below that are specific to this conception. Start with the **Apps** table (one row per app: App · Purpose · Repo · Config · Knowledge), then add durable rules grouped under `### ` headings. Full style guide: <https://condash.vcoeur.com/reference/agents-md-style/>.

| App                  | Purpose                       | Repo                                | Config                       | Knowledge                          |
|----------------------|-------------------------------|-------------------------------------|------------------------------|------------------------------------|
| _(populate per-app)_ | _(one line of plain English)_ | _(`~/src/<workspace>/<repo>`)_      | _(`<repo>/{{ agent_config }}`)_ | _(`knowledge/internal/<slug>.md`)_ |
