---
title: The Settings modal · condash guide
description: Where condash keeps its configuration — the two-tab modal, what each section writes, and how per-conception overrides inherit from your per-machine defaults.
---

# The Settings modal

> **Audience.** Daily user.

**When to read this.** You want to change something — your theme, your shell, the repos on the Code pane, an agent launcher — and you'd rather click than hand-edit JSON. Or you set a value and it didn't take, and you need to understand which file won.

Open it from **File → Settings** (or `Ctrl+,`). It's a full-viewport modal, not a popover. Everything it edits is plain JSON on disk — the modal is a convenience over the same two files documented in **[Config files](../reference/config.md)**; nothing here is exclusive to the UI.

## Two tabs, two files

The modal has exactly two tabs, and the tab you're on decides **which file** your edits land in:

| Tab | Writes to | Holds |
|-----|-----------|-------|
| **Global** | `settings.json` in the OS user-data directory (per-machine) | Your machine-wide defaults + the active conception path and recents list. |
| **This conception** | `<conception>/.condash/settings.json` (per-tree, per-host) | Overrides for *this* conception only. |

Both files share the **same schema**. The active conception path and the recents list are Global-only — they describe your machine, not any one tree.

## Which sections live where

The left rail lists the sections of the current tab:

- **Global** — Recent conceptions · Appearance · Terminal · Agents
- **This conception** — Workspace · Repositories · Open with · Appearance · Terminal · Agents

Three sections — **Appearance**, **Terminal**, **Agents** — appear on *both* tabs. Those are the **inheritable** ones: set a default on Global, override it per tree on This conception. The conception-only sections (Workspace, Repositories, Open with) appear on This conception because overriding them per machine makes no sense.

| Section | Tab(s) | Config key(s) | Guide |
|---------|--------|---------------|-------|
| Recent conceptions | Global | *(managed outside the file)* | [Configure the conception path](configure-conception-path.md) |
| Workspace | This conception | `workspace_path`, `worktrees_path` | [Repositories and open-with buttons](repositories-and-open-with.md) |
| Repositories | This conception | `repositories` | [Repositories and open-with buttons](repositories-and-open-with.md) |
| Open with | This conception | `open_with` | [Repositories and open-with buttons](repositories-and-open-with.md) |
| Appearance | Both | `theme`, `cardMinWidth` | — |
| Terminal | Both | `terminal` | [Embedded terminal](terminal.md) |
| Agents | Both | `agents` | [Agent CLIs and model providers](agent-clis-and-models.md) |

App identity (`#handle`, `retired_apps`, `aliases`) is edited inline in the **Repositories** section — see **[Applications and handles](applications-and-handles.md)**.

## How inheritance works

For an inheritable key, the rule is **top-level replace**: if This conception sets the key, its value replaces the Global value wholesale — arrays replace arrays, objects replace objects, no deep merge. The one documented exception is `terminal`, which merges one level deep so a conception that customises `terminal.logging` keeps your per-machine `terminal.screenshot_dir` and shortcuts (see [Config files → terminal](../reference/config.md#terminal)).

On the **This conception** tab, each inheritable control carries a badge telling you whether the value is **inherited** from Global or **overridden** here. A per-conception diff view collapses the sections that fully inherit, so you see at a glance what this tree actually changes.

A small **dirty pip** next to a section label means you have unsaved edits in it. The modal remembers the last tab and section you were on, so reopening lands you where you left off.

## What it does *not* edit

Layout state (`leftView`, branch filters, tree-expansion), the welcome-screen dismissal, and the recents list are written by the app as you use it — they live in the same files but have no Settings section. For the exhaustive key list, see **[Config files → All config keys](../reference/config.md#all-config-keys)**.

→ Prefer editing the JSON directly? Every key, with defaults and the override model, is in **[Config files](../reference/config.md)**.
