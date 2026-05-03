---
title: Get started · condash
description: Install condash, point it at a folder, and create your first project — one page.
---

# Get started

Three things in one page:

- [Install](#install) — get the binary on your machine.
- [First launch](#first-launch) — pick a folder; condash remembers it.
- [Your first project](#your-first-project) — create an item via the Welcome screen.

→ For deeper how-tos, jump to **[Guides](../guides/index.md)**. For lookups, **[Reference](../reference/index.md)**.

## Install

Download for your OS from **[github.com/vcoeur/condash/releases/latest](https://github.com/vcoeur/condash/releases/latest)**:

| OS | File |
|---|---|
| Linux | `condash-<version>.AppImage` or `condash_<version>_amd64.deb` |
| macOS | `condash-<version>.dmg` |
| Windows | `condash Setup <version>.exe` |

> `git` must be on `PATH` — condash shells out to it for repo status. Linux distros ship it; on macOS install Xcode CLT (`xcode-select --install`); on Windows use [Git for Windows](https://git-scm.com/download/win).

### Linux — apt repository (recommended for Debian/Ubuntu)

A signed apt repository at `condash.vcoeur.com/apt/` lets `apt` track new versions for you.

```bash
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://condash.vcoeur.com/apt/pubkey.asc \
  | sudo gpg --dearmor -o /etc/apt/keyrings/condash.gpg
echo "deb [signed-by=/etc/apt/keyrings/condash.gpg] https://condash.vcoeur.com/apt stable main" \
  | sudo tee /etc/apt/sources.list.d/condash.list
sudo apt update && sudo apt install condash
```

Then `sudo apt update && sudo apt upgrade` covers updates.

### Linux — AppImage

```bash
chmod +x condash-*.AppImage
./condash-*.AppImage
```

If the window doesn't appear, install Electron's runtime deps:

```bash
sudo apt install libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1   # Debian/Ubuntu
sudo dnf install nss atk at-spi2-atk gtk3 mesa-libgbm             # Fedora
```

### macOS

The build is unsigned. Bypass Gatekeeper once:

- **macOS 14 and earlier**: Finder → control-click `condash.app` → **Open**.
- **macOS 15+**: double-click → dismiss the warning → **System Settings → Privacy & Security** → **Open Anyway**.

If macOS still refuses with "damaged":

```bash
xattr -dr com.apple.quarantine /Applications/condash.app
```

### Windows

Double-click the installer. Windows shows "Windows protected your PC" — click **More info → Run anyway**. Each new release re-prompts (expected for unsigned binaries).

## First launch

The first time you run `condash`, a **native folder picker** opens and asks where your conception tree lives. Pick (or create) any directory that will hold your Markdown items, for example `~/src/conception/`. condash writes the choice into `settings.json` and reuses it next time.

Don't have one yet? The minimum is one empty subdirectory:

```bash
mkdir -p ~/src/conception/projects
```

If the folder you picked is empty, condash shows a **Welcome screen** with three buttons:

- **Create your first project** — opens the new-item modal.
- **Take the tour** — opens the in-app Help.
- **Open the documentation** — `condash.vcoeur.com` in your browser.

### Changing the folder later

Three ways:

- **Menu** — **File → Open…** opens the folder picker again. (Shortcut: `Ctrl+O`.)
- **CLI** — `condash config conception-path /path/to/other-tree`.
- **Hand-edit** — `${XDG_CONFIG_HOME:-~/.config}/condash/settings.json` (Linux), `~/Library/Application Support/condash/settings.json` (macOS), `%APPDATA%\condash\settings.json` (Windows). Set `conception_path` and relaunch.

### Editing settings without leaving the app

**File → Settings…** (`Ctrl+,`) opens a tabbed modal:

- **General** — theme.
- **Terminal** — embedded terminal preferences (shell, shortcuts, xterm.js settings).
- **`configuration.json`** — full JSON editor for the per-tree config (atomic save, validated against the schema).
- **Shortcuts** — keyboard reference.

Per-tree config (`<conception>/configuration.json`) is for things teammates share — workspace path, repo list, launcher commands. Per-machine config (`settings.json`) is for things specific to this laptop — your editor binary, your terminal emulator, your theme. See **[Config files reference](../reference/config.md)** for every key.

## Your first project

From the Welcome screen, click **Create your first project**. The new-item modal asks for:

- **Kind** — `project`, `incident`, or `document`. Pick `project`.
- **Status** — pick `now` so the item lands in the Current group.
- **Title** — anything; "Try condash" is fine.
- **Slug** — auto-derived from the title; leave the default.
- **Apps** — leave empty.

Click **Create item**. condash writes `projects/<YYYY-MM>/<YYYY-MM-DD>-try-condash/README.md` with this template:

```markdown
# Try condash

**Date**: 2026-05-02
**Kind**: project
**Status**: now

## Goal

(your goal here)

## Steps

- [ ] (your first step)

## Timeline

- 2026-05-02 — Project created.

## Notes
```

That file is the whole item. The dashboard reads it on every refresh; mutations (toggle a step, change status, drag between groups) rewrite specific lines. The format is documented in **[README format](../reference/readme-format.md)**.

You can also create items by hand — just `mkdir projects/<YYYY-MM>/<YYYY-MM-DD>-<slug>/` and drop a `README.md` with the header above. condash picks it up live.

## Walk around

- **Projects** (left pane) — items grouped by status (Current / Next / Backlog / Done). Click a row to expand it inline; click again to open the full note in a modal.
- **Code** (right pane) — your repos, dirty status, open-in-IDE buttons. Empty until you set `workspace_path` and `repositories` in `configuration.json` (gear modal → `configuration.json` tab).
- **Knowledge** (right pane, alternate) — your reference notes, organised as cards. Hidden when `<conception>/knowledge/` is empty.
- **Terminal** — toggle with `` Ctrl+` `` (View → Show Terminal).
- **Search** — `Ctrl+Shift+F` opens cross-tree fuzzy search.

## Next

- **[Guides](../guides/index.md)** — embedded terminal, repos, wikilinks, knowledge tree.
- **[Reference](../reference/index.md)** — every CLI verb, config key, README field, mutation, shortcut.
- **[Background](../explanation/index.md)** — why condash is shaped this way.
