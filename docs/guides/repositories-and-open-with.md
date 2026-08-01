---
title: Repositories and open-with launchers · condash guide
description: Configure the workspace and worktrees paths, the repositories list the Code pane renders, and the three open-with launcher slots that open your editor and terminal — the JSON behind the Code pane.
---

# Repositories and open-with launchers

> **Audience.** Daily user.

**When to read this.** The **Code** pane shows the wrong repos, the order isn't what you want, or the "open in IDE" button launches the wrong thing (or nothing).

> This is the **configuration** page for the Code pane. What the pane *looks* like — cards, branch rows, pinning, worktree rows — is on [The Code pane](code-pane.md); here is where the JSON lives.

The workspace, worktrees, and repository settings on this page live in `<conception_path>/.condash/settings.json` (legacy filenames `condash.json` and `configuration.json` are read as fallbacks). The `open_with` launcher slots are a **personal** setting and live in the per-machine `settings.json` instead. The two files have **disjoint** schemas — each key has exactly one home, so there is no override or merge between them.

## Workspace and worktrees paths

```json
{
  "workspace_path": "/home/you/src",
  "worktrees_path": "/home/you/src/worktrees"
}
```

- **`workspace_path`** — the directory condash scans for git repositories. Every direct subdirectory that contains a `.git/` becomes a row in the Code pane.
- **`worktrees_path`** — the root under which `condash worktrees setup <branch>` creates `<worktrees_path>/<branch>/<repo>/`. That is the main reason to set it; it also counts as an allowed root for the "open with" launchers.

With `workspace_path` unset the Code pane still opens — it just has no repos to resolve, so it renders empty.

### `long_lived_branches`

```json
{
  "long_lived_branches": ["main", "master", "release/*"]
}
```

Branch names `condash worktrees remove` must **never** delete. Glob wildcards `*` and `?` are supported. When the key is absent the default is `["main", "master"]` — and note that setting it **replaces** that default rather than extending it, so include `main` explicitly if you still want it protected. Edited in the Settings modal's **Workspace & paths** section.

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

Names are bare directory names (not paths) matched against whatever was found under `workspace_path`. The Code pane renders one card per entry in declaration order — see [The Code pane](code-pane.md) for how cards, rows, and worktrees display. Keep the repos you touch most often first.

Each repo renders as its own top-level card — including any sub-repos declared for it (see [Submodules in a monorepo](#submodules-in-a-monorepo) below), which are cards alongside the parent rather than children nested under it.

## Pinning branches across cards

The pin selector's modes, the `selectedBranches` + `branchFilterStickyAll` persistence, and the "project" badge are described on [The Code pane](code-pane.md#pinning-branches-across-cards) — they are display behaviour, not configuration.

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

A submodule entry is either a string (`"apps/web"`) or an inline object (`{"name": "apps/web", "run": "make dev"}`). A plain string entry means "treat the whole repo as one unit". Each declared submodule renders as a **top-level card** alongside its parent (see [The Code pane](code-pane.md#submodules-in-a-monorepo) for how the family displays); a repo without declared submodules simply renders as a family of one.

## Other keys a repository entry accepts

A repository entry can be a bare string, or an object carrying any of:

| Key | Purpose |
|---|---|
| `name` | Directory name under `workspace_path`. Optional when `path` is given. |
| `path` | Absolute path, for a repo that lives outside `workspace_path`. The directory name is then `basename(path)`. |
| `handle` | The canonical `#handle`. Defaults to the directory name, lowercased — see [Applications and handles](applications-and-handles.md). |
| `aliases` | Legacy spellings that resolve to this handle; drives `applications validate`'s auto-fix suggestions. |
| `label` | Display label for the card. |
| `submodules` | Sub-repos rendered as sibling cards (above). |
| `run` | Inline dev-server command (below). |
| `force_stop` | Command run by the card's force-stop action when a dev server won't die. |
| `install` | Command run after `condash worktrees setup` creates a worktree for this repo. Applied unconditionally when set; `--no-install` skips it. |
| `pinned_branch` | Keep this repo on a fixed branch — `worktrees setup` skips it. |
| `env` | Files to copy from the primary checkout into a new worktree. Applied unconditionally when present; `--no-env` skips. |

The array may also carry **section markers** — `{ "section": "Services" }` — which carry no behaviour of their own: they group the Code pane's cards and the Settings modal's rows under a heading. The config walker strips them out before any consumer sees the repository list, so a marker is never mistaken for a repo.

Per-key detail with defaults: [Config files → `repositories`](../reference/config.md#repositories).

## The three `open_with` slots

A repo row carries one button that opens a condash terminal tab there, and a chevron that opens the **Open with…** menu — that menu is where the three configured slots appear. (A row with a `run:` command also gets a Run/Stop button.) Wire the slots in the per-machine `settings.json` (`open_with` is a personal setting, not a conception one):

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
- **`command`** — a single command line. The literal `{path}` is replaced with the absolute path of the repo (or submodule row) being opened.

> **No fallback chain.** The Electron build takes a single `command` string per slot — there is no `commands` list with sequential trial. If you need machine-specific fallbacks (`idea` then `idea.sh`), wrap them in a small launcher script that does the trial-and-fall-through itself.

**There are no built-in defaults.** A slot with no `command` is simply not offered: the button doesn't appear, and asking for it explicitly errors with `open_with.<slot> is not configured`. If your buttons do nothing, the usual reason is that this block is missing.

### How the command is parsed

It is **argv splitting, not a shell**. condash tokenises the string and spawns the program directly (`shell: false`), so:

- **Quotes group a token.** `"/Applications/JetBrains Toolbox/idea.app" {path}` is one program plus one argument. Both `"` and `'` work, and an explicitly quoted empty string (`""`) survives as a real empty argument.
- **Backslashes have no escaping power.** They pass through literally — this is not a shell, so `\ ` does not escape a space.
- **`{path}` substitutes per argument**, not per line, so `--dir={path}` works.
- **A leading `~/` in any token expands to your home directory.** Without that, a config referencing `~/bin/foo` would silently fail to spawn.
- **No shell features at all** — no `&&`, no pipes, no globbing, no `$VAR` interpolation. Put those in a script and point the slot at the script.

The command is spawned with your resolved **login-shell PATH**, so a CLI installed under `~/.local/bin` resolves even when condash was started from a desktop launcher.

## Editing via the Settings modal

Open **File → Settings** (`Ctrl+,`). **Workspace & paths** and **Repositories** sit under the **This conception** group (backed by `.condash/settings.json`); **Open with** sits under **Personal · this machine** (backed by `settings.json`). Each has form fields — there is no in-modal JSON editor. For keys the modal doesn't surface (nested `repositories[].submodules` shapes, `pdf_viewer`), use the rail's **Open settings.json** / **Open .condash/settings.json** buttons, which hand the file to your **OS default editor**. Either path runs through the same atomic save + strict zod schema.

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

Every "open with" invocation validates its target path against **three** allowed roots: the active **conception path**, `workspace_path`, and `worktrees_path`. Paths elsewhere are rejected before anything is spawned. The conception path is in the list deliberately — it is what lets the dashboard open a project README in your IDE.

This is the single defence against a crafted argument tricking condash into launching a command against a file it shouldn't touch — don't broaden the sandbox unless you know why.
