# AGENTS.md — {{ conception_name }}

{{ description }}

## General

This `## General` section is shipped by condash and overwritten on every `condash skills install` — condash owns everything from the top of the file through the `<!-- end condash agents -->` marker. Per-conception content lives **below** the marker, in `## Specifics`, which condash never touches.

A conception is a Markdown tree condash manages: durable reference material under `knowledge/`, and dated work items (projects, incidents, documents) under `projects/`. Both trees are self-describing through their `index.md` files. condash is the single parser for the tree — drive every read and write through a skill or a `condash` verb, never by hand-scaffolding paths: no `mkdir`, no raw `Write`/`Edit` on tree-canonical paths, no raw `git worktree add`. The skill owns slug validation, enum checks, template generation, and index tracking; hand-scaffolding silently breaks the dashboard.

### Layout

- Tree roots: [`projects/index.md`](projects/index.md), [`knowledge/index.md`](knowledge/index.md).
- Skills — drive each kind of work through its slash command: `/projects` (project / incident / document mutations), `/knowledge` (durable reference material), `/pr` (pull requests), `/applications` (app registry). Invoking it loads the skill — don't open the file to use it.
- [`.condash/settings.json`](.condash/settings.json) — per-conception config overrides. Read paths with `condash config get workspace_path` / `worktrees_path`; never hardcode `~/src/...`.

### Workflow

condash exists to make every piece of work a tracked project. This loop is the default for all non-trivial work; the `projects` skill carries the mechanics.

- **Open a project first.** Use `/projects` (or `condash projects create`) before starting — the README is the unit of tracking and the cold-recovery record.
- **Keep it current as you go.** Update status, steps, and a dated timeline entry on each event through `condash` / the `projects` skill — never by hand-editing tree paths.
- **Code edits go in the project's worktree**, never the main repo checkout — set one up with `/projects worktree setup <branch>`, and edit a main checkout only when explicitly asked.
- **`now → review → done`.** A project is `now` while active, `review` once work ships and awaits an external signal (for example a PR merge), `done` when that signal lands.

### Committing

The **sweeper** — timer-driven `condash sync run` — is the conception's **only committer**. Parallel agent sessions share one `.git/index`, the `index.md` files are fan-in that no session owns, and concurrent pushes race — exactly one writer dissolves all three.

- **Agents never run `git` or any `condash sync` verb in the conception checkout.** Not to save a README, not to close an item. Write the files and stop; the sweeper takes them from there.
- **The sweeper** commits every settled, non-gitignored change — one commit per item, then `knowledge`, then everything outside the two trees (`AGENTS.md`, `.agents/`, config, `resources/`, …) as `meta`, then the regenerated indexes — and pushes. It skips any path written within the quiet period (default 90 s), so a live edit is never committed half-written. To keep a file out of `sync`, gitignore it.
- **Closing needs no commit either.** A sweep that introduces an item's `Closed.` timeline entry gets a synthesized `Close <slug>. Outcome: …` milestone subject instead of `<slug>: sync`. `condash sync commit <item> --message "<subject>"` remains a manual escape hatch for humans.
- **A repo worktree is a different tree.** `<worktrees_path>/<branch>/<repo>/` is not the conception — commit and push there as normal.

### Generated layers — never hand-edit

- **Skills** under `.agents/skills/` ship from condash and are refreshed by `condash skills install` (`projects`, `knowledge`, `pr`, `applications`). To change one, edit it in condash. A conception may add its own skills; condash leaves those alone.
- **Harness views** (`CLAUDE.md`, `.kimi/AGENTS.md`, …) are compiled from `AGENTS.md` at launch. Edit `AGENTS.md`; the views follow. Durable rules go in versioned files (`knowledge/` or `## Specifics`), never agent auto-memory.

<!-- end condash agents -->

## Specifics

Conception-specific content lives here, below the marker. condash never reads or rewrites it.

### Notes

Notes live in `notes/` as flat files: `NN-<descriptive-slug>.md` or `NN-<descriptive-slug>.mdx`. When a note needs supporting files, place them in `notes/NN-<slug>/` (directory named after the note without extension). Keep the item root flat: `README.md` is the only file allowed at the project folder root.
