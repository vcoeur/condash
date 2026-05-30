# AGENTS.md — {{ conception_name }}

{{ description }}

## General

This `## General` section is shipped by condash and overwritten on every `condash skills install` — condash owns everything from the top of the file through the `<!-- end condash agents -->` marker. Per-conception content lives **below** the marker, in `## Specifics`, which condash never touches.

A conception is a Markdown tree condash manages: durable reference material under `knowledge/`, and dated work items (projects, incidents, documents) under `projects/`. Both trees are self-describing through their `index.md` files. condash is the single parser for the tree — drive every read and write through a skill or a `condash` verb, never by hand-scaffolding paths.

### Layout

- Tree roots: [`projects/index.md`](projects/index.md), [`knowledge/index.md`](knowledge/index.md).
- Skills (`.agents/skills/`): [`projects/`](.agents/skills/projects/SKILL.md) owns project / incident / document mutations, [`knowledge/`](.agents/skills/knowledge/SKILL.md) owns durable reference material, `pr/` opens pull requests, `applications/` owns the app registry. Read the skill before doing its kind of work.
- [`condash.json`](condash.json) — per-conception config overrides (legacy name: `configuration.json`). Read paths with `condash config get workspace_path` / `worktrees_path`; never hardcode `~/src/...`.

### Workflow

condash exists to make every piece of work a tracked project. This loop is the default for all non-trivial work; the `projects` skill carries the mechanics.

- **Open a project first.** Use `/projects` (or `condash projects create`) before starting — the README is the unit of tracking and the cold-recovery record.
- **Keep it current as you go.** Update status, steps, and a dated timeline entry on each event through `condash` / the `projects` skill — never by hand-editing tree paths.
- **`now → review → done`.** A project is `now` while active, `review` once work ships and awaits an external signal (for example a PR merge), `done` when that signal lands.

### Generated layers — never hand-edit

- **Skills** under `.agents/skills/` ship from condash and are refreshed by `condash skills install` (`projects`, `knowledge`, `pr`, `applications`). To change one, edit it in condash. A conception may add its own skills; condash leaves those alone.
- **Harness views** (`CLAUDE.md`, `.kimi/AGENTS.md`, …) are compiled from `AGENTS.md` at launch. Edit `AGENTS.md`; the views follow. Durable rules go in versioned files (`knowledge/` or `## Specifics`), never agent auto-memory.

<!-- end condash agents -->

## Specifics

Conception-specific content lives here, below the marker. condash never reads or rewrites it.
