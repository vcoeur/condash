# The Skills pane

The Skills pane sits alongside **Code**, **Knowledge**, and **Resources** in the right working-surface slot (`Ctrl+L` to switch in). It reads the project-local `.claude/skills/` tree (or whatever you point `skills_path` at) and lets you view and edit skill markdown without leaving the dashboard.

![Skills pane — skill sections with SKILL.md indices and body-file cards](../assets/screenshots/skills-pane-light.png#only-light)
![Skills pane — skill sections with SKILL.md indices and body-file cards](../assets/screenshots/skills-pane-dark.png#only-dark)

## What it shows

By default the pane reads from `<conception>/.claude/skills/`. Each directory under the root is treated as a skill — its `SKILL.md` is rendered as a badged callout at the top of the directory's expanded body (just below the directory header), and its body files (`create.md`, `update.md`, `index.md`, …) render as cards underneath. The walker recurses to any depth, so nested helper directories render as their own sections.

The pane also surfaces the conception's `CLAUDE.md` files — `<conception>/CLAUDE.md` and `<conception>/.claude/CLAUDE.md` — as top-level entries with a `CLAUDE` badge, alongside the regular skill directories. They open in the same note modal as everything else.

Only `.md` files are surfaced — non-markdown files in a skill directory are ignored.

## Editing skills

Click any card to open the file in the note modal — the same editor used elsewhere in condash, with atomic-write save through `writeNote`. Wikilinks and relative markdown links route through the in-modal navigator just like Knowledge files.

## Shipped-skill tracking

Skills installed by `condash-cli skills install` are tracked in `<skills_path>/.condash-skills.json`. The pane uses this manifest to flag two states:

- **shipped** — the on-disk content matches the version condash shipped. Cards display a `shipped` chip; the `SKILL` callout carries the same flag.
- **shipped · diverged** — the file is shipped but locally edited. Cards display an amber `shipped · diverged` chip; the `SKILL` callout switches to amber. Opening the file shows a banner: *"Shipped by condash, but locally edited. Running `condash-cli skills install` will flag this divergence."*

The flags are informational only — local edits are never blocked. They exist so a quick scan tells you where your customisations are and warns you before an upstream re-install reverts them.

## Configuration

Set the directory by editing `configuration.json` at the conception root (per-tree, versioned with the conception), or via **Settings → Workspace → Skills directory**. The value is **not** in `settings.json` — it's tree-side so teammates see the same skills tree.

```json
{
  "skills_path": ".claude/skills"
}
```

The value is relative to the conception root. Absolute paths and `..` segments are rejected by the schema.
