# Configuration

condash reads two JSON files. Both are optional — sensible defaults
apply when keys are missing — and the two have **disjoint schemas**, so
every setting key lives in exactly one of them.

| File | Where | Lifecycle |
|---|---|---|
| `settings.json` | `~/.config/condash/settings.json` (Linux) | Per-machine. Holds everything personal — appearance, terminal, launchers, open-with, the dashboard — plus `lastConceptionPath` + `recentConceptionPaths` (cap 5). |
| `.condash/settings.json` | `<conception>/.condash/settings.json` (legacy fallbacks `condash.json`, `configuration.json`) | Per-conception, **per-host** (gitignored by default). Holds only this tree's `workspace_path`, `worktrees_path`, `repositories`, `retired_apps`, `taskConfig`. |

**Key ownership**: every setting has exactly one home — there is no
override, inheritance, or merge. A key written to the wrong file is
rejected by the strict schema; on conception open, condash's
scope-partition migrator relocates any mis-homed key to its owning file.
A conception cannot describe its own location, so `lastConceptionPath`
and `recentConceptionPaths` are global-only.

**Read precedence** for the per-conception file: `.condash/settings.json`
(canonical) → `condash.json` (legacy) → `configuration.json` (legacy²).
Both legacy filenames are read indefinitely with no deprecation date;
writes always target `.condash/settings.json`.

## `.condash/settings.json` — minimal example

```json
{
  "workspace_path": "/home/you/src",
  "worktrees_path": "/home/you/src/worktrees",
  "repositories": [
    "condash",
    { "name": "myapp", "run": "make dev" },
    "conception"
  ]
}
```

Only the tree-shape keys (`workspace_path`, `worktrees_path`, `long_lived_branches`, `repositories`, `retired_apps`, `taskConfig`) are valid here — personal keys like `open_with`, `pdf_viewer`, and `terminal` belong to the global `settings.json`.

| Key | Meaning |
|---|---|
| `workspace_path` | Where condash scans for git repos. |
| `worktrees_path` | Sandbox for the "Open in IDE" buttons. |
| `long_lived_branches` | Branch patterns (`*` / `?` globs) that `condash worktrees remove` never deletes. Defaults to `main` + `master`. |
| `repositories` | Ordered list of repos to surface on the Code pane. Each entry is a string, a `{name, …}` object (optional `submodules`, `run`, `force_stop`, `label`, `install`, `env`, `pinned_branch`), or a `{"section": "<heading>"}` marker that groups every following repo under a header — see [Reference → Configuration → `repositories`](../reference/config.md#repositories) for the full table. |

The Skills pane (`<conception>/.agents/skills/`) and Resources pane
(`<conception>/resources/`) read hard-coded folders — no override is
available since the reframe.

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
    "skills": 280,
    "logs": 400,
    "tasks": 340,
    "deliverables": 340
  }
}
```

The first-launch folder picker writes `lastConceptionPath` for you and
prepends the path to `recentConceptionPaths`. Theme follows the OS
unless you set it explicitly via the toolbar toggle.

Personal keys (`terminal`, `theme`, `uiFonts`, `cardMinWidth`, `open_with`,
`pdf_viewer`, `dashboard`, `agents`, …) live **only** in `settings.json`;
the tree-shape keys (`workspace_path`, `worktrees_path`, `long_lived_branches`,
`repositories`, `retired_apps`, `taskConfig`) live **only** in `.condash/settings.json`.
A key in the wrong file is rejected (and relocated on the next conception
open).

## Editing in the app

**File → Settings…** (`Ctrl+,`) opens a full-viewport modal — one
scrolling surface, no tabs, no in-modal JSON editor (each preference has
its own form control). The left rail groups the sections under two scope
headers, one per file, and each section carries a **scope chip** naming
the file it writes.

**Personal · this machine** (writes `settings.json`):

- **Recent conceptions** — manage the recents list backing
  **File → Open Recent**.
- **Appearance** — theme; project-card title font; per-pane card-grid min-widths.
- **Terminal** — embedded terminal preferences.
- **Launchers** — the `agents` list.
- **Open with** — slot labels and commands.
- **Dashboard** — live tab-summarization config (incl. the secret `apiKey`).

**This conception** (writes `.condash/settings.json`; the legacy
`condash.json` and `configuration.json` are read but never written to):

- **Workspace & paths** — `workspace_path`, `worktrees_path`, `long_lived_branches`.
- **Repositories** — ordered repo list, per-repo `run` / `force_stop`.

Because every setting has exactly one home, there are no inheritance
badges, no override state, and no **Reset to global** buttons — that
machinery was removed with the scope-partition revamp. A small **dirty
pip** next to a section flags unsaved edits; **Save** flushes every
staged draft and **Discard** drops them. Each draft round-trips through
the same atomic save + schema-validation path the CLI uses.

## File → Open Recent

The application menu shows up to 5 recently-opened conception paths
(newest first) under **File → Open Recent**. Picking an entry switches
the active conception immediately (no folder dialog) and promotes the
path to the head of the list. The Settings modal's **Recent conception
paths** section lets you remove individual entries or clear all.

## CLI

The `condash config` verbs read and write the same files:

```sh
condash config path                       # show both file paths
condash config list                       # show .condash/settings.json
condash config list --global              # show settings.json
condash config list --effective           # combined read view (both files)
condash config get repositories[0]        # query the conception file
condash config get theme --effective      # theme is a personal key — read the combined view
condash config get theme --global         # query settings.json
condash config set workspace_path /src    # auto-routed to .condash/settings.json (tree key)
condash config set theme dark             # auto-routed to settings.json (personal key)
```

## When changes apply

| Change | Effect |
|---|---|
| `open_with`, `terminal`, repo `run` / `force_stop`, `cardMinWidth`, theme | Live, no restart |
| `workspace_path`, `worktrees_path`, repository list | Restart required |

## More

The full key-by-key reference lives at
**https://condash.vcoeur.com/reference/config/**.
