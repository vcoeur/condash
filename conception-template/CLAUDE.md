# CLAUDE.md — conception

A **systems documentation tree**, not a code project. Everything here is Markdown — there is nothing to run.

## General

This section is shipped by condash and refreshed by `condash-cli templates install`. Edits to it are flagged on the next install. Per-conception content goes under `## Specifics` below.

### Pointers

- `/projects` — items + worktrees. Canonical rules: [`projects/SKILL.md`](.claude/skills/projects/SKILL.md).
- `/knowledge` — durable reference material. Canonical rules: [`knowledge/SKILL.md`](.claude/skills/knowledge/SKILL.md).
- `/pr` — project-aware GitHub PR opener. Canonical rules: [`pr/SKILL.md`](.claude/skills/pr/SKILL.md).
- `/skills` — pull condash-shipped skill updates. Canonical rules: [`skills/SKILL.md`](.claude/skills/skills/SKILL.md).
- Tree roots: [`projects/index.md`](projects/index.md), [`knowledge/index.md`](knowledge/index.md).
- [`condash.json`](condash.json) — per-conception overrides read by condash. Top-level keys here replace the matching keys in `~/.config/condash/settings.json`. Legacy filename `configuration.json` is still read as a fallback.

### Workflow

- **Autonomy**: when the next action is obvious from context, proceed — don't ask. Ask when the call is genuinely ambiguous or the action is hard to reverse. Terse prompts like "redo now", "close it", "ship" are explicit permission to run end-to-end without per-step confirmation.
- **Auto-memory opt-out**: this tree does not use the harness auto-memory. Durable team rules go under `## Specifics` below; durable reference material lives under [`knowledge/`](knowledge/index.md). Never write to `~/.claude/projects/<encoded-path>/memory/` for this tree.
- **"Doesn't work" reports**: ask one clarifying question about the actual symptom before editing — especially before touching shared infrastructure (skill files, settings, hook scripts). Search `## Specifics` and `knowledge/` for keywords from the report first.

### What `## Specifics` should contain

`## Specifics` is per-conception — user-owned, never touched by `condash-cli templates install`. Open it with the **Apps** table; everything below the table is durable team rules and workspace facts.

#### Apps table — the always-in-context list of apps

One row per app this conception covers. Columns:

| Column        | Meaning                                                                                                                                                                                                                                       |
|---------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **App**       | Logical name prefixed with `@` (e.g. `@alicepeintures.com`). The slug used in cross-references everywhere — knowledge files, project notes, skill docs. Pick once per app, lower-case, kebab-or-dot, matching the repo basename when possible. |
| **Purpose**   | One line in plain English — what the app *is*. Lets a reader skim "what's in this conception" without opening anything.                                                                                                                       |
| **Repo**      | Absolute path on this host (e.g. `~/src/<workspace>/<repo>`).                                                                                                                                                                                 |
| **CLAUDE.md** | Path to the app's own CLAUDE.md. Usually `<repo>/CLAUDE.md`; spell it out when it lives elsewhere.                                                                                                                                            |
| **Knowledge** | Path to the per-app knowledge entry-point in this conception (e.g. `knowledge/internal/<slug>.md`). The entry point is where deep details live — CLAUDE.md is the navigation layer.                                                           |

Keep the table tight: navigation fields only. Operational config (formatter, port, base branch, …) belongs in `condash.json`, not here.

#### Submodules — subpath by default, promote when warranted

A submodule (or any sub-repo / sub-package within a parent app) is reachable as `@<parent>/<submodule>/<path>` by default — one row in the table for the parent, submodules treated as internal structure. Promote a submodule to its own row when it earns the navigation cost: it has its own `CLAUDE.md`, its own `knowledge/internal/*.md` entry, or it's worked on in independent PR cycles.

Naming for promoted submodules: bare `@<sub>` when the basename is unique workspace-wide; dotted `@<parent>.<sub>` (e.g. `@PaintingManager.app`) when the bare slug would collide with another app or another submodule.

`condash.json`'s `submodules:` block is orthogonal — that block lists runnable targets for the dashboard (what `make dev` to invoke, what to force-stop). The Apps table is the human / agent navigation index. They can disagree without harm; align by intent, not by mirroring.

#### Cross-references via `@<app>/<path>`

Knowledge entries, project notes, and rule bodies refer to source code as `@<app>/<path-in-repo>` (e.g. `@<app>/src/server.ts:42`) instead of `~/src/<workspace>/<app>/...`. The `@` prefix makes references grep-friendly and decouples prose from any one host's filesystem layout — the Apps table is the only place the absolute path appears.

When in doubt: an `@<name>/...` token is *always* an app reference; a path with no leading `@` is a path inside *this* conception (`projects/...`, `knowledge/...`, `condash.json`).

#### Rules

After the Apps table, add durable team rules — anything an agent should always know about this workspace. Each rule:

- Lives under a `### <imperative title>` heading.
- Has body bullets describing *what to do*.
- Carries one **Why:** sentence explaining the rationale (so an agent can judge edge cases).
- Optionally a **How to apply:** sentence for when the rule kicks in.

Group rules under `### ` topical headings (e.g. `### Repo workflow`, `### Legal / privacy`) when the file gets long. Stable by design — no verification stamps; rules either live or get deleted.

## Specifics

The general section above is shipped by condash and applies to every conception. Add rules below that are specific to this conception. Start with the **Apps** table (one row per app — see the schema in `## General`), then add durable rules grouped under `### ` headings.

| App                  | Purpose                       | Repo                                | CLAUDE.md              | Knowledge                          |
|----------------------|-------------------------------|-------------------------------------|------------------------|------------------------------------|
| _(populate per-app)_ | _(one line of plain English)_ | _(`~/src/<workspace>/<repo>`)_      | _(`<repo>/CLAUDE.md`)_ | _(`knowledge/internal/<slug>.md`)_ |
