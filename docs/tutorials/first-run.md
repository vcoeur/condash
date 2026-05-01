---
title: First run · condash
description: Install condash, point it at a fresh conception tree, and get your first item rendered. Ten minutes.
---

# First run

> **Audience.** New user — never used condash before. You have it installed; you want to see it working with your own tree.

By the end of this tutorial you'll have:

- condash installed and launched.
- A fresh conception tree with one project in it.
- The dashboard rendering your project, with a Steps section, a Status pill, and a Notes folder you can read in your editor.

Time: ten minutes if the install is already done; twenty if you're installing from scratch.

## 1. Install condash

If you haven't already, install condash from the [GitHub Releases page](https://github.com/vcoeur/condash/releases) — `.AppImage` / `.deb` for Linux, `.dmg` for macOS, `.exe` for Windows. Each platform asks for a one-time bypass; the [Install](../get-started/install.md) page walks through the gesture per OS.

Verify the binary is on your `$PATH`:

```bash
condash --version
```

You should see something like `condash 2.5.0`.

## 2. Create an empty tree

Pick any directory on your disk. We'll use `~/src/conception` for the rest of this tutorial — substitute your own path if you prefer.

```bash
mkdir -p ~/src/conception/projects
```

That's the minimum. condash also looks for an optional `knowledge/` sibling and a `configuration.json` at the root, but neither is required to boot.

If you want to start with a more populated tree (a knowledge index, conventions, sample skills), copy the template that ships with condash:

```bash
# Locate the template inside the install
condash skills install --help     # the same logic powers `skills install`
```

The template lives at `<install_dir>/conception-template/`. The exact path depends on your installer — on Linux apt installs it's `/opt/condash/resources/app.asar/conception-template/`. The `condash skills install` verb (covered in [Multi-machine setup](../guides/multi-machine.md)) copies the skill subset into a tree on demand.

## 3. Tell condash where the tree lives

Two ways:

**With the CLI** (one command, no GUI):

```bash
condash config conception-path ~/src/conception
```

This writes `conception_path` into your platform's `settings.json`. The next launch picks it up.

**With the folder picker** (the friendly path):

Just run `condash`. With no `conception_path` saved yet, the app opens a native folder picker. Select `~/src/conception` and click Open. condash writes the choice for you and continues.

## 4. Launch

```bash
condash
```

A single window opens. Because the tree is empty (no items in `projects/`, no entries in `knowledge/`), condash shows the **Welcome screen** instead of an empty dashboard:

- *Create your first project* — opens the new-item modal.
- *Take the tour* — opens the in-app Help with a short overview.
- *Open the documentation* — opens [condash.vcoeur.com](https://condash.vcoeur.com) in your browser.

Click **Create your first project**.

## 5. Create your first item

The new-item modal asks for the handful of fields condash's parser actually reads:

- **Kind** — pick `project`.
- **Status** — pick `now` so the item lands in the Current sub-tab.
- **Title** — anything; "Try condash" is fine.
- **Slug** — auto-derived from the title; leave the default.
- **Apps** — leave empty for this tutorial.

Click **Create item**. condash:

1. Creates `projects/<YYYY-MM>/<YYYY-MM-DD>-try-condash/README.md` with a minimal template.
2. Creates an empty `notes/` sibling.
3. Switches to the Current sub-tab and expands the new card.

The Welcome screen disappears — you have content now.

## 6. Walk around

Take a minute to click through:

- **Projects → Current** — your one item with status `now`. Click the row to expand.
- **Code** — likely empty unless you set `workspace_path` in `configuration.json`. We'll cover that in the [next tutorial](first-project.md).
- **Knowledge** — empty unless you copied the knowledge template earlier. The tab is hidden when the directory is missing.
- **History** — full-text search across items + notes. Type the title of your project; it surfaces immediately.

Click the **gear icon** in the header. The **Configuration** modal opens with a plain-text JSON editor backed by `<conception>/configuration.json`. The file doesn't exist yet — type `{}` and Save (atomic temp + rename); a minimal valid config is born. We'll fill it in next.

## 7. Read what got created

Switch to your editor and open the README condash just wrote:

```bash
$EDITOR ~/src/conception/projects/*/*/README.md
```

You'll see something like:

```markdown
# Try condash

**Date**: 2026-05-01
**Kind**: project
**Status**: now

## Goal

(your goal here)

## Steps

- [ ] (your first step)

## Timeline

- 2026-05-01 — Project created.

## Notes
```

That's the whole item. The dashboard reads this exact file; mutations (toggling a step, changing status) rewrite specific lines. The format is documented in [README format](../reference/readme-format.md).

## 8. Close the window

Closing the native window exits condash. State lives in your files; relaunch with `condash` whenever you want to come back.

## What you just learned

- Installing condash is either a one-click installer from GitHub Releases or three `make` targets from source.
- The conception path is the only thing condash needs to boot. Set it once with `condash config conception-path` or through the first-launch folder picker.
- The Welcome screen meets you on an empty tree and offers a path forward — create an item, take the tour, or read the docs.
- Items are filesystem directories with a `README.md` and optional `notes/`. The dashboard mutates a small set of lines in those files; everything else is yours to edit in your editor.
- Configuration splits in two: tree-level (`<conception>/configuration.json`, team-shared) and per-machine (`settings.json`, hand-edited or written by the CLI / folder picker).

## Next

**[Your first project →](first-project.md)** — wire `workspace_path`, get the Code tab populated, edit a step, add a note, link to another item.
