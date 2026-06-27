---
title: Repositories and open-with buttons · condash guide
description: Point condash at your workspace, list the repos surfaced on the Code pane, and wire the three launcher slots to your own editor and terminal.
---

# Repositories and open-with buttons

> **Audience.** Daily user.

**When to read this.** The **Code** pane shows the wrong repos, the order isn't what you want, or the "open in IDE" button launches the wrong thing (or nothing).

The workspace, worktrees, and repository settings on this page live in `<conception_path>/.condash/settings.json` (legacy filenames `condash.json` and `configuration.json` are read as fallbacks). The `open_with` launcher slots are a **personal** setting and live in the per-machine `settings.json` instead. The two files have **disjoint** schemas — each key has exactly one home, so there is no override or merge between them.

## Workspace and worktrees paths

```json
{
  "workspace_path": "/home/you/src",
  "worktrees_path": "/home/you/src/worktrees"
}
```

- **`workspace_path`** — the directory condash scans for git repositories. Every direct subdirectory that contains a `.git/` becomes a row in the Code pane.
- **`worktrees_path`** — an additional sandbox for the "open in IDE" launchers. Paths outside both roots are rejected before the shell sees the command.

If `workspace_path` is unset, the Code pane disappears.

## The repository list

```json
{
  "repositories": [
    "helio",
    "helio-web",
    "helio-docs"
  ]
}
```

Names are bare directory names (not paths) matched against whatever was found under `workspace_path`. The Code pane renders one card per entry in declaration order — keep the repos you touch most often at the top.

![Code pane — flat list of repo cards](../assets/screenshots/code-pane-light.png#only-light)
![Code pane — flat list of repo cards](../assets/screenshots/code-pane-dark.png#only-dark)

Each repo renders as a top-level row. Any sub-repos declared for that repo (see [Submodules in a monorepo](#submodules-in-a-monorepo) below) sit on the same row level, visually grouped with the parent by a blue left-border accent. Worktrees for a given repo or sub-repo nest directly under it.

## Pinning branches across cards

The **primary worktree row** (the checkout under `workspace_path`) is always visible on every card and gets a subtly tinted background so it reads as the always-on reference row.

Click the **Branches** button at the top of the Code pane to open the pin selector. Two quick-action buttons in the popover header switch between three explicit modes:

- **All (sticky)** — show every branch on every card *and* auto-pin any branch that appears later (e.g. one you've just created). The default on a fresh install.
- **None** — show only the main row on every card.
- **Custom** — ticking an individual branch implicitly drops out of sticky-all into a hand-picked set. Each card then renders just its primary row plus any rows whose branch is in your pinned set, and is a silent no-op on cards that don't carry those branches.

The mode and selection persist per-machine in `settings.json` under `selectedBranches` + `branchFilterStickyAll`, so a coffee break or a reboot doesn't clear them. Branches that match a conception project with status `now` or `review` carry a small "project" badge in the dropdown so the most likely picks stand out from ad-hoc local branches.

## Submodules in a monorepo

If you work in a monorepo where different subdirectories are edited independently, use the submodule form:

```json
{
  "repositories": [
    {
      "name": "helio",
      "submodules": ["apps/web", "apps/api", "crates/parser"]
    }
  ]
}
```

Each declared submodule renders as a **top-level row** alongside its parent, not as a collapsible child under it. Parent and submodules share a row level; the whole family is wrapped in a left-border accent (the blue "family" line) so the eye still groups them. Submodules are always rendered when they exist.

Each row in the family (parent or submodule) keeps its own dirty count, its own set of `open_with` buttons, its own [inline runner](../reference/inline-runner.md), and its own nested worktrees. A repo without declared submodules simply renders as a family of one.

If a configured submodule path is missing in one of a repo's worktrees (the worktree predates the submodule's addition, or someone deleted the subdir), condash surfaces a greyed **"missing"** row in that family rather than silently omitting it — that way the visual family stays consistent across checkouts and the gap is obvious.

A submodule entry is either a string (`"apps/web"`) or an inline object (`{"name": "apps/web", "run": "make dev"}`). A plain string entry means "treat the whole repo as one unit".

## The three `open_with` slots

Each repo row has three icon buttons: **main IDE**, **secondary IDE**, **terminal**. Wire them in the per-machine `settings.json` (`open_with` is a personal setting, not a conception one):

```json
{
  "open_with": {
    "main_ide":      { "label": "Open in main IDE",      "command": "idea {path}" },
    "secondary_ide": { "label": "Open in secondary IDE", "command": "code {path}" },
    "terminal":      { "label": "Open terminal here",    "command": "ghostty --working-directory={path}" }
  }
}
```

- **`label`** — the tooltip text shown on hover.
- **`command`** — a single shell-style command. The literal `{path}` is replaced with the absolute path of the repo (or submodule row) being opened.

> **No fallback chain.** The Electron build takes a single `command` string per slot — there is no `commands` list with sequential trial. If you need machine-specific fallbacks (`idea` then `idea.sh`), wrap them in a small launcher script that does the trial-and-fall-through itself.

Commands are parsed shell-style, so quoting works the way you'd expect: `"/Applications/JetBrains Toolbox/idea.app" {path}` is a single argv[0] + `{path}`.

Built-in defaults for the three slots reproduce the previous IntelliJ / VS Code / terminal behaviour, so a configuration without any `open_with` section still gives functional buttons. Override only the slots you want to customise.

## Editing via the Settings modal

Open **File → Settings…** (`Ctrl+,`). **Workspace & paths** and **Repositories** sit under the **This conception** group (backed by `.condash/settings.json`); **Open with** sits under **Personal · this machine** (backed by `settings.json`). Each has form fields — there is no in-modal JSON editor; for keys outside the modal (e.g. nested `repositories[].submodules` shapes, `pdf_viewer`), use the rail's **Open …** buttons to edit the raw JSON in your `$EDITOR`. Either path runs through the same atomic save + strict zod schema.

Changes to `open_with` and `terminal` reload the dashboard live; `workspace_path`, `worktrees_path`, and the `repositories` list need a restart.

`open_with` is a **personal** setting — it lives only in the per-machine `${XDG_CONFIG_HOME:-~/.config}/condash/settings.json`, so your launcher paths stay the same across every conception on this machine.

## Starting a dev server from the row

Distinct from `open_with` (which launches **external** tools like your IDE), the inline **Run** button spawns a dev server as a PTY-owned child of condash itself, with its output streamed into an xterm mounted under the row. Enable it by adding `run: "<command>"` to the repo's inline-map entry:

```json
{
  "repositories": [
    { "name": "notes.vcoeur.com", "run": "make dev" },
    {
      "name": "helio",
      "submodules": [
        { "name": "apps/web", "run": "npm --prefix apps/web run dev" }
      ]
    }
  ]
}
```

The runner and the `open_with` launchers solve different problems: `open_with` hands control to a separate process you then interact with elsewhere; Run keeps the process under condash's lifecycle and shows its output right in the dashboard. See [inline dev-server runner](../reference/inline-runner.md) for the full state machine and single-session-per-repo lock.

## Sandbox rules

Every "open with" invocation validates its target path is under `workspace_path` or `worktrees_path`. Paths elsewhere are rejected. This is the single defence against a crafted URL parameter tricking condash into launching a command with an attacker-controlled argument — don't broaden the sandbox unless you know why.
