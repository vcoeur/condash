---
title: Configure the conception path · condash guide
description: Point condash at the directory it should render — persistently or by hand-editing settings.json.
---

# Configure the conception path

**When to read this.** You want condash to render a tree other than the one it's using now, or you want to know all the ways that path can be set.

The conception path is the only piece of configuration condash needs before it can start. Everything else has a sensible default.

## Option 1 — first-launch folder picker

On first launch with no tree configured, condash opens a native folder picker. Pick the directory containing your `projects/` + (optional) `configuration.json` and condash writes the choice to `${XDG_CONFIG_HOME:-~/.config}/condash/settings.json` (or the platform equivalent — see [Config files](../reference/config.md#at-a-glance)). Subsequent launches reuse the saved path automatically.

This is the right setup for your main tree — the path you work in every day.

## Option 2 — edit `settings.json` by hand

Change the saved path without re-launching the picker by editing `${XDG_CONFIG_HOME:-~/.config}/condash/settings.json` directly:

```json
{
  "conception_path": "/home/you/another-tree"
}
```

Delete the file to force the folder picker on the next launch.

## Resolution order

On startup condash checks, in order:

1. `conception_path` in `settings.json`.
2. First-launch folder picker. Writes the choice back to `settings.json`.
3. Hard error — condash refuses to start.

> **Note.** The Electron build does not yet honour an environment-variable override (the Tauri build read `CONDASH_CONCEPTION_PATH`). To switch trees today, edit `settings.json` or relaunch the picker. Drop a request in [issues](https://github.com/vcoeur/condash/issues) if you need an env-var hook for scripted demos.

## When to use a scratch tree

A scratch tree is any directory with a minimal `projects/YYYY-MM/` layout that you point condash at temporarily. Common reasons:

- **Learning** — the bundled `conception-demo` tree, fetched in [First run](../tutorials/first-run.md).
- **Onboarding a teammate** — fork a small sample tree, have them point condash at it, walk them through creating their first item, then point them at the team tree.
- **Snapshot of a bug** — reduce a broken tree to a minimal reproducer, commit it, and file the issue with the snapshot path in the repro steps.

The cheapest way to make one:

```bash
mkdir -p /tmp/scratch-tree/projects/2026-04
```

Then either edit `settings.json` to point at `/tmp/scratch-tree`, or delete `settings.json` and pick the new path on the next launch. The Projects tab will be empty but the dashboard will render. Add README files under `projects/2026-04/` and they show up immediately — chokidar pushes the change into the renderer.

## Multiple machines pointed at the same tree

If you sync the conception tree between machines via git, each machine keeps its own `conception_path` in `settings.json` — the absolute path typically differs (different users, different mount points). The tree itself carries the team-shared config in `configuration.json`; per-machine preferences live in each machine's `settings.json`. See [Multi-machine setup](multi-machine.md) for the full split.
