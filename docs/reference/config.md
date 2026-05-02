---
title: Config files · condash reference
description: The two JSON files condash reads (per-tree and per-machine) and what every key means.
---

# Config files

> **Audience.** Daily user.

condash reads two JSON files. Both are optional in principle — the dashboard runs with sensible defaults — but in practice you set at least the conception path on first launch.

## At a glance

| File                 | Path                                                                                                                                                                        | Lifecycle                  | Owns                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------- |
| `configuration.json` | `<conception_path>/configuration.json`                                                                                                                                      | Per-tree, versioned in git | `workspace_path`, `worktrees_path`, `repositories` (incl. `run` / `force_stop`) |
| `settings.json`      | `${XDG_CONFIG_HOME:-~/.config}/condash/settings.json` (Linux) · `~/Library/Application Support/condash/settings.json` (macOS) · `%APPDATA%\condash\settings.json` (Windows) | Per-user, per-machine      | `conception_path`, `terminal`, `open_with`, `pdf_viewer`, `theme`               |

The split is by **lifecycle**, not by feature: anything you'd commit so teammates pick it up automatically goes in `configuration.json`; anything that depends on this machine (your editor binary, your terminal emulator, your Pictures folder) goes in `settings.json`.

`terminal`, `open_with`, and `pdf_viewer` are valid in **either** file — set them in `configuration.json` for tree-wide defaults teammates pick up automatically, or in `settings.json` for per-machine overrides. When the same key appears in both files, **`settings.json` wins**, merged field by field:

- `terminal.<field>` — each field set in `settings.json` replaces the tree's value; missing fields fall through.
- `open_with.<slot>` — merged per slot; the user's `command` and `label` replace the tree's; tree-only slots survive untouched.
- `pdf_viewer` — a non-empty array in `settings.json` replaces the tree's chain; empty or missing falls through.

Concretely: move any machine-specific preference from `configuration.json` into `settings.json` on each machine; leave tree-wide preferences in `configuration.json` and every teammate gets them automatically.

## `configuration.json` (per-tree, versioned)

Lives at `<conception_path>/configuration.json`. Commit it. Every key is optional — a minimal valid file is `{}`, in which case condash uses defaults everywhere. Strict-mode validation: extra top-level keys are rejected on save.

```json
{
  "workspace_path": "/home/you/src",
  "worktrees_path": "/home/you/src/worktrees",
  "repositories": {
    "primary": [
      "condash",
      {
        "name": "helio",
        "submodules": [
          { "name": "apps/web", "run": "make dev" },
          { "name": "apps/api", "run": "make dev" }
        ]
      },
      {
        "name": "notes.vcoeur.com",
        "run": "make dev",
        "force_stop": "fuser -k 8200/tcp 5200/tcp"
      }
    ],
    "secondary": ["conception"]
  },
  "open_with": {
    "main_ide": { "label": "Open in main IDE", "command": "idea {path}" },
    "secondary_ide": { "label": "Open in secondary IDE", "command": "code {path}" },
    "terminal": { "label": "Open terminal here", "command": "ghostty --working-directory={path}" }
  },
  "terminal": {
    "shell": "/bin/zsh",
    "shortcut": "Ctrl+T",
    "screenshot_dir": "/home/you/Pictures/Screenshots",
    "screenshot_paste_shortcut": "Ctrl+Shift+V",
    "launcher_command": "claude",
    "move_tab_left_shortcut": "Ctrl+Left",
    "move_tab_right_shortcut": "Ctrl+Right"
  }
}
```

Paths may use `~` (expanded to `$HOME`) or absolute paths. JSON does not carry comments — keep prose documentation in the project README or the per-tree `CLAUDE.md`.

### Workspace keys

| Key              | Meaning                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace_path` | Directory condash scans for git repositories. Every direct subdirectory containing a `.git/` shows up in the **Code** tab. If unset, the tab is hidden. |
| `worktrees_path` | Additional sandbox for the "open in IDE" buttons. Paths outside `workspace_path` and `worktrees_path` are rejected before the shell sees them.          |

### `repositories`

Two buckets, `primary` and `secondary`, each an array of repo entries. Entries take one of the following shapes:

```json
{
  "repositories": {
    "primary": [
      "condash",
      { "name": "helio" },
      { "name": "helio", "submodules": ["apps/web", "apps/api"] },
      { "name": "notes.vcoeur.com", "run": "make dev", "force_stop": "fuser -k 8200/tcp" }
    ]
  }
}
```

| Shape                                                     | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bare string `"condash"`                                   | Directory name (not a path) matched against the scan of `workspace_path`.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `{"name": "repo"}`                                        | Same as bare — the inline-object form coexists because a repo may want sibling keys.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `{"name": "repo", "submodules": ["sub/a", "sub/b"]}`      | Renders the repo as an expandable row. Each submodule gets its own dirty count and "open with" buttons. Useful for monorepos where subtrees are edited independently. Submodule entries follow the same shape as parent entries (string or object).                                                                                                                                                                                                                                                          |
| `{"name": "repo", "run": "<cmd>"}`                        | Wires an [inline dev-server runner](inline-runner.md) into that row. `run` is independent of `submodules` — a parent's `run` is **not** inherited by its submodules; add `run` per submodule if they each have their own dev server.                                                                                                                                                                                                                                                                         |
| `{"name": "repo", "run": "<cmd>", "force_stop": "<cmd>"}` | Same as above plus a repo-level **force-stop** button. The button runs `force_stop` as a shell command (`/bin/sh -c` on POSIX, `cmd.exe /d /s /c` on Windows), without going through condash's own process tracking — use it to free a port held by a server condash didn't start. **Per-OS recipes for "kill whatever is holding port 8300":** Linux `fuser -k 8300/tcp` or `pkill -f 'manage.py runserver'`; macOS `lsof -ti tcp:8300 \| xargs kill -9`; Windows `for /f "tokens=5" %a in ('netstat -ano ^ | findstr :8300') do taskkill /F /PID %a`. Same shell trust level as `run` — you're running these commands on your own machine, so a malicious tree is a malicious shell. |
| `{"name": "repo", "label": "<text>"}`                     | Optional human-friendly label. When set, the **label takes the card title slot** on the Code tab and the directory name moves to a small monospace pill alongside it (suppressed when `label === name`). Useful when the directory name is a slug (`alicepeintures.com`) and a friendlier descriptor (`Alice's site`) gives quicker context, while keeping the on-disk name visible. Works on both top-level entries and submodules; combinable with `run` / `force_stop` / `submodules`.                    |

Anything under `workspace_path` not named in either bucket lands in a third `OTHERS` card.

### `open_with`

Three vendor-neutral launcher slots used by the "Open with …" buttons on every repo row and note file:

| Slot            | Typical use                                             |
| --------------- | ------------------------------------------------------- |
| `main_ide`      | Full IDE — IntelliJ IDEA, PyCharm, RustRover, WebStorm. |
| `secondary_ide` | Lighter editor — VS Code, VSCodium, Zed.                |
| `terminal`      | Spawn a terminal already `cd`-ed into the target.       |

Each slot takes a `label` (tooltip text) and a single `command` string.

```json
{
  "open_with": {
    "main_ide": {
      "label": "Open in main IDE",
      "command": "idea {path}"
    }
  }
}
```

`{path}` is substituted with the absolute path of the repo, worktree, or directory being opened. If the command isn't on `$PATH`, the button reports failure via a toast.

> **Schema note.** condash (Electron) takes a single `command` string per slot — there is no `commands` list / fallback chain. If you need a fallback (e.g. `idea` then `idea.sh`), wrap it in a small launcher script that does the trial-and-fall-through itself.

Built-in defaults reproduce common IntelliJ / VS Code / terminal behaviour, so a `configuration.json` with no `open_with` block still gives functional buttons. Override only the slots you want to customise.

#### Per-OS recipes

The `command` is invoked directly (not through a shell) — `~/` and `$VARS` are not expanded except for a leading `~/` which condash rewrites to the user's home. Pick a recipe matching your OS:

| Slot            | Linux                                                                                                                       | macOS                                                                                    | Windows                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `main_ide`      | `idea {path}` · `code {path}`                                                                                               | `open -na "IntelliJ IDEA" --args {path}` · `open -na "Visual Studio Code" --args {path}` | `idea64.exe {path}` · `code {path}` (after VS Code's "Add to PATH" installer step) |
| `secondary_ide` | `codium {path}` · `zed {path}`                                                                                              | `open -na "VSCodium" --args {path}` · `zed {path}`                                       | `code {path}` · `zed {path}`                                                       |
| `terminal`      | `gnome-terminal --working-directory {path}` · `konsole --workdir {path}` · `x-terminal-emulator --working-directory {path}` | `open -a Terminal {path}` · `open -a iTerm {path}` · `open -a Ghostty {path}`            | `wt.exe -d "{path}"` (Windows Terminal) · `cmd.exe /K "cd /d {path}"`              |

### `terminal`

Embedded-terminal preferences. All keys are optional; an empty string means "fall back to the built-in default".

| Key                         | Default                                                 | Meaning                                                                                                                        |
| --------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `shell`                     | `$SHELL` → `/bin/bash`                                  | Absolute path to an interactive shell.                                                                                         |
| `shortcut`                  | `` Ctrl+` ``                                            | Toggle the terminal pane. Modifiers: `Ctrl`, `Shift`, `Alt`, `Meta`. Key names follow the HTML `KeyboardEvent.key` convention. |
| `screenshot_dir`            | `~/Pictures/Screenshots` on Linux, `~/Desktop` on macOS | Directory scanned for "most recent screenshot" by the paste shortcut.                                                          |
| `screenshot_paste_shortcut` | `Ctrl+Shift+V`                                          | Inserts the absolute path of the newest image in `screenshot_dir` into the active terminal. No `Enter` — you confirm.          |
| `launcher_command`          | `claude`                                                | Shell-style command spawned by the secondary `+` button in each terminal side. Empty hides the button.                         |
| `move_tab_left_shortcut`    | `Ctrl+Left`                                             | Move the active tab to the left pane.                                                                                          |
| `move_tab_right_shortcut`   | `Ctrl+Right`                                            | Move the active tab to the right pane.                                                                                         |
| `xterm`                     | `{}`                                                    | xterm.js renderer settings — see [`terminal.xterm`](#terminalxterm) below. Editable through the gear modal's **Terminal** tab. |

### `terminal.xterm` { #terminalxterm }

Visual + behavioural knobs for the xterm.js renderer. All keys are optional; missing keys fall through to xterm's defaults. Edit through the **Settings → Terminal** tab in the gear modal — the editor live-rewrites `configuration.json` and reloads existing tabs without a relaunch.

```json
{
  "terminal": {
    "xterm": {
      "font_family": "JetBrainsMono Nerd Font, ui-monospace, monospace",
      "font_size": 13,
      "line_height": 1.2,
      "letter_spacing": 0,
      "font_weight": "400",
      "font_weight_bold": "600",
      "cursor_style": "block",
      "cursor_blink": true,
      "scrollback": 10000,
      "ligatures": false,
      "colors": {
        "background": "#1e1e2e",
        "foreground": "#cdd6f4",
        "cursor": "#f5e0dc",
        "black": "#45475a",
        "bright_black": "#585b70",
        "red": "#f38ba8",
        "bright_red": "#f38ba8",
        "green": "#a6e3a1",
        "bright_green": "#a6e3a1",
        "yellow": "#f9e2af",
        "bright_yellow": "#f9e2af",
        "blue": "#89b4fa",
        "bright_blue": "#89b4fa",
        "magenta": "#f5c2e7",
        "bright_magenta": "#f5c2e7",
        "cyan": "#94e2d5",
        "bright_cyan": "#94e2d5",
        "white": "#bac2de",
        "bright_white": "#a6adc8"
      }
    }
  }
}
```

| Key                | Type / accepted values              | Meaning                                                                                                                                                                 |
| ------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `font_family`      | string                              | CSS font stack used by xterm. Include a fallback chain since xterm doesn't load web fonts.                                                                              |
| `font_size`        | positive int                        | Pixel font size.                                                                                                                                                        |
| `line_height`      | positive number                     | Multiplier; 1.0 is tight, 1.2–1.4 is comfortable.                                                                                                                       |
| `letter_spacing`   | number                              | Pixels of inter-character spacing.                                                                                                                                      |
| `font_weight`      | `"100"`–`"900"` or keyword          | Default text weight.                                                                                                                                                    |
| `font_weight_bold` | `"100"`–`"900"` or keyword          | Bold-text weight.                                                                                                                                                       |
| `cursor_style`     | `"block"` / `"underline"` / `"bar"` | Cursor shape.                                                                                                                                                           |
| `cursor_blink`     | bool                                | Whether the cursor blinks.                                                                                                                                              |
| `scrollback`       | non-negative int                    | Lines retained per tab. Default 10 000.                                                                                                                                 |
| `ligatures`        | bool                                | Toggle xterm's ligatures addon. Off by default — non-monospace ligatures cause grid-misalignment in some fonts.                                                         |
| `colors.<slot>`    | hex string                          | One entry per ANSI palette slot plus `foreground` / `background` / `cursor` / `cursor_accent` / `selection_background`. Missing slots fall through to xterm's defaults. |

## `settings.json` (per-user, per-machine)

Lives at `${XDG_CONFIG_HOME:-~/.config}/condash/settings.json` on Linux (the matching paths on macOS and Windows are listed in [At a glance](#at-a-glance)). Not versioned. Every key is optional — a fresh install starts with the file empty (or absent) and fills it on first launch.

```json
{
  "conception_path": "/home/you/src/vcoeur/conception",
  "theme": "auto",
  "terminal": {
    "shell": "/bin/zsh",
    "shortcut": "Ctrl+T",
    "launcher_command": "claude",
    "screenshot_dir": "/home/you/Pictures/Screenshots"
  },
  "open_with": {
    "main_ide": { "label": "Open in main IDE", "command": "idea {path}" },
    "secondary_ide": { "label": "Open in secondary IDE", "command": "code {path}" }
  }
}
```

| Key                                  | Meaning                                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `conception_path`                    | Absolute path to the conception tree condash should render.                                                                           |
| `theme`                              | `light`, `dark`, or `auto`. Persisted by `setTheme`.                                                                                  |
| `terminal.*`                         | Same keys as the tree-level `terminal` block above; any field set here overrides the tree value. Missing fields fall through.         |
| `open_with.<slot>.label`, `.command` | Merged per slot. The user's `command` replaces the tree's; the user's `label` replaces the tree's. Tree-only slots survive untouched. |

Resolution order for the conception path, checked in sequence:

1. `conception_path` in this file.
2. The first-launch folder picker. The picker writes the chosen path back into `settings.json` so the next launch picks it up automatically.
3. Hard error — condash refuses to start without a conception path.

The file is created on demand: the first-launch folder picker writes it; you can also create it by hand.

## Editing from the dashboard

Click the gear icon in the header. A modal opens with a plain-text JSON editor showing the contents of `configuration.json` — the tree-level file. Save is atomic (`tmp` → `fsync` → `rename`), so a crash during save never corrupts the file. Save runs the JSON through the [strict zod schema](https://github.com/vcoeur/condash/blob/main/src/main/config-schema.ts) — malformed shapes are rejected before the write lands on disk and the modal surfaces the validation error.

Editing `settings.json` is hand-edit only today — no UI surface beyond the first-launch folder picker and the theme toggle. Use your editor of choice; condash re-reads it on the next launch.

Changes that **do** need a restart:

- `workspace_path` or `worktrees_path` change — the filesystem scanner is built once at launch.
- `repositories` list change — the per-repo state is built once at launch.

Changes that reload live without a restart:

- Everything under `open_with`, `terminal`.
- `run` / `force_stop` on an existing repo entry.

## See also

- [Environment variables](env.md) — what condash reads from the environment, and what it deliberately doesn't.
- [Inline dev-server runner](inline-runner.md) — the `run` field in `configuration.json`.
- [Terminal shortcuts](shortcuts.md) — what each `terminal.*` shortcut does in the UI.
