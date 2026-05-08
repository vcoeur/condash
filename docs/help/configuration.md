# Configuration

condash reads two JSON files. Both are optional — sensible defaults
apply when keys are missing.

| File | Where | Owns |
|---|---|---|
| `configuration.json` | `<conception>/configuration.json` | Workspace + repositories (versioned in git) |
| `settings.json` | `~/.config/condash/settings.json` (Linux) | This-machine prefs (terminal, IDE, theme) |

**Each key lives in exactly one file** — the two configs own disjoint
key sets. See [reference/config.md](../reference/config.md#at-a-glance)
for the split.

## `configuration.json` — minimal example

```json
{
  "workspace_path": "/home/you/src",
  "worktrees_path": "/home/you/src/worktrees",
  "repositories": [
    "condash",
    { "name": "myapp", "run": "make dev" },
    "conception"
  ],
  "open_with": {
    "main_ide": { "label": "Open in IDE", "command": "code {path}" }
  }
}
```

| Key | Meaning |
|---|---|
| `workspace_path` | Where condash scans for git repos. |
| `worktrees_path` | Sandbox for the "Open in IDE" buttons. |
| `resources_path` | Folder backing the Resources pane. Default `resources`. |
| `skills_path` | Folder backing the Skills pane. Default `.claude/skills`. |
| `repositories` | Flat ordered list of repos to surface on the Code pane. Each entry is a string or an object with `name`, optional `submodules`, `run`, `force_stop`, `label`. |
| `open_with` | Three launcher slots (`main_ide`, `secondary_ide`, `terminal`) — tree-side so teammates pick them up automatically. `{path}` is replaced with the absolute target path. |

A repo entry's `run` wires up an inline dev-server runner; `force_stop`
gives a kill button that frees a stuck port (e.g. `fuser -k 8200/tcp`).

## `settings.json` — minimal example

```json
{
  "conceptionPath": "/home/you/conception",
  "theme": "system",
  "terminal": {
    "shell": "/bin/zsh",
    "shortcut": "Ctrl+T",
    "screenshot_dir": "/home/you/Pictures/Screenshots"
  },
  "cardMinWidth": {
    "projects": 650,
    "code": 650,
    "knowledge": 520,
    "resources": 280,
    "skills": 280
  }
}
```

The first-launch folder picker writes `conceptionPath` for you. Theme
follows the OS unless you set it explicitly via the toolbar toggle.

`open_with` and `pdf_viewer` are **not** valid in `settings.json` — they
are tree-side, in `configuration.json`, so teammates pick them up
automatically. Setting them in `settings.json` is silently ignored.

## Editing in the app

**File → Settings…** (`Ctrl+,`) opens a sidebar-rail modal. There is no
in-modal JSON editor — each preference has its own form control,
grouped by which file it writes to.

**Global Condash Settings** (write to `settings.json`):

- **Appearance** — theme; per-pane card-grid min-widths (Projects /
  Code / Knowledge / Resources / Skills).
- **Terminal** — embedded terminal preferences (shell, shortcuts,
  xterm.js fonts and colours).

**Conception Configuration** (write to `configuration.json`):

- **Workspace** — `workspace_path`, `worktrees_path`, `resources_path`,
  `skills_path`.
- **Repositories** — ordered repo list, per-repo `run` / `force_stop`.
- **Open with** — slot labels and commands.

Power users can hit **Open configuration.json externally** in the
header to edit the raw JSON in their `$EDITOR`. Modal writes round-trip
through the same atomic save + schema validation path either way.

## When changes apply

| Change | Effect |
|---|---|
| `open_with`, `terminal`, repo `run` / `force_stop`, `cardMinWidth`, theme | Live, no restart |
| `workspace_path`, `worktrees_path`, `resources_path`, `skills_path`, repository list | Restart required |

## More

The full key-by-key reference (every `terminal.xterm.*` colour slot,
per-OS launcher recipes, env var overrides) lives online at
**https://condash.vcoeur.com/reference/config/**.
