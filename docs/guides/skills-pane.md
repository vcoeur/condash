# The Skills pane

The Skills pane sits alongside **Code**, **Knowledge**, and **Resources** in the right working-surface slot (`Ctrl+L` to switch in). It surfaces three trees through a single tab bar at the top of the pane — **Generic** (agent-neutral source skillspecs), **Claude** (compiled output for Claude Code), and **Kimi** (compiled output for Kimi CLI).

![Skills pane — skill sections with SKILL.md indices and body-file cards](../assets/screenshots/skills-pane-light.png#only-light)
![Skills pane — skill sections with SKILL.md indices and body-file cards](../assets/screenshots/skills-pane-dark.png#only-dark)

## The three tabs

| Tab | Reads from | Editable? | Notes |
|---|---|---|---|
| **Generic** | `<conception>/.agents/skills/` | Yes | Agent-neutral source — `.md` body files and `.yaml` spec / target overlays. |
| **Claude** | `<conception>/<skills_path>` (default `.claude/skills/`) | Yes (but see warning) | Compiled output. Edits here are overwritten on the next `condash skills install`. |
| **Kimi** | `<conception>/.kimi/skills/` | No | Compiled output. Always regenerated from source — buttons are hidden. |

The currently-selected tab is remembered per-machine in `settings.json` (`skillsActiveTab`), so the next launch reopens the same view. The first launch after the tabs ship defaults to **Claude** to match the pre-tabs behaviour.

Each tab maintains its own directory expansion state and scroll position. Switching tabs is paint-only — all three trees are loaded eagerly when a conception is opened.

## What each tab shows

### Generic (source skillspecs)

The Generic tab walks `.agents/skills/` and surfaces both `.md` and `.yaml` files:

- `body.md` and sibling markdown files (`index.md`, `retrieve.md`, …) render as standard cards. Title is pulled from the first H1.
- `spec.yaml` and `targets/<agent>.yaml` render as cards with a `YAML` badge — title falls back to the filename when no H1 is present (YAML has none).

The Generic tab does **not** inject the synthetic `CLAUDE.md` callout — that entry only makes sense in the Claude tab.

### Claude (compiled)

Identical to the pre-tabs Skills pane:

- Each subdirectory under `<skills_path>` is treated as a skill — its `SKILL.md` renders as a badged callout at the top of the expanded body.
- Body files render as cards underneath. The walker recurses to any depth.
- The conception's `<conception>/CLAUDE.md` and `<conception>/.claude/CLAUDE.md` are surfaced at the root with a `CLAUDE` badge.

### Kimi (compiled)

Same layout as Claude, but rooted at `.kimi/skills/` and without the synthetic `CLAUDE.md` injection (Kimi uses `AGENTS.md`, not `CLAUDE.md`). The tab is read-only: tree-mutation buttons are suppressed and the main-process resolver refuses to write under `.kimi/skills/`. Edit the matching source skillspec under `.agents/skills/` and re-run `condash skills install` to regenerate.

## Editing skills

Click any card to open the file in the note modal — the same editor used elsewhere in condash, with atomic-write save through `writeNote`. Wikilinks and relative markdown links route through the in-modal navigator just like Knowledge files.

The Generic tab is the right place to edit. Edits made through the Claude tab persist until the next `condash skills install`, at which point the compiled output is rebuilt from the matching source skillspec.

## Shipped-skill tracking

Each tree carries its own `.condash-skills.json` manifest, populated by `condash skills install`:

- `<conception>/.agents/.condash-skills.json` — source refuse-on-edit tracking (CLI internal).
- `<conception>/<skills_path>/.condash-skills.json` — Claude compiled tracking.
- `<conception>/.kimi/skills/.condash-skills.json` — Kimi compiled tracking.

The pane uses each manifest to flag two states on the matching tab:

- **shipped** — the on-disk content matches the version condash shipped. Cards display a `shipped` chip; the `SKILL` callout carries the same flag.
- **shipped · diverged** — the file is shipped but locally edited. Cards display an amber `shipped · diverged` chip; the `SKILL` callout switches to amber. Opening the file shows a banner: *"Shipped by condash, but locally edited. Running `condash skills install` will flag this divergence."*

The flags are informational only — local edits are never blocked. They exist so a quick scan tells you where your customisations are and warns you before an upstream re-install reverts them.

## Configuration

`skills_path` controls only the **Claude** tab's root directory. The Generic and Kimi tabs always read from `.agents/skills/` and `.kimi/skills/` respectively — those paths are not user-configurable.

Set the Claude tab's directory by editing `.condash/settings.json` at the conception root (per-tree, per-host), or via **Settings → Workspace → Skills directory**. The value lives on the tree side; the global `settings.json` carries only defaults.

```json
{
  "skills_path": ".claude/skills"
}
```

The value is relative to the conception root. Absolute paths and `..` segments are rejected by the schema.
