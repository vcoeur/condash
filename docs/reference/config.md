---
title: Config files · condash reference
description: The two JSON files condash reads (per-tree and per-machine) and what every key means.
---

# Config files

> **Audience.** Daily user.

condash reads two JSON files. Both share **the same schema**. The per-machine `settings.json` carries global defaults (and the only two fields a conception cannot describe — its own active path and the recents list). The per-conception `.condash/settings.json` carries overrides that win at top-level granularity. Either file is optional — the dashboard runs with sensible defaults.

## At a glance

| File                     | Path                                                                                                                                                                        | Lifecycle                                 | Owns exclusively                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------- |
| `settings.json`          | `${XDG_CONFIG_HOME:-~/.config}/condash/settings.json` (Linux) · `~/Library/Application Support/condash/settings.json` (macOS) · `%APPDATA%\condash\settings.json` (Windows) | Per-user, per-machine                     | `lastConceptionPath`, `recentConceptionPaths` (cap 5) |
| `.condash/settings.json` | `<conception_path>/.condash/settings.json` (legacy fallbacks: `condash.json`, `configuration.json`)                                                                         | Per-conception, **per-host** (gitignored) | (none — every key here also accepts a global default) |

Both files share the **same schema** modulo the two path-tracking keys above. Every other top-level key (`workspace_path`, `worktrees_path`, `repositories`, `retired_apps`, `agents`, `taskConfig`, `open_with`, `pdf_viewer`, `terminal`, `theme`, `layout`, `welcome`, `cardMinWidth`, `treeExpansion`, `selectedBranches`, `branchFilterStickyAll`) may live in either file — see the [full table](#all-config-keys) below. When the same key appears in both, the conception's value **replaces** the global one entirely (top-level replace; arrays replace, objects replace whole, no deep merge — the one exception is `terminal`, below).

**Exception: `terminal` merges one level deep.** Its sub-schema straddles per-machine input / device prefs (`shell`, `shortcut`, `screenshot_dir`, `xterm`, `screenshot_paste_shortcut`, `move_tab_{left,right}_shortcut`) and per-tree retention policy (`logging.{enabled, retentionDays, maxDirMb, scrollback}`). A pure replace meant any conception that customised `terminal.logging` silently lost every per-machine terminal pref — the screenshot-paste shortcut toasted "no screenshot directory". Conception sub-keys win at the first level; sub-keys absent from the conception fall through to the global block. Nested values inside `terminal.xterm` and `terminal.logging` still replace whole — only the immediate sub-keys of `terminal` merge.

### The `.condash/` workspace directory

`.condash/` is condash's per-conception state directory — the home of `settings.json` plus terminal logs at `.condash/logs/YYYY/MM/DD/HHMMSS-<sid>.txt`. **The whole directory is gitignored by default** (the auto-migrator appends a `.condash/` line to your `.gitignore` on first run when the conception is a git repo), so settings + logs are per-host state with no commit-leak risk. Teams that want to share a baseline config either commit `condash.json` alongside (legacy path still reads) or manually un-ignore `settings.json` in their `.gitignore`.

### Reading and writing

- **Read precedence**: `<conception>/.condash/settings.json` (canonical) → `<conception>/condash.json` (legacy) → `<conception>/configuration.json` (legacy²). Both legacy filenames are read indefinitely with no deprecation date.
- **Write target**: every save through the GUI or `condash config set` writes to `.condash/settings.json`. The auto-migrator copies the legacy content into the new path on first open, tombstones the source file (so accidental edits don't drift), and appends `.condash/` to `.gitignore`. Run `condash config migrate` to invoke it explicitly.
- **Override scope**: a conception's `settings.json` is forbidden from setting `lastConceptionPath` or `recentConceptionPaths` — a tree cannot describe its own location, by design.
- **Environment override**: `CONDASH_CONCEPTION_PATH` still wins for the session, matching the legacy behaviour.

## All config keys { #all-config-keys }

Every top-level key, in one place. **Scope** is which file the key is valid in: *both* keys act as a per-machine default in `settings.json` and a per-conception override in `.condash/settings.json`; *global-only* keys are rejected in a conception file (a tree cannot describe its own location).

| Key | Scope | Type | Default | What it does |
|-----|-------|------|---------|--------------|
| `workspace_path` | both | string | — | Root condash resolves repo paths against; populates the Code pane. Unset hides the pane. [↓](#workspace-keys) |
| `worktrees_path` | both | string | — | Extra sandbox root accepted by the "open in IDE" launchers. [↓](#workspace-keys) |
| `repositories` | both | array | `[]` | Ordered Code-pane repo list; also the app registry (`#handle`, `label`, `aliases`, `run`, `submodules`, `section`). [↓](#repositories) |
| `retired_apps` | both | array | `[]` | Defunct `#handle`s still referenced by closed projects — resolve, never rendered. [↓](#retired_apps) |
| `agents` | both | array | `[]` | Flat `{id,label,command}` terminal-launcher list shown in the tab-strip spawn dropdown. [↓](#agents) |
| `taskConfig` | both | object | — | Per-task `{schedule?, timeout?, runMode?, excludeFromLogs?}` keyed by slug — opt-in headless scheduling + run timeout + run mode (`--prompt`/`--run`) + run-log routing. [↓](#tasks) |
| `open_with` | both | object | — | The three IDE/terminal launch slots (`main_ide`, `secondary_ide`, `terminal`). [↓](#open_with) |
| `pdf_viewer` | both | array | — | Ordered fallback chain of external PDF viewers. |
| `terminal` | both | object | — | Shell, shortcuts, screenshot dir, `xterm` theming, `logging`. **Merges one level deep** (the sole exception to top-level replace). [↓](#terminal) |
| `theme` | both | enum | `system` | `light` \| `dark` \| `system`. |
| `layout` | both | object | — | Persisted pane layout, including `leftView` (`projects` \| `tasks` \| `deliverables`). [↓](#layoutstate) |
| `welcome` | both | object | — | `{ dismissed }` — first-launch welcome-screen state. |
| `cardMinWidth` | both | object | — | Per-surface minimum card width. [↓](#cardminwidth) |
| `treeExpansion` | both | object | — | Remembered expand/collapse state of the tree panes. |
| `selectedBranches` | both | array | `[]` | Code-pane branch-filter selection. |
| `branchFilterStickyAll` | both | boolean | `true` | Branch filter "All (sticky)" mode — show every branch and auto-pin new ones. |
| `lastConceptionPath` | global-only | string\|null | `null` | Currently-open conception path. |
| `recentConceptionPaths` | global-only | array | `[]` | Most-recently-opened paths, newest first (cap 5). |

Task *definitions* are **not** a config key — they live on disk at `<conception>/tasks/<slug>/` (see [Tasks](#tasks)). Their per-task **scheduling / log-routing** lives in the `taskConfig` key above, keyed by slug. condash also persists a few small UI-state fields it manages itself (e.g. `skillsActiveScope`, the last-active Settings tab) in `settings.json`; you don't edit those by hand. Strict-mode validation rejects any unknown top-level key on save.

## `.condash/settings.json` (per-conception, per-host)

Lives at `<conception_path>/.condash/settings.json`. Don't commit it — the auto-migrator gitignores `.condash/` for you. Every key is optional — a minimal valid file is `{}`, in which case condash uses globals (or built-in defaults) everywhere. Strict-mode validation: extra top-level keys are rejected on save.

> **Legacy filenames.** Older trees ship `condash.json` (canonical before this migration) or `configuration.json` (legacy²) at the conception root. Both are still read; the migrator lifts their content into `.condash/settings.json` on first open. Don't hand-rename — let the migrator run.

```json
{
  "workspace_path": "/home/you/src",
  "worktrees_path": "/home/you/src/worktrees",
  "repositories": [
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
    },
    "conception"
  ],
  "open_with": {
    "main_ide": { "label": "Open in main IDE", "command": "idea {path}" },
    "secondary_ide": { "label": "Open in secondary IDE", "command": "code {path}" },
    "terminal": { "label": "Open terminal here", "command": "ghostty --working-directory={path}" }
  },
  "pdf_viewer": ["zathura", "okular", "evince"]
}
```

Paths may use `~` (expanded to `$HOME`) or absolute paths. JSON does not carry comments — keep prose documentation in the project README or the per-tree `CLAUDE.md`.

A `terminal` block at this level is a valid per-conception override. The boot-time migration in older condash builds lifted any pre-existing `terminal` block out of `configuration.json` and into `settings.json`; that migration still runs and is idempotent. With the unified schema, a fresh `.condash/settings.json` may carry its own `terminal` block — and unlike every other top-level key, the per-conception block **merges with** the global one (see the exception called out at the top of this page). A conception declaring `terminal.logging.retentionDays` keeps the global `terminal.screenshot_dir` it inherited.

The legacy `terminal.launchers` array and the scalar `terminal.launcher_command` (condash ≤ 3.25) are dropped from the file on the next write — the tab-strip dropdown is now populated from the top-level [agents](#agents) list. A legacy action-template `launcher` binding is renamed to `agent` in place.

### Terminal logging

Inside the `terminal` block, `terminal.logging` configures per-session capture. Each pty spawn produces a **single plain-text file** at `<conception>/.condash/logs/YYYY/MM/DD/HHMMSS-<sid>.txt`. Metadata travels inside the file as two `# condash: {...}` JSON lines:

- **Header** (line 1, always present) — `{ sid, side, repo?, cwd, cmd, argv, started }`.
- **Footer** (last line, only after the session exits) — `{ finished, exitCode }`.

The writer pipes pty bytes through a headless xterm (`@xterm/headless`), every 5 s renders each buffer row via `IBufferLine.translateToString(true)`, composes header + body (+ footer if exited), and atomically rewrites the file. Output is plain UTF-8 — no SGR, no CSI, no cursor-forward — so the file is grep-friendly and the viewer needs no ANSI parser. Colour / bold / underline fidelity belongs to the live terminal's **Save buffer** button.

Typed keystrokes are _not_ captured separately — the pty echoes them back through stdout, so the rendered buffer already shows what was typed. The Logs working surface (`View → Show Logs`, `Cmd+Shift+L`) lists sessions grouped by day; clicking a card opens a full-overlay viewer modal with virtualised text + case-insensitive search.

| Key             | Type          | Default | Meaning                                                                                                                                                                                                                                                  |
| --------------- | ------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`       | boolean       | `false` | Toggle capture entirely. Default flipped to opt-in for privacy (2.25.0). Disabling stops new writes on the next session spawn; existing files stay on disk for the janitor. The Logs pane stays usable for browsing past transcripts even when disabled. |
| `retentionDays` | integer ≥ 0   | `14`    | Day-directories older than this are removed on next janitor run. `0` disables age-based eviction (the size cap still applies).                                                                                                                           |
| `maxDirMb`      | integer ≥ 0   | `500`   | Total cap on `<conception>/.condash/logs/`. The janitor evicts oldest day-directories first while over cap, regardless of age.                                                                                                                           |
| `scrollback`    | integer ≥ 100 | `5000`  | Scrollback lines retained by the per-session headless xterm. Larger → more history captured, larger `.txt` files; smaller → older output rolls off the top of the buffer (same semantics as the live pane).                                              |

The janitor runs at app startup and every 24 hours: it (1) deletes day-dirs older than `retentionDays`, then (2) evicts the oldest surviving day-dir while total size is over `maxDirMb`. No compression pass since v2.27.0 — plain `.txt` files are small enough at the scrollback cap that gzip is not worth the round-trip cost. Errors are logged to stderr and never propagate into the IPC layer.

**Migration from `maxFileMb` / `ansiPolicy`:** both fields were dropped from the schema in v2.23.0 when per-file rotation and ANSI stripping were retired. Settings files that still carry them (typically conceptions upgraded straight from ≤ 2.22) are scrubbed in-flight on every read and the legacy keys vanish from disk on the next settings write — no manual action.

Legacy formats — JSONL event streams from condash ≤ 2.22, compressed `.txt.gz` files from 2.23–2.26 — are ignored by the new viewer and global search. They sit on disk until the janitor's age-based eviction sweeps them. To clear them immediately, delete `<conception>/.condash/logs/` and start fresh.

### Workspace keys

| Key              | Meaning                                                                                                                                                                                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace_path` | Directory condash resolves relative repo paths against. Every direct subdirectory containing a `.git/` shows up in the **Code** pane. If unset, the pane is hidden. Repos with an explicit `path` may live outside this root.                                                    |
| `worktrees_path` | Additional sandbox for the "open in IDE" buttons. Paths outside `workspace_path` and `worktrees_path` are rejected before the shell sees them.                                                                                                                                   |

Since the reframe, two panes read **hard-coded** directories — no config key controls either:

- The **Skills** pane reads the agedum sources at `<conception_path>/.agents/skills/` (and `~/.agents/skills/` for the User scope). The former `skills_path` key was dropped; condash never reads compiled per-harness outputs (`.claude/`, `.kimi/`, …). See the [Skills pane guide](../guides/skills-pane.md).
- The **Resources** pane reads `<conception_path>/resources/`.

### `repositories`

A single ordered array of repo entries — the Code pane renders cards in the order declared here. Entries take one of the following shapes:

```json
{
  "repositories": [
    { "section": "Sites" },
    { "name": "alicepeintures.com", "run": "make dev" },
    { "name": "notes.vcoeur.com", "run": "make dev", "force_stop": "fuser -k 8200/tcp" },
    { "section": "Tools" },
    "condash",
    { "name": "helio", "submodules": ["apps/web", "apps/api"] }
  ]
}
```

| Shape                                                     | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bare string `"condash"`                                   | Directory name (not a path) matched against the scan of `workspace_path`.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `{"name": "repo"}`                                        | Same as bare — the inline-object form coexists because a repo may want sibling keys.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `{"path": "/abs/or/rel/path"}`                            | Override the filesystem location. The directory name is `basename(path)`; `name` is optional when `path` is given. Relative `path` resolves against `workspace_path`; absolute `path` lets the repo live anywhere on disk. When `path` is absent, `name` continues to serve as the path (backwards compatible). Non-git directories are auto-detected and render as plain directory shortcuts instead of broken-repo cards.                                                                                  |
| `{"handle": "kasten", "path": "notes.vcoeur.com"}`        | The canonical `#handle` — the app's one public identity, used by both card pills (always rendered as `#handle`, coloured by handle), project README `apps:` lists, the generated AGENTS.md table, and search. Defaults to `appHandle(name)` (the directory name, sigil-stripped + lowercased) when omitted, so simple repos need not set it; domain-style or camelCase repos should (`kasten`, `painting-manager`).                                                                                          |
| `{"handle": "h", "aliases": ["OldName", "old-name"]}`     | Legacy spellings that resolve to this handle. `condash applications validate` flags a README `apps:` value matching an alias and suggests the `#handle` rewrite; `rename` records the old handle here automatically.                                                                                                                                                                                                                                                                                       |
| `{"name": "repo", "submodules": ["sub/a", "sub/b"]}`      | Renders the repo as an expandable row. Each submodule gets its own dirty count and "open with" buttons. Useful for monorepos where subtrees are edited independently. Submodule entries follow the same shape as parent entries (string or object).                                                                                                                                                                                                                                                          |
| `{"name": "repo", "run": "<cmd>"}`                        | Wires an [inline dev-server runner](inline-runner.md) into that row. `run` is independent of `submodules` — a parent's `run` is **not** inherited by its submodules; add `run` per submodule if they each have their own dev server.                                                                                                                                                                                                                                                                         |
| `{"name": "repo", "run": "<cmd>", "force_stop": "<cmd>"}` | Same as above plus a repo-level **force-stop** button. The button runs `force_stop` as a shell command (`/bin/sh -c` on POSIX, `cmd.exe /d /s /c` on Windows), without going through condash's own process tracking — use it to free a port held by a server condash didn't start. **Per-OS recipes for "kill whatever is holding port 8300":** Linux `fuser -k 8300/tcp` or `pkill -f 'manage.py runserver'`; macOS `lsof -ti tcp:8300 \| xargs kill -9`; Windows `for /f "tokens=5" %a in ('netstat -ano ^ | findstr :8300') do taskkill /F /PID %a`. Same shell trust level as `run` — you're running these commands on your own machine, so a malicious tree is a malicious shell. |
| `{"name": "repo", "label": "<text>"}`                     | Optional human-friendly label. The Code-pane card's primary pill is always the `#handle`; the label renders as a secondary subtitle beside it (falling back to the directory name when it differs from the handle). Useful when the handle is terse and a friendlier descriptor (`Kasten`, `Alice PEINTURES`) gives quicker context. Works on both top-level entries and submodules; combinable with `run` / `force_stop` / `submodules`.                                                                   |
| `{"name": "repo", "install": "<cmd>"}`                    | Install command run after `condash worktrees setup` creates a worktree — applied **unconditionally** when present (no flag needed); pass `--no-install` to skip. Typical: `npm install` for a Node repo, `pip install -e .` for a Python one. Same shell trust level as `run`.                                                                                                                                                                                                                               |
| `{"name": "repo", "env": [".env", ".env.local"]}`         | Files copied from the primary checkout into a new worktree on `condash worktrees setup` — applied **unconditionally** when present (no flag needed). Closes the silent-undefined-`VITE_*` footgun where forgetting `--copy-env` leaves a Vite SPA reading `import.meta.env.VITE_*` as `undefined`. Default empty → no copy. Path traversal is rejected (no `..`, no absolute paths).                                                                                                                         |
| `{"name": "repo", "pinned_branch": "<branch>"}`           | Pin the repo to a fixed branch. `condash worktrees setup` skips it instead of creating a worktree on the requested branch. Use for shared / vendored repos that should never track the project branch axis.                                                                                                                                                                                                                                                                                                  |
| `{"section": "<heading>"}`                                | Section marker — not a repo. Every repo that follows in `repositories[]` belongs to this section until the next `{"section"}` entry. The Settings modal renders a header row; the Code pane groups cards under the heading with an in-memory collapse toggle. Repos placed before the first marker live in an implicit default bucket that renders as today's flat list (no header). **Top-level only** — `submodules` cannot contain section markers. Carries no other field.                               |

Anything under `workspace_path` not named in `repositories` is ignored — only listed entries appear on the Code pane.

### `retired_apps`

Defunct app handles that closed-project READMEs still reference but whose repos no longer exist. Each entry is `{ "handle": "<h>", "label"?: "<l>", "aliases"?: ["<old>"] }`. They are validated against (so a historical `#handle` resolves) but never rendered as Code-pane cards and never appear in the generated Apps table. A handle is either live (in `repositories`) or retired (here) — never both.

```json
{
  "retired_apps": [{ "handle": "kasten-manager", "label": "KastenManager", "aliases": ["KastenManager"] }]
}
```

### `open_with`

Three vendor-neutral launcher slots used by the "Open with …" buttons on every repo row and note file:

| Slot            | Typical use                                             |
| --------------- | ------------------------------------------------------- |
| `main_ide`      | Full IDE — IntelliJ IDEA, PyCharm, RustRover, WebStorm. |
| `secondary_ide` | Lighter editor — VS Code, VSCodium, Zed.                |
| `terminal`      | Spawn a terminal already `cd`-ed into the target.       |

Each slot takes a `command` string (required) and an optional `label` (tooltip text).

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

Built-in defaults reproduce common IntelliJ / VS Code / terminal behaviour, so a `.condash/settings.json` with no `open_with` block still gives functional buttons. Override only the slots you want to customise.

#### Per-OS recipes

The `command` is invoked directly (not through a shell) — `~/` and `$VARS` are not expanded except for a leading `~/` which condash rewrites to the user's home. Pick a recipe matching your OS:

| Slot            | Linux                                                                                                                       | macOS                                                                                    | Windows                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `main_ide`      | `idea {path}` · `code {path}`                                                                                               | `open -na "IntelliJ IDEA" --args {path}` · `open -na "Visual Studio Code" --args {path}` | `idea64.exe {path}` · `code {path}` (after VS Code's "Add to PATH" installer step) |
| `secondary_ide` | `codium {path}` · `zed {path}`                                                                                              | `open -na "VSCodium" --args {path}` · `zed {path}`                                       | `code {path}` · `zed {path}`                                                       |
| `terminal`      | `gnome-terminal --working-directory {path}` · `konsole --workdir {path}` · `x-terminal-emulator --working-directory {path}` | `open -a Terminal {path}` · `open -a iTerm {path}` · `open -a Ghostty {path}`            | `wt.exe -d "{path}"` (Windows Terminal) · `cmd.exe /K "cd /d {path}"`              |

### `terminal`

Embedded-terminal preferences. All keys are optional; an empty string means "fall back to the built-in default".

| Key                         | Default                                                 | Meaning                                                                                                                                        |
| --------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell`                     | `$SHELL` → `/bin/bash`                                  | Absolute path to an interactive shell.                                                                                                         |
| `shortcut`                  | `` Ctrl+` ``                                            | Toggle the terminal pane. Modifiers: `Ctrl`, `Shift`, `Alt`, `Meta`. Key names follow the HTML `KeyboardEvent.key` convention.                 |
| `screenshot_dir`            | `~/Pictures/Screenshots` on Linux, `~/Desktop` on macOS | Directory scanned for "most recent screenshot" by the paste shortcut.                                                                          |
| `screenshot_paste_shortcut` | `Ctrl+Shift+V`                                          | Inserts the absolute path of the newest image in `screenshot_dir` into the active terminal. No `Enter` — you confirm.                          |
| _(agents)_                  | —                                                       | The tab-strip spawn dropdown lists **agents** from the top-level `agents` list — not a `terminal.*` key. See [Agents](#agents) below. |
| `projectActions[]`          | `[]`                                                    | Configurable per-project actions — see [`terminal.projectActions`](#terminalprojectactions) below. Each entry adds an option to the dropdown next to a project's **Work on** button. |
| `newProjectActions[]`       | `[]`                                                    | Configurable starter prompts — see [`terminal.newProjectActions`](#terminalnewprojectactions) below. Each entry adds an option to the dropdown next to the **+ New project** button. |
| `move_tab_left_shortcut`    | `Ctrl+Left`                                             | Move the active tab to the left pane.                                                                                                          |
| `move_tab_right_shortcut`   | `Ctrl+Right`                                            | Move the active tab to the right pane.                                                                                                         |
| `xterm`                     | `{}`                                                    | xterm.js renderer settings — see [`terminal.xterm`](#terminalxterm) below. Editable through the Settings modal's **Terminal** section.         |

### Agents { #agents }

**Agents** are a flat list of terminal launchers under the top-level `agents` key. The tab-strip spawn dropdown lists them (it always offers `New shell` first, then each agent by `label`). Picking one opens a new terminal tab running its `command` — that's the whole model. An agent is a **top-level** config key (like `repositories`), so it resolves global-default ← per-conception override like every other workspace key: define machine-wide defaults in `settings.json`, override or extend per tree in `.condash/settings.json`.

```json
{
  "agents": [
    { "id": "claude", "label": "Claude", "command": "claude" },
    { "id": "claude-kimi", "label": "Claude · Kimi", "command": "claude-kimi" },
    { "id": "opencode-kimi", "label": "OpenCode · Kimi", "command": "opencode-kimi" }
  ]
}
```

| Key       | Type   | Required | Meaning                                                                                                                                                          |
| --------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`      | string | yes      | Stable identity referenced by [tasks](#tasks) and the `agent` field of [project / new-project actions](#terminalprojectactions). Non-empty.                       |
| `label`   | string | yes      | Display name shown in the spawn dropdown and as the pinned tab title.                                                                                            |
| `command` | string | yes      | Shell command run on launch, in a fresh tab with the terminal's ambient environment. Point it at a wrapper on `PATH` or inline the invocation. Blank → skipped.  |
| `promptFlags` | bool | no | Default `false`. Set `true` when `command` understands [agedum](../guides/agent-clis-and-models.md)'s `--prompt` / `--run` flags. [Tasks](#tasks) and agent-bound [actions](#terminalprojectactions) then pass the prompt in argv — `<command> --run "<prompt>"` when submitting (non-interactive, exits) or `<command> --prompt "<prompt>"` otherwise (interactive, seeded) — instead of spawning the bare command and typing the prompt into the live TUI. Leave off for an opaque command (e.g. a raw `claude`). |

condash builds **no** provider environment and stores **no** secrets — model/provider wiring and any API token live entirely in `command` (usually a `~/bin` wrapper script). See the [Agent CLIs and model providers guide](../guides/agent-clis-and-models.md) for wrapper recipes. Edit the list in the Settings modal's **Agents** section (on both the Global and This-conception tabs — agents inherit global → conception like other keys) or in the config file directly. **Migration:** condash ≤ 3.25 had `terminal.launchers` + the scalar `terminal.launcher_command`; both are dropped on read. (A later per-file `<conception>/agents/<slug>.json` harness store was also replaced by this `agents` list.)

### Tasks { #tasks }

**Tasks** are reusable, parameterized agent prompts — like agents, they live under the conception (not a `condash.json` key), managed by the **Tasks** pane (left-edge strip → **Tasks**). A task is a referenced agent plus a markdown prompt with fillable `{markers}`.

- **Definition** — `<conception>/tasks/<slug>/`, one directory per task. `task.json` carries `name`, `agent` (the `id` of an agent from the `agents` list above), and `submit` (optional bool, default `true`); `prompt.md` is the raw markdown prompt with markers. Config in JSON, prose in markdown — both are safe to commit. The slug is the directory name (`^[a-z0-9-]+$`); the `tasks/` tree is created on first save.
- **Markers** — `{KEY}` (required field) or `{KEY:default}` (prefilled). Reserved `{APP}` / `{PROJECT}` (and their `{APP_PATH}` / `{PROJECT_BRANCH}` / … sub-tokens) render as searchable pickers; one selection fills the whole family. `{TABS}` and `{UPDATED_TABS}` are **condash-provided** (never fields) — both expand to the open-tab list `[{sid,cwd,repo,cmd}]`, `{UPDATED_TABS}` narrowed to the tabs that produced new output since the task's last scheduled run.
- **Run** — spawns the task's agent in a fresh terminal tab (cwd = conception root). For an opaque agent it types the substituted prompt and presses Enter when `submit` is true; for an agent with [`promptFlags`](#agents) it instead passes the prompt in argv per the task's **run mode** (`--prompt` interactive, or `--run` one-shot) and types nothing.
- **`taskConfig`** — per-task scheduling + run mode + log routing, keyed by slug, in **`.condash/settings.json`** (or overridden in `condash.json`) — *not* in `task.json`. Each entry is `{ schedule?, timeout?, runMode?, excludeFromLogs?, gateOnUpdatedTabs? }`:
    - `schedule` — opt-in cadence (`s` / `m` / `h` / `d`, e.g. `5m` / `1h` / `7d`). The editor takes a free-text cadence and shows the parsed interval beside the field. A scheduled task runs **headless** (no tab) on that interval, single-flighted (never overlaps its own still-running run); the tabs that changed since the last run are handed to it as `{UPDATED_TABS}` (see `gateOnUpdatedTabs` to also skip idle ticks). Its console output is teed to `.condash/scheduled/<slug>/` (last ~5), **never** the normal logs. No default schedule; the task must carry a prompt-seedable agent.
    - `timeout` — per-run hard cap (same cadence syntax; absent = `10m`). With `runMode: oneshot` the agent exits on its own and this is a pure backstop; with the default `interactive` it is also the *discard* mechanism for an agent that finishes its work but never exits. Keep it ≤ `schedule` or single-flight stretches the effective cadence to the timeout. The editor offers 1m / 5m / 10m / 30m / 1h.
    - `runMode` — per-task default for how a `promptFlags` agent is driven: `interactive` (agedum `--prompt`, the default — the session stays open) or `oneshot` (`--run` — runs the prompt once and exits). Overridable per run in the run popup. **Prefer `oneshot` for a scheduled task** so its headless run exits cleanly instead of being killed at `timeout`. Ignored for an opaque agent (keystroke path, interactive only).
    - `excludeFromLogs` — per-task default for routing a *manual* run's `.txt` to `.condash/manual/<slug>/` instead of `.condash/logs/` (overridable per run in the run popup). The tab stays visible.
    - `gateOnUpdatedTabs` — opt-in growth gate (default off). When `true`, a due tick is **skipped** unless some open tab produced new output since the task's last run, so a quiet workspace spends nothing. Leave it off (the default) and the task runs on every interval regardless of tab activity. Enable it only for a task that acts on `{UPDATED_TABS}`; a task that doesn't read updated tabs would be starved by it.
  
  Both segregated stores are browsable from the Logs pane's **Task runs** view and stay invisible to the normal Logs list, search, and reports.

See the [Tasks pane guide](../guides/tasks-pane.md). The same `{KEY:default}` fallback applies to the project / new-project action templates below.

### `terminal.projectActions` { #terminalprojectactions }

Per-entry actions rendered in the per-card **Work on** dropdown on the Projects pane. The control is a single dropdown button: clicking it opens a menu whose first row is the built-in **Work on <slug>** action and whose remaining rows are the entries below. When `projectActions` is empty or missing, the menu still opens but contains only the default row.

```json
{
  "terminal": {
    "projectActions": [
      { "label": "Claude review", "template": "claude \"review project {shortSlug}\"", "submit": true },
      { "label": "Kimi summary", "template": "summarise {shortSlug}", "submit": true, "agent": "kimi" }
    ]
  }
}
```

| Key        | Type             | Required | Meaning                                                                                                                                                                                                         |
| ---------- | ---------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `label`    | string           | yes      | User-defined name shown in the dropdown. Empty or whitespace is treated as the entry being unset (no dropdown option rendered).                                |
| `template` | string           | yes      | Text pasted into the focused terminal when the entry is selected. May contain `{slug}`, `{shortSlug}`, `{title}`, `{branch}`, `{base}`, `{kind}`, `{status}`, `{date}`, `{apps}`, `{firstApp}`, `{path}`, `{relPath}`, and global placeholders (`{today}`, `{conception}`, `{conceptionPath}`). A `{placeholder:default}` form falls back to `default` when the placeholder is unknown; a default-less unknown placeholder is left verbatim so typos remain visible. Empty or whitespace is treated as the entry being unset. |
| `submit`   | bool             | no       | When `true`, condash presses Enter after pasting the template. Default `false` — matches the current **Work on** behaviour and lets templates that end with a colon wait for the user to type the variable bit. |
| `agent`    | string           | no       | When set, the `id` of an agent from the `agents` list. The action spawns a fresh tab running that agent's command before typing the template — useful for binding an action to a specific agent. Empty / missing → type into the focused tab (a plain shell when no tab exists). An id that no longer matches an agent falls through to the focused-tab flow. |

### `terminal.newProjectActions` { #terminalnewprojectactions }

Per-entry starter prompts rendered in the **+ New project** dropdown. The control is a single dropdown button: clicking it opens a menu whose first row opens the New project modal (the built-in default) and whose remaining rows are the configured starter prompts. When `newProjectActions` is empty or missing, the menu still opens but contains only the default row.

```json
{
  "terminal": {
    "newProjectActions": [
      { "label": "Spec + design starter", "template": "start project for new feature, make spec.md note with functional specification, and design.md note with design plan:", "submit": false },
      { "label": "Start new project (Claude)", "template": "Start new project ", "agent": "claude-kimi" }
    ]
  }
}
```

| Key        | Type             | Required | Meaning                                                                                                                                                                                                         |
| ---------- | ---------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `label`    | string           | yes      | User-defined name shown in the dropdown. Empty or whitespace is treated as the entry being unset.                                                              |
| `template` | string           | yes      | Text pasted into the focused terminal. May contain global placeholders only: `{today}`, `{conception}`, `{conceptionPath}`. A `{placeholder:default}` form falls back to `default`; a default-less unknown placeholder is left verbatim. Empty or whitespace is treated as the entry being unset. |
| `submit`   | bool             | no       | When `true`, condash presses Enter after pasting. Default `false`.                                                                                             |
| `agent`    | string           | no       | When set, the `id` of an agent from the `agents` list. The action spawns a fresh tab running that agent's command and types the template into the new tab — gives each entry a predictable starting environment (e.g. **Start new project → claude-kimi** always opens a fresh agent shell). Empty / missing keeps the "type into focused tab" behaviour. |

> **Note.** Selecting a new-project action does **not** create a project automatically — it only types a starter prompt into the terminal. The user then prompts their agent to create the project via `condash projects create`.

### `terminal.xterm` { #terminalxterm }

Visual + behavioural knobs for the xterm.js renderer. All keys are optional; missing keys fall through to xterm's defaults. Edit through the **Settings → Terminal** section — the editor live-rewrites `.condash/settings.json` and reloads existing tabs without a relaunch.

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
      "scrollback": 5000,
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
  "lastConceptionPath": "/home/you/src/vcoeur/conception",
  "recentConceptionPaths": ["/home/you/src/vcoeur/conception", "/home/you/src/work/conception"],
  "theme": "system",
  "terminal": {
    "shell": "/bin/zsh",
    "shortcut": "Ctrl+T",
    "screenshot_dir": "/home/you/Pictures/Screenshots"
  },
  "layout": {
    "projects": true,
    "leftView": "projects",
    "working": "code",
    "terminal": false,
    "projectsWidth": 420
  },
  "welcome": { "dismissed": true },
  "cardMinWidth": {
    "projects": 600,
    "code": 600,
    "knowledge": 480
  },
  "treeExpansion": {
    "knowledge": ["topics", "topics/security"],
    "resources": [],
    "skills": ["pr"]
  },
  "selectedBranches": ["feature-foo", "release-2026-05"],
  "branchFilterStickyAll": false,
  "skillsActiveScope": "conception"
}
```

| Key                     | Meaning                                                                                                                                                                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lastConceptionPath`    | Absolute path to the conception tree condash should render. Replaces the older `conceptionPath` field — a one-shot migration on first read rewrites old files.                                                                                             |
| `recentConceptionPaths` | Newest-first list of paths the user has opened (cap 5). Drives the **File → Open Recent** submenu and the Settings modal's recents section.                                                                                                                |
| `theme`                 | `light`, `dark`, or `system`. Persisted by `setTheme`.                                                                                                                                                                                                     |
| `terminal.*`            | Embedded-terminal preferences. See [Terminal preferences](#terminal-preferences) above for every sub-key.                                                                                                                                                  |
| `layout`                | Composite-layout state. See [LayoutState](#layoutstate) below.                                                                                                                                                                                             |
| `welcome`               | First-launch state. `welcome.dismissed: true` hides the Welcome screen even when both Projects and Knowledge are empty.                                                                                                                                    |
| `cardMinWidth`          | Per-pane card grid min-width. See [CardMinWidth](#cardminwidth) below.                                                                                                                                                                                     |
| `treeExpansion`         | Per-pane set of expanded directory `relPath`s for the Knowledge / Resources / Skills tree panes (`knowledge`, `resources`, `skills`). Empty (or missing) means everything is collapsed — the on-purpose first-load state per #89. |
| `selectedBranches`      | Branches pinned by the Code-pane top-of-pane filter. The primary worktree row is always rendered; this set is additive on top of it. Honoured only when `branchFilterStickyAll` is false.                                                                  |
| `branchFilterStickyAll` | True ⇒ Code-pane filter is in **All (sticky)** mode: every branch is shown and new ones auto-pin. False ⇒ honour `selectedBranches` exactly (empty = main only). Defaults to true on first read when no explicit selection was ever made, false otherwise. |
| `skillsActiveScope`     | Active scope in the Skills pane — `conception` or `user`. Defaults to `conception`. Persisted on every scope switch.                                                                                                                                       |

Workspace-shape keys (`workspace_path`, `worktrees_path`, `repositories`, `open_with`, `pdf_viewer`, `terminal`) are also valid in `settings.json` — they act as global defaults that any conception's `.condash/settings.json` may override. The reverse direction is forbidden: a conception's `settings.json` cannot set `lastConceptionPath` or `recentConceptionPaths`, since those describe the tree's own location and the user's machine-local recents list.

### LayoutState

`settings.json` carries the composite-layout snapshot so a fresh launch reopens with the last layout.

| Field           | Type                                                       | Meaning                                                                                                                       |
| --------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `projects`      | bool                                                       | Show or hide the left band.                                                                                                  |
| `leftView`      | `'projects' \| 'tasks' \| 'deliverables'`                  | Which pane fills the left band — the Projects list, the Tasks list, or the Deliverables aggregation of every project's `## Deliverables`. Selected by the left edge-strip handles. Defaults to `'projects'`. A persisted `'outputs'` (v3.20.0) is migrated to `'deliverables'`. |
| `working`       | `'code' \| 'knowledge' \| 'resources' \| 'skills' \| 'logs' \| null` | Six-state. `'code'`, `'knowledge'`, `'resources'`, `'skills'`, or `'logs'` shows that pane in the working slot; `null` hides them all. |
| `terminal`      | bool                                                       | Show or hide the Terminal pane at the bottom.                                                                                 |
| `projectsWidth` | non-negative int                                           | Pixel width of the Projects pane after the user drags the splitter.                                                           |

The IPC verbs `getLayout` / `setLayout` read and write this block atomically — toggling a pane via the View menu (or its keyboard shortcut) round-trips through `setLayout` so the change survives a restart.

### CardMinWidth

`cardMinWidth` controls the n→n+1 reflow threshold for the eight card grids (Projects, Code, Knowledge, Resources, Skills, Logs, Tasks, Deliverables). Each grid uses `minmax(min(<min>, 100%), 1fr)`, so a row of _n_ cards reflows to _n+1_ once the pane is wide enough to fit _n+1_ cards each at this width.

| Field          | Type                | Default | Meaning                                                      |
| -------------- | ------------------- | ------- | ------------------------------------------------------------ |
| `projects`     | int 120 – 2400 (px) | 650     | Min width of a project card on the Projects pane.            |
| `code`         | int 120 – 2400 (px) | 650     | Min width of a repo card on the Code pane.                   |
| `knowledge`    | int 120 – 2400 (px) | 520     | Min width of a knowledge-section card on the Knowledge pane. |
| `resources`    | int 120 – 2400 (px) | 280     | Min width of a resource card on the Resources pane.          |
| `skills`       | int 120 – 2400 (px) | 280     | Min width of a skill card on the Skills pane.                |
| `logs`         | int 120 – 2400 (px) | 400     | Min width of a session card on the Logs pane.                |
| `tasks`        | int 120 – 2400 (px) | 340     | Min width of a task card on the Tasks pane.                  |
| `deliverables` | int 120 – 2400 (px) | 340     | Min width of a deliverable card on the Deliverables pane.    |

Lower numbers pack more cards per row at the same window size; higher numbers keep cards roomy. Values outside the `120–2400` range are silently dropped back to the default. Keys equal to the default are removed from disk so the bundled defaults can change in a future release without leaving stale literals on every machine.

`getCardMinWidth` / `setCardMinWidth` round-trip the block; the renderer also applies the values as CSS variables on `:root` (`--card-min-projects`, `--card-min-code`, `--card-min-knowledge`, `--card-min-resources`, `--card-min-skills`, `--card-min-logs`, `--card-min-tasks`, `--card-min-deliverables`) so live edits in the Settings modal reflow the grids without a reload.

Resolution order for the conception path, checked in sequence:

1. `CONDASH_CONCEPTION_PATH` env var (session-scoped override; doesn't touch `settings.json`).
2. `lastConceptionPath` in `settings.json`.
3. The first-launch folder picker. On selection, the picker writes the chosen path to `lastConceptionPath` and prepends it to `recentConceptionPaths` (cap 5) so the next launch picks it up automatically.
4. **File → Open Recent** lets the user switch between recent paths without a folder dialog. Picking a recent promotes it to the head of the list and swaps the active conception immediately.

The file is created on demand: the first-launch folder picker writes it; you can also create it by hand.

## Editing from the dashboard

**File → Settings…** (`Ctrl+,`) opens a full-viewport modal with a two-tab layout (added in v2.15.2). There is no in-modal JSON editor: each persisted preference has its own form control.

**Global** tab (writes to `settings.json`):

- **Recent conception paths** — manage the recents list backing **File → Open Recent**.
- **Appearance** — theme; per-pane card-grid min-widths.
- **Terminal** — embedded terminal preferences.

**This conception** tab (writes to `.condash/settings.json`; the legacy `condash.json` and `configuration.json` are read but never written to):

- **Workspace** — `workspace_path`, `worktrees_path`.
- **Repositories** — ordered repo list, per-repo `run` / `force_stop`.
- **Open with** — slot labels and commands.
- **Appearance** — theme + card-grid min-widths overridden for this conception only.
- **Terminal** — `terminal` block overridden for this conception only.

Each top-level key on the **This conception** tab carries an inheritance badge that calls out the override state — **Inherits**, **Overridden**, or **Matches global** — plus a **Reset to global** / **Remove override** button when the conception writes anything for that key. Removing an override drops the key from `.condash/settings.json` and falls back to inheritance. Writes go through `patchConfig` (conception settings) and `patchSettings` (global settings), each of which parses the live file, applies a mutator, drops empty leaves, and round-trips through atomic CAS — schema-validated by the [strict zod schemas](https://github.com/vcoeur/condash/blob/main/src/main/config-schema.ts) (`globalSettingsSchema` for settings.json, `conceptionConfigSchema` for the conception side) before the bytes hit disk.

The rail at the left of the modal carries **Save** (flush focused-but-unblurred edits) and **Open externally** (open the active tab's file in the OS default editor). The active tab is remembered between modal opens via `localStorage`.

Keys not surfaced in the modal — `pdf_viewer`, the `welcome.dismissed` flag — still need a hand-edit. See [`settings.json` (per-user, per-machine)](#settingsjson-per-user-per-machine) above for paths.

Changes that **do** need a restart:

- `workspace_path` or `worktrees_path` change — the filesystem scanner is built once at launch.
- `repositories` list change — the per-repo state is built once at launch.

Changes that reload live without a restart:

- Everything under `open_with`, `terminal`.
- `run` / `force_stop` on an existing repo entry.

## See also

- [Environment variables](env.md) — what condash reads from the environment, and what it deliberately doesn't.
- [Inline dev-server runner](inline-runner.md) — the `run` field in `.condash/settings.json`.
- [Terminal shortcuts](shortcuts.md) — what each `terminal.*` shortcut does in the UI.
