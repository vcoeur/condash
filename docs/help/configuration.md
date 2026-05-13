# Configuration

condash reads two JSON files. Both are optional — sensible defaults
apply when keys are missing — and **both share the same schema**, so
any workspace key can live in either file.

| File | Where | Lifecycle |
|---|---|---|
| `settings.json` | `~/.config/condash/settings.json` (Linux) | Per-machine. Owns `lastConceptionPath` + `recentConceptionPaths` (cap 5) and global defaults for every other key. |
| `condash.json` | `<conception>/condash.json` (legacy fallback `configuration.json`) | Per-conception, versioned in git. Carries overrides that win at top-level granularity. |

**Override model**: top-level keys in `condash.json` replace the matching
keys in `settings.json` entirely (arrays replace, objects replace
whole, no deep merge). The only fields a conception cannot describe
are `lastConceptionPath` and `recentConceptionPaths`.

**Read precedence** for the per-conception file: `condash.json` →
`configuration.json` (legacy fallback, supported indefinitely). Writes
always target `condash.json`.

## `condash.json` — minimal example

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
| `repositories` | Ordered list of repos to surface on the Code pane. Each entry is a string, a `{name, …}` object (optional `submodules`, `run`, `force_stop`, `label`, `install`, `env`, `pinned_branch`), or a `{"section": "<heading>"}` marker that groups every following repo under a header — see [Reference → Configuration → `repositories`](../reference/config.md#repositories) for the full table. |
| `open_with` | Three launcher slots (`main_ide`, `secondary_ide`, `terminal`). `{path}` is replaced with the absolute target path. |

A repo entry's `run` wires up an inline dev-server runner; `force_stop`
gives a kill button that frees a stuck port (e.g. `fuser -k 8200/tcp`).

## `settings.json` — minimal example

```json
{
  "lastConceptionPath": "/home/you/conception",
  "recentConceptionPaths": [
    "/home/you/conception",
    "/home/you/work/conception"
  ],
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

The first-launch folder picker writes `lastConceptionPath` for you and
prepends the path to `recentConceptionPaths`. Theme follows the OS
unless you set it explicitly via the toolbar toggle.

Workspace keys (`workspace_path`, `worktrees_path`, `repositories`,
`open_with`, `pdf_viewer`, …) are also valid in `settings.json` as
global defaults. A conception's `condash.json` may override any of
them per-tree.

## Editing in the app

**File → Settings…** (`Ctrl+,`) opens a full-viewport modal with a
two-tab layout. There is no in-modal JSON editor — each preference has
its own form control.

**Global** tab (writes to `settings.json`):

- **Recent conception paths** — manage the recents list backing
  **File → Open Recent**.
- **Appearance** — theme; per-pane card-grid min-widths.
- **Terminal** — embedded terminal preferences.

**This conception** tab (writes to `condash.json`; the legacy
`configuration.json` is read but never written to):

- **Workspace** — `workspace_path`, `worktrees_path`, `resources_path`,
  `skills_path`.
- **Repositories** — ordered repo list, per-repo `run` / `force_stop`.
- **Open with** — slot labels and commands.
- **Appearance** — theme + card-grid min-widths overridden for this
  conception only.
- **Terminal** — `terminal` block overridden for this conception only.

Inheritance badges on the **This conception** tab call out where each
top-level key sits relative to the global value:

- **Inherits** — no override in `condash.json`. The effective value is
  whatever `settings.json` (or the bundled default) provides. Editing
  the field on this tab writes the override.
- **Overridden** — `condash.json` sets the key to a value that differs
  from `settings.json`. A **Reset to global** button drops the
  override and falls back to inheritance.
- **Matches global** — `condash.json` carries the key but the value
  matches `settings.json` exactly. The override is redundant; a
  **Remove override** button clears the line so the key inherits.

The rail at the left of the modal carries **Save** (flush focused-but-
unblurred edits) and **Open externally** (open the active tab's file
in your `$EDITOR`). Modal writes round-trip through the same atomic
save + schema-validation path the CLI uses, either way.

## File → Open Recent

The application menu shows up to 5 recently-opened conception paths
(newest first) under **File → Open Recent**. Picking an entry switches
the active conception immediately (no folder dialog) and promotes the
path to the head of the list. The Settings modal's **Recent conception
paths** section lets you remove individual entries or clear all.

## CLI

The `condash-cli config` verbs read and write the same files:

```sh
condash-cli config path                       # show both file paths
condash-cli config list                       # show condash.json
condash-cli config list --global              # show settings.json
condash-cli config list --effective           # show merged view (conception ⊕ global)
condash-cli config get repositories[0]        # query the conception layer
condash-cli config get theme --effective      # query the merged view
condash-cli config get theme --global         # query settings.json
condash-cli config set theme dark             # write to condash.json
condash-cli config set theme dark --global    # write to settings.json
```

## When changes apply

| Change | Effect |
|---|---|
| `open_with`, `terminal`, repo `run` / `force_stop`, `cardMinWidth`, theme | Live, no restart |
| `workspace_path`, `worktrees_path`, `resources_path`, `skills_path`, repository list | Restart required |

## More

The full key-by-key reference lives at
**https://condash.vcoeur.com/reference/config/**.
