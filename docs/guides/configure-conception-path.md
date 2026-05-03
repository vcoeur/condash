---
title: Configure the conception path · condash guide
description: Point condash at the directory it should render — persistently or by hand-editing settings.json.
---

# Configure the conception path

> **Audience.** New user and Daily user.

**When to read this.** You want condash to render a tree other than the one it's using now, or you want to know all the ways that path can be set.

The conception path is the only piece of configuration condash needs before it can start. Everything else has a sensible default.

## Option 1 — first-launch folder picker

On first launch with no tree configured, condash opens a native folder picker. Pick the directory containing your `projects/` + (optional) `configuration.json` and condash writes the choice to `${XDG_CONFIG_HOME:-~/.config}/condash/settings.json` (or the platform equivalent — see [Config files](../reference/config.md#at-a-glance)). Subsequent launches reuse the saved path automatically.

This is the right setup for your main tree — the path you work in every day.

## Option 2 — File → Open…

After the first launch, **File → Open…** (shortcut `Ctrl+O`) reopens the same native folder picker. Pick a different directory and condash reloads against it without restarting; the new path is written to `settings.json`. This is the friendly way to switch between two trees you both use regularly.

## Option 3 — edit `settings.json` by hand

Change the saved path without re-launching the picker by editing `${XDG_CONFIG_HOME:-~/.config}/condash/settings.json` directly:

```json
{
  "conception_path": "/home/you/another-tree"
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
2. `conception_path` in `settings.json`.
3. First-launch folder picker. Writes the choice back to `settings.json`.
4. Hard error — condash refuses to start.

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

Then either edit `settings.json` to point at `/tmp/scratch-tree`, or delete `settings.json` and pick the new path on the next launch. The Projects tab will be empty but the dashboard will render. Add README files under `projects/2026-04/` and they show up immediately — chokidar pushes the change into the renderer.

## Multiple machines pointed at the same tree

`conception_path` lives in `settings.json` and is per-machine — absolute paths typically differ across hosts (different users, different mount points). The tree itself carries `configuration.json` at its root; per-machine preferences stay in `settings.json`.
