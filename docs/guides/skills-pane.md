# The Skills pane

The Skills pane sits alongside **Code**, **Knowledge**, and **Resources** in the right working-surface slot. It reads the project-local `.claude/skills/` tree (or whatever you point `skills_path` at) and lets you view and edit skill markdown without leaving the dashboard.

## What it shows

By default the pane reads from `<conception>/.claude/skills/`. Each directory under the root is treated as a skill — its `SKILL.md` is highlighted as the section index, and its body files (`create.md`, `update.md`, `index.md`, …) render as cards inside that section. The walker recurses to any depth, so nested helper directories render as their own sections.

Only `.md` files are surfaced — non-markdown files in a skill directory are ignored.

## Editing skills

Click any card to open the file in the note modal — the same editor used elsewhere in condash, with atomic-write save through `writeNote`. Wikilinks and relative markdown links route through the in-modal navigator just like Knowledge files.

## Shipped-skill tracking

Skills installed by `condash skills install` are tracked in `<skills_path>/.condash-skills.json`. The pane uses this manifest to flag two states:

- **shipped** — the on-disk content matches the version condash shipped. Cards display a `shipped` chip; `SKILL.md` carries the same flag on its section badge.
- **shipped · diverged** — the file is shipped but locally edited. Cards display an amber `shipped · diverged` chip; the section badge for `SKILL.md` switches to amber. Opening the file shows a banner: *"Shipped by condash, but locally edited. Running `condash skills install` will flag this divergence."*

The flags are informational only — local edits are never blocked. They exist so a quick scan tells you where your customisations are and warns you before an upstream re-install reverts them.

## Configuration

Set the directory by editing `configuration.json` at the conception root, or via **Settings → Workspace → Skills directory**.

```json
{
  "skills_path": ".claude/skills"
}
```

The value is relative to the conception root. Absolute paths and `..` segments are rejected by the schema.
