---
title: First launch · condash
description: What happens the first time you open condash, how to pick your conception tree, and where the setting is stored.
---

# First launch

> **Audience.** New user — never used condash before.

The first time you launch condash, it needs to know which Markdown tree to render. There's no hard-coded default — if it can't find one, a native folder picker opens and asks you to select it.

## The conception tree

A conception tree is a directory on your disk with at least one of:

- A `configuration.json` file at the root (optional; needed only for the Code tab and "open with" buttons to do something useful).
- A `projects/` subdirectory containing your item READMEs.

Optional siblings — `knowledge/`, a `documents/` drop-point, and so on — add features but aren't required to boot condash. See the **[conception convention](../reference/conception-convention.md)** for the full shape.

If you don't already have a tree, the simplest bootstrap is an empty `projects/` directory:

```bash
mkdir -p ~/src/conception/projects
```

Then point condash at `~/src/conception` through the folder picker. The dashboard renders an empty Projects tab and a welcome screen guides you to your first action — see [Welcome screen](#welcome-screen) below.

## How condash finds your tree

On startup condash checks, in order:

1. **`CONDASH_CONCEPTION_PATH` environment variable.** A one-shot override that wins over everything else, useful for scripted demos and ad-hoc trees:
   ```bash
   CONDASH_CONCEPTION_PATH=/tmp/scratch-tree condash
   ```
2. **Saved user setting.** `${XDG_CONFIG_HOME:-~/.config}/condash/settings.json` (Linux), `~/Library/Application Support/condash/settings.json` (macOS), `%APPDATA%\condash\settings.json` (Windows). One key:
   ```json
   {
     "conception_path": "/home/you/src/conception"
   }
   ```
   The folder picker writes this on first launch, so you usually don't edit it by hand.
3. **Folder picker.** If neither the env var nor the settings file supply a path, condash opens a native OS folder picker. Pick the directory that holds your `projects/` (and optionally `configuration.json`). On **Cancel**, condash exits cleanly.

## Welcome screen

If the conception path resolves to a directory that has **no items** in `projects/` and **no entries** in `knowledge/`, condash shows a Welcome screen instead of an empty dashboard. Three actions:

- **Create your first project** — opens the new-item modal with sensible defaults.
- **Take the tour** — opens the in-app Help with the welcome page.
- **Open the documentation site** — opens [condash.vcoeur.com](https://condash.vcoeur.com) in your browser.

A small "Don't show this again" checkbox writes `welcome.dismissed = true` to `settings.json`. Once you have content in the tree (one item or one knowledge file is enough), the welcome screen stops appearing on its own.

## Changing your mind later

To point condash at a different tree:

- **Through the CLI**: `condash config conception-path /path/to/other-tree` writes `settings.json` for you. The next launch picks it up.
- **By hand**: edit `${XDG_CONFIG_HOME:-~/.config}/condash/settings.json` directly.
- **Re-run the picker**: delete the `conception_path` key (or the whole file) and the picker reappears on the next launch.

## What else you can configure

The conception path is the only thing condash needs to boot. Everything else has sensible defaults.

The **per-tree** config (`<conception>/configuration.json`) holds the workspace path, the list of repos in the Code tab, and the launcher chains for "open with" buttons. It's checked into git and shared with teammates.

The **per-machine** config (`settings.json`) holds the conception path, the theme, and any per-machine overrides for terminal / "open with" preferences.

See **[Config files reference](../reference/config.md)** for the full schema.

## See also

- [Install](install.md) — get the binary on your machine.
- [Configure the conception path](../guides/configure-conception-path.md) — the deeper guide on this exact topic.
- [First run](../tutorials/first-run.md) — a guided walk through your first session, with a sample tree.
