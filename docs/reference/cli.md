---
title: CLI · condash reference
description: How to launch condash and where its configuration lives.
---

# CLI

condash is a single Electron binary. It takes no subcommands and no flags — everything is either an environment variable or a line in `settings.json` / `configuration.json`.

## At a glance

| Invocation | What it does |
|---|---|
| `condash` (installed) | Launch the packaged Electron app against the saved conception tree |
| `make dev` (from source) | Watch mode: tsc + vite + Electron with `--no-sandbox` |
| `make package` (from source) | Produce per-OS installers under `release/` via electron-builder |

## `condash`

The packaged Electron app. Installed by the per-OS installer on the [releases page](https://github.com/vcoeur/condash/releases) — `.AppImage`, `.deb`, `.dmg`, `.exe` — or available on PATH after `apt install condash` from the [apt repository](../get-started/install.md#linux-apt-repository-recommended).

```bash
condash
```

That's it — no arguments. The binary launches an Electron `BrowserWindow` rendering the Solid SPA from `dist/` (production) or the Vite dev server on `localhost:5600` (dev mode). The same renderer code runs on every platform — no per-OS CSS branches.

Closing the window exits the process. Relaunch whenever you want to come back — state lives in the Markdown files, not in the app.

## Dev launch

From a clone of the repo:

```bash
make install      # one-off, npm install
make dev          # watch: esbuild rebuilds main, vite serves renderer, electron reloads on change
```

`make dev` passes `--no-sandbox` to Electron so you don't have to fix `chrome-sandbox` ownership in every fresh worktree. The dev window only loads `localhost:5600` and local `file://` URLs — the threat surface is local-only. Drop `--no-sandbox` from `dev:electron` in `package.json` if you want the sandbox on; you'll then need:

```bash
sudo chown root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

once per worktree. macOS and Windows are unaffected.

## Configuration

condash reads no command-line flags. Configuration lives in three layers (see [Config files](config.md) for the full schema):

1. **Environment variables** — see [Environment variables](env.md). The current build does not yet honour `CONDASH_CONCEPTION_PATH`; the conception path is set through the first-launch folder picker.

2. **`settings.json`** at `${XDG_CONFIG_HOME:-~/.config}/condash/settings.json` (Linux), `~/Library/Application Support/condash/settings.json` (macOS), `%APPDATA%\condash\settings.json` (Windows) — per-user, per-machine. Owned by Electron's `app.getPath('userData')`. Holds `conception_path` plus the three blocks that naturally differ per machine: `terminal`, `pdf_viewer`, `open_with`.

3. **`configuration.json`** at `<conception_path>/configuration.json` — per-tree, versioned in git. Holds `workspace_path`, `worktrees_path`, `repositories` (incl. `run:` / `force_stop:`). Edit it by hand or through the gear icon in the dashboard header (plain-text JSON editor).

## What's not in the CLI

- **Headless mode.** The Electron build does not ship a `condash-serve` binary — there is no embedded HTTP server and no browser-friendly URL to point Playwright at. Drive the renderer through Electron itself for end-to-end tests.
- **Creating items.** The dashboard doesn't create items, and neither does the CLI. Use your editor, or the [management skill](skill.md).
- **Listing or searching items.** Use the **History** tab in the dashboard, or `grep` over the tree.
- **A server mode for multiple users.** condash is single-user. If you want multi-user, something else is the right tool.
