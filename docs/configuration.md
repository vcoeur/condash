# `configuration.json` reference

condash reads workspace + preferences from `<conception>/configuration.json`. This is the single tree-level config file; the per-machine settings (theme, last conception path) live in Electron's `userData` as `settings.json` and aren't intended for hand editing.

The schema is enforced by `src/main/config-schema.ts` (zod, `.strict()` — unknown keys are rejected on save).

## Editing paths

- **In-app gear modal** — toolbar `⚙` button. Opens the file in the existing CodeMirror editor with JSON syntax highlighting; save runs the schema check and rejects invalid input with a precise error.
- **Hand-edit in your IDE** — `<conception>/configuration.json`. The watcher fires a `config` event 250 ms after the write; the renderer reloads its derived data automatically.

## Top-level keys

| Key | Type | Required | Purpose |
|---|---|---|---|
| `workspace_path` | string | no | Absolute path to your code workspace root. Used as the base for non-absolute repo entries (e.g. `repositories.primary[0] = "condash"` resolves to `<workspace_path>/condash`). |
| `worktrees_path` | string | no | Absolute path to where `git worktree add` puts new worktrees. Currently informational; condash discovers worktrees per-repo via `git worktree list`. |
| `repositories.primary` | array | no | Repos that surface as `PRIMARY` cards on the Code tab. |
| `repositories.secondary` | array | no | Repos that surface as `SECONDARY` cards (libraries / dependencies you don't run). |
| `open_with` | object | no | Slot definitions for the per-branch action menu (Open in IDE, Open terminal). |
| `pdf_viewer` | array of strings | no | Reserved for future use. |
| `terminal` | object | no | Pane shell + shortcuts + screenshot directory. |

## Repository entries

Each entry is either a bare string (the directory name) or an object:

```json
{
  "name": "condash",
  "run": "make dev",
  "force_stop": "fuser -k 5600/tcp",
  "submodules": [
    { "name": "app", "run": "make dev" }
  ]
}
```

| Field | Type | Purpose |
|---|---|---|
| `name` | string | Directory name (relative to `workspace_path`) or absolute path. Submodule entries use `name` relative to the parent. |
| `run` | string | Command executed by the Run button. Wrapped in `bash -lc`, so `make dev && tail -f log` and other shell features work. |
| `force_stop` | string | Shell command run during the Stop pipeline, between SIGTERM and the SIGKILL fallback. Useful when the dev process daemonises or detaches a port-holder. |
| `submodules` | array | Recursive — same shape as `primary` / `secondary` entries. Submodules render under the parent's group on the Code tab. |

Bare-string entries are equivalent to `{ "name": "<string>" }` with no run / force_stop / submodules.

## `open_with`

Three slots: `main_ide`, `secondary_ide`, `terminal`. Each:

```json
{
  "label": "WebStorm",
  "command": "webstorm \"{path}\""
}
```

| Field | Purpose |
|---|---|
| `label` | Shown in the per-branch dropdown. |
| `command` | Argv template. `{path}` is replaced at the *argument* level (no shell injection). Quotes group whitespace tokens. |

## `terminal`

Pane preferences and shortcuts:

| Field | Purpose | Default |
|---|---|---|
| `shell` | Shell binary used when spawning the pty. | `$SHELL`, falling back to `/bin/bash` or `cmd.exe`. |
| `shortcut` | Toggle the bottom pane. | `Ctrl+\`` |
| `move_tab_left_shortcut` | Move the active tab one slot to the left. | `Ctrl+Left` |
| `move_tab_right_shortcut` | Move the active tab one slot to the right. | `Ctrl+Right` |
| `screenshot_dir` | Directory scanned by the screenshot-paste shortcut. | unset (shortcut disabled) |
| `screenshot_paste_shortcut` | Type the path of the most recently modified file in `screenshot_dir` into the active pty. | unset |
| `launcher_command` | Command line used by the bottom pane's "+" button when no repo is targeted. Defaults to a plain shell. | unset |

## Worked example

```json
{
  "$schema_doc": "https://github.com/vcoeur/condash/blob/main/docs/configuration.md",
  "workspace_path": "/home/alice/src/vcoeur",
  "worktrees_path": "/home/alice/src/worktrees",
  "repositories": {
    "primary": [
      {
        "name": "condash",
        "run": "make dev",
        "force_stop": "fuser -k 5600/tcp"
      },
      {
        "name": "alicepeintures.com",
        "run": "make dev",
        "force_stop": "fuser -k 8000/tcp",
        "submodules": [{ "name": "app", "run": "make dev" }]
      }
    ],
    "secondary": ["knoten", "quelle"]
  },
  "open_with": {
    "main_ide": { "label": "WebStorm", "command": "webstorm \"{path}\"" },
    "terminal": { "label": "Konsole", "command": "konsole --workdir \"{path}\"" }
  },
  "terminal": {
    "shell": "/usr/bin/zsh",
    "shortcut": "Ctrl+`",
    "screenshot_dir": "/home/alice/Pictures/Screenshots",
    "screenshot_paste_shortcut": "Ctrl+Shift+V"
  }
}
```

## Why JSON, not YAML

condash is markdown-first — every project, knowledge note, and incident lives as a `.md`. The configuration file is the one structured data file in the tree, and JSON wins on three counts:

- **Stdlib parser** in both Node and the renderer; no `js-yaml` dep.
- **Strict schema validation** via zod's discriminated unions reads more naturally over a JSON tree than over YAML's anchors / merge keys.
- **In-app editing** in CodeMirror is more reliable for JSON (real syntax errors, real auto-formatting) than for YAML.

Migrating to YAML is a non-goal (see [`non-goals.md`](non-goals.md)).

## Schema source of truth

`src/main/config-schema.ts`. Any addition to the schema must update this document in the same commit.
