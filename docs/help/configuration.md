# Configuration

condash reads two JSON files. Both are optional — sensible defaults
apply when keys are missing.

| File | Where | Owns |
|---|---|---|
| `configuration.json` | `<conception>/configuration.json` | Workspace + repositories (versioned in git) |
| `settings.json` | `~/.config/condash/settings.json` (Linux) | This-machine prefs (terminal, IDE, theme) |

**Per-machine values win.** When the same key appears in both files,
`settings.json` overrides `configuration.json`, merged field by field.

## `configuration.json` — minimal example

```json
{
  "workspace_path": "/home/you/src",
  "worktrees_path": "/home/you/src/worktrees",
  "repositories": {
    "primary": [
      "condash",
      { "name": "myapp", "run": "make dev" }
    ],
    "secondary": ["conception"]
  }
}
```

| Key | Meaning |
|---|---|
| `workspace_path` | Where condash scans for git repos. |
| `worktrees_path` | Sandbox for the "Open in IDE" buttons. |
| `repositories.primary` / `.secondary` | Repos to surface on the Code tab. Each entry is a string or an object with `name`, optional `submodules`, `run`, `force_stop`, `label`. |

A repo entry's `run` wires up an inline dev-server runner; `force_stop`
gives a kill button that frees a stuck port (e.g. `fuser -k 8200/tcp`).

## `settings.json` — minimal example

```json
{
  "conception_path": "/home/you/conception",
  "theme": "auto",
  "terminal": {
    "shell": "/bin/zsh",
    "shortcut": "Ctrl+T",
    "screenshot_dir": "/home/you/Pictures/Screenshots"
  },
  "open_with": {
    "main_ide": { "label": "Open in IDE", "command": "code {path}" }
  }
}
```

The first-launch folder picker writes `conception_path` for you. Theme
follows the OS unless you set it explicitly via the toolbar toggle.

`{path}` in any `open_with` command is replaced with the absolute path
of the repo, worktree, or directory being opened.

## Editing in the app

Click the gear icon in the header. The modal opens a JSON editor for
`configuration.json` (validated on save, atomic write). The Terminal
tab and theme toggle write to `settings.json`.

`settings.json` has no full-file editor — hand-edit it if you need the
extra keys. condash re-reads on next launch.

## When changes apply

| Change | Effect |
|---|---|
| `open_with`, `terminal`, repo `run` / `force_stop` | Live, no restart |
| `workspace_path`, `worktrees_path`, repository list | Restart required |

## More

The full key-by-key reference (every `terminal.xterm.*` colour slot,
per-OS launcher recipes, env var overrides) lives online at
**https://condash.vcoeur.com/reference/config/**.
