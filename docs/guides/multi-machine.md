---
title: Multi-machine setup · condash guide
description: Sync a conception tree between machines via git. What goes in version control, what stays per-machine, and how condash layers the two.
---

# Multi-machine setup

> **Audience.** Daily user.

**When to read this.** You work across two (or more) machines — a desktop and a laptop, your work box and a personal box — and you want the same tree on each, with per-machine tweaks that don't fight each other.

condash was designed for this split from day one. One versioned JSON file at the tree root, one per-machine JSON file in your platform's user-config directory. The two layer at launch with clear precedence.

## The two config files

| File | Lives in | Committed? | Per-machine or per-tree? |
|---|---|---|---|
| `configuration.json` | `<conception_path>/configuration.json` | **Yes** | Per-tree (shared) |
| `settings.json` | `${XDG_CONFIG_HOME:-~/.config}/condash/` | **No** — outside the tree | Per-user, per-machine |

- **`configuration.json`** — inside the tree. **Commit this.** It's the team-shared config: workspace layout, repo grouping, optional `run:` / `force_stop:` commands. When a teammate pulls, their repo strip matches yours.
- **`settings.json`** — outside the tree, in your XDG config. **Not versioned.** Holds `conception_path` (which tree to render) plus the three blocks that naturally differ per machine: `terminal.*`, `pdf_viewer`, `open_with.*`.

The two layer at launch: `configuration.json` loads first, then `settings.json` overrides matching keys field by field. See [Precedence on overlap](#precedence-on-overlap) below for the exact rules.

## Installing condash on each machine

Each machine needs its own condash build. Two options:

- **Download from GitHub Releases.** Each release ships a per-OS installer: `.AppImage` / `.deb` on Linux, `.dmg` on macOS, `.exe` on Windows. See [Install](../get-started/install.md) for the first-launch bypass each OS asks for.
- **Build from source.** Clone the repo, then `make install && make build && make package`. Handy when you want to match a specific commit across machines.

The two machines don't need to run the same condash version — the IPC contract, README format, and config files are stable across minor versions.

## Syncing the tree via git

Treat the conception tree as a plain git repository:

```bash
cd ~/conception
git init
git add projects/ knowledge/ configuration.json
git commit -m "Initial conception tree"
git remote add origin git@github.com:you/conception.git
git push -u origin main
```

On the other machine:

```bash
git clone git@github.com:you/conception.git ~/conception
```

Then tell condash on the second machine where the tree lives. Either let the first-launch folder picker write it to `settings.json`, or pre-create the file:

```json
// ~/.config/condash/settings.json on the second machine
{ "conception_path": "/home/you/conception" }
```

Paths typically differ per machine (different usernames, different home directories), which is exactly why `conception_path` is per-machine rather than part of the versioned tree.

## `.gitignore` for the tree

Drop this into the tree's `.gitignore`:

```
*.local.md
.DS_Store
```

`settings.json` does not need to appear here — it lives outside the tree (in `${XDG_CONFIG_HOME:-~/.config}/condash/`), so git inside the conception tree cannot see it.

If you use the `/conception` skill suite or have `.claude/` subdirectories, add them too:

```
.claude/*
!.claude/skills/
!.claude/scripts/
```

Negate only the directories you intentionally share. Default is to hide everything.

## Per-machine terminal tweaks

Example: your desktop has `ghostty`, your laptop has only `gnome-terminal`. Pick a default for the tree, then override per machine — `settings.json` wins on overlap.

```json
// configuration.json — tree default (commits to git)
{
  "open_with": {
    "terminal": { "label": "Open terminal here", "command": "ghostty --working-directory={path}" }
  }
}
```

```json
// ~/.config/condash/settings.json — laptop only
{
  "open_with": {
    "terminal": { "label": "Open terminal here", "command": "gnome-terminal --working-directory {path}" }
  }
}
```

Same pattern for the **terminal toggle shortcut** (say `` Ctrl+` `` on the desktop and `Ctrl+T` on the laptop because the laptop's keyboard intercepts the backtick):

```json
// ~/.config/condash/settings.json on the laptop
{
  "conception_path": "/home/you/conception",
  "terminal": { "shortcut": "Ctrl+T" }
}
```

Leave that key absent on the desktop and condash falls back to whatever `configuration.json` declares (or the built-in default if the tree doesn't set it either).

The same pattern works for `screenshot_dir` (different directories per OS), `launcher_command` (different Claude Code install paths), and the `pdf_viewer` chain.

## Precedence on overlap

When condash boots, each key is resolved in this order — the first layer that sets it wins:

1. **`settings.json`** (`${XDG_CONFIG_HOME:-~/.config}/condash/settings.json`) — per-machine.
2. **`configuration.json`** (`<conception_path>/configuration.json`) — tree-level.
3. Built-in defaults compiled into the binary.

Merging is **per field**:

- `terminal.<field>`: each field set in `settings.json` replaces the tree's value; missing fields fall through.
- `pdf_viewer`: a non-empty array in `settings.json` replaces the tree's; empty or missing falls through.
- `open_with.<slot>`: merged per slot. A user `command` replaces the tree's; a user `label` replaces the tree's. A slot only set in the tree survives.

Full details in the [config reference](../reference/config.md).

## Handling conflicts in `configuration.json`

Because `configuration.json` is versioned, any team-wide layout change is a git commit. If two teammates edit it simultaneously, resolve conflicts the usual way — the file is plain JSON, conflicts are readable, and no binary format gets in the way.

Typical flow when you need to tweak a machine-local value:

1. **Tempted to edit `configuration.json`?** Stop — if the change only makes sense for your machine, put it in `settings.json` instead. No conflict with teammates.
2. **Change is team-wide?** Edit `configuration.json`, commit, push. Teammates get it on the next pull.

## Next

- [Configure the conception path](configure-conception-path.md) — the basic per-machine path setup.
- [Repositories and open-with buttons](repositories-and-open-with.md) — the full `repositories` schema inside `configuration.json`.
- [Config reference](../reference/config.md) — every key in both files.
