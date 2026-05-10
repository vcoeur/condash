# Quick start

Three steps: install, point at a folder, create an item.

## 1. Install

Download the latest release for your OS from
**https://github.com/vcoeur/condash/releases/latest**:

| OS | File |
|---|---|
| Linux | `condash-<version>.AppImage` or `condash_<version>_amd64.deb` |
| macOS | `condash-<version>.dmg` |
| Windows | `condash Setup <version>.exe` |

Debian/Ubuntu users can install from the signed apt repository instead:

```bash
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://condash.vcoeur.com/apt/pubkey.asc \
  | sudo gpg --dearmor -o /etc/apt/keyrings/condash.gpg
echo "deb [signed-by=/etc/apt/keyrings/condash.gpg] https://condash.vcoeur.com/apt stable main" \
  | sudo tee /etc/apt/sources.list.d/condash.list
sudo apt update && sudo apt install condash
```

The builds are unsigned. Each OS asks you to confirm the download once
on first launch (right-click → Open on macOS; "More info → Run anyway"
on Windows; nothing extra on Linux).

`git` must be on `PATH` — condash shells out to it for repo status.

## 2. First launch

The first time you run `condash`, a **native folder picker** opens and
asks which conception tree to render. Pick (or create) a directory, for
example `~/conception/`. condash writes the choice into `settings.json`
and reuses it next time.

Don't have a folder yet? The minimum is:

```bash
mkdir -p ~/conception/projects
```

If the folder is empty, condash shows a **Welcome screen** with three
cards:

- **Open my tree** — opens the conception folder in your OS file manager.
- **Read the welcome doc** — opens the in-app `welcome.md` Help page.
- **Open the documentation site** — opens condash.vcoeur.com in your browser.

A **Don't show this again** link below the cards persists the dismissal in `settings.json` (key `welcome.dismissed`).

To switch to a different folder later: **File → Open…** (`Ctrl+O`)
opens the folder picker again.

## 3. Create an item

Use the **Create** button on the Projects toolbar (or the **+** in the
toolbar of an empty Projects pane). Fill in:

- **Kind** — `project`, `incident`, or `document`.
- **Status** — `now` so it lands in Current.
- **Title** + **Slug** — the slug is auto-derived from the title.
- **Apps** — optional.

condash writes `projects/<YYYY-MM>/<YYYY-MM-DD>-<slug>/README.md` with
this template:

```markdown
---
date: 2026-05-02
kind: project
status: now
apps: []
---

# My title

## Goal

## Steps

- [ ] (your first step)

## Timeline

- 2026-05-02 — Project created.

## Notes
```

You can also hand-create items — just `mkdir` the folder and drop a
README with that header. Legacy bold-prose headers (`**Date**: 2026-05-02`,
etc.) are still accepted; see the [README format reference](../reference/readme-format.md).
condash picks it up live.

## Editing settings

**File → Settings…** (`Ctrl+,`) opens a sidebar-rail modal with five
sections:

- **Appearance** — theme, card-min-width sliders, font scale.
- **Terminal** — shell, xterm.js settings, screenshot directory.
- **Workspace** — `workspace_path`, `worktrees_path`, `resources_path`,
  `skills_path`.
- **Repositories** — flat ordered list of repos shown on the Code pane,
  each with optional `run` / `force_stop` commands and submodules.
- **Open with** — `main_ide`, `pdf_viewer`, `terminal` launcher entries.

There is no in-modal JSON editor; the **Open externally** button at the
bottom hands the active tab's file to your `main_ide`.

Per-tree config (`<conception>/condash.json`, with `configuration.json`
read indefinitely as a legacy fallback) is shared with teammates via git
— workspace path, repos, launcher commands. Per-machine config
(`settings.json`) is local to this laptop — your editor binary, your
terminal, your theme.

## More

Full docs (tutorials, per-feature guides, reference) live online at
**https://condash.vcoeur.com**. The Help menu has an **Open documentation
site** entry.
