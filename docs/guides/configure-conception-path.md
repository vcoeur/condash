---
title: Configure the conception path · condash guide
description: Point condash at the directory it should render — persistently or by hand-editing settings.json.
---

# Configure the conception path

> **Audience.** New user and Daily user.

**When to read this.** You want condash to render a tree other than the one it's using now, or you want to know all the ways that path can be set.

The conception path is the only piece of configuration condash needs before it can start. Everything else has a sensible default.

## Option 1 — first-launch folder picker

On first launch with no tree configured, condash opens a native folder picker. Pick the directory containing your `projects/` + (optional) `.condash/settings.json` and condash writes the choice to `${XDG_CONFIG_HOME:-~/.config}/condash/settings.json` (or the platform equivalent — see [Config files](../reference/config.md#at-a-glance)). Subsequent launches reuse the saved path automatically.

This is the right setup for your main tree — the path you work in every day.

## Option 2 — File → Open…

After the first launch, **File → Open…** (shortcut `Ctrl+O`) reopens the same native folder picker. Pick a different directory and condash reloads against it without restarting; the new path is written to `settings.json`. This is the friendly way to switch between two trees you both use regularly.

### File → Open Recent

Once you have opened more than one tree, **File → Open Recent** carries a live submenu of the trees you've used, each labelled `<basename> — <parent path>` so two trees with the same directory name stay distinguishable. The currently open one is check-marked. A **Clear menu** entry at the bottom empties the list.

The same list is surfaced inside the app as the **Recent conceptions** section at the top of the Settings modal. It's backed by `recentConceptionPaths` in the per-machine `settings.json` — the app maintains it for you; it has no editable form fields.

## Option 3 — edit `settings.json` by hand

Change the saved path without re-launching the picker by editing `${XDG_CONFIG_HOME:-~/.config}/condash/settings.json` directly:

```json
{
  "lastConceptionPath": "/home/you/another-tree"
}
```

Delete the file to force the folder picker on the next launch.

## Option 4 — `CONDASH_CONCEPTION_PATH` for a one-off

A session-scoped override:

```bash
CONDASH_CONCEPTION_PATH=/tmp/scratch-tree condash
```

The env var wins over `settings.json` for that launch only. It is **not** persisted, so the next plain `condash` falls back to the saved path. Useful for demos and scratch trees.

## Resolution order

On startup condash checks, in order:

1. `CONDASH_CONCEPTION_PATH` environment variable (one-shot override).
2. `lastConceptionPath` in `settings.json`.
3. First-launch folder picker. Writes the choice back to `settings.json`.
4. Hard error — condash refuses to start.

Those are the GUI's steps. The CLI resolves through a longer chain — a `--conception` flag, `CLAUDE_PROJECT_DIR`, and a cwd walk-up all take precedence over `lastConceptionPath` — see [CLI → Conception-path resolution](../reference/cli.md#conception-path-resolution) for the full picture.

**File → Open…** doesn't fit this list because it runs after startup: it triggers the same picker as step 3 on demand, then stores its result the same way.

## When to use a scratch tree

A scratch tree is any directory with a minimal `projects/YYYY-MM/` layout that you point condash at temporarily. Common reasons:

- **Learning** — a fresh tree you create yourself, walked through in [Get started](../get-started/index.md#first-launch).
- **Onboarding a teammate** — fork a small sample tree, have them point condash at it, walk them through creating their first item, then point them at the team tree.
- **Snapshot of a bug** — reduce a broken tree to a minimal reproducer, commit it, and file the issue with the snapshot path in the repro steps.

The cheapest way to make one:

```bash
mkdir -p /tmp/scratch-tree/projects/2026-04
```

Then either edit `settings.json` to point at `/tmp/scratch-tree`, or delete `settings.json` and pick the new path on the next launch. The Projects pane will be empty but the dashboard will render. Add README files under `projects/2026-04/` and they show up immediately — chokidar pushes the change into the renderer.

## Multiple machines pointed at the same tree

`lastConceptionPath` lives in `settings.json` and is per-machine — absolute paths typically differ across hosts (different users, different mount points). The tree itself carries `.condash/settings.json` at its root.

The split between those two files is **total and disjoint**, not a fallback chain: every key has exactly one owning file, so nothing is inherited and nothing overrides anything. `workspace_path`, `worktrees_path`, `repositories`, `retired_apps`, `long_lived_branches`, and `taskConfig` belong to the tree; everything else — `terminal`, `theme`, `agents`, `open_with`, `dashboard`, `autoSync`, `pdf_viewer`, layout state, and the path-tracking keys above — is personal and per-machine. A key written to the wrong file is **rejected by the schema** and relocated to its owner by the scope-partition migrator the next time you open the conception. See [The Settings modal](settings-modal.md) and [Config files → Scope-partition migration](../reference/config.md#scope-partition-migrator).
