---
title: Config files · condash reference
description: The two JSON files condash reads (per-tree and per-machine) and what every key means.
---

# Config files

> **Audience.** Daily user.

condash reads two JSON files with **disjoint** schemas — every setting key lives in exactly one of them, so there are no overrides, no inheritance, and nothing to merge. The per-machine `settings.json` holds everything personal to you and this machine (appearance, terminal, launchers, open-with, the dashboard, …). The per-conception `.condash/settings.json` holds only what describes *this tree* — its workspace / worktree paths, its repo list, its retired handles, and its task config. Either file is optional — the dashboard runs with sensible defaults.

## At a glance

| File                     | Path                                                                                                                                                                        | Lifecycle                                 | Owns exclusively                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------- |
| `settings.json`          | `${XDG_CONFIG_HOME:-~/.config}/condash/settings.json` (Linux) · `~/Library/Application Support/condash/settings.json` (macOS) · `%APPDATA%\condash\settings.json` (Windows) | Per-user, per-machine                     | Everything personal/per-machine — appearance, `terminal`, `agents`, `open_with`, `pdf_viewer`, `dashboard`, `layout`, … plus `lastConceptionPath`, `recentConceptionPaths` (cap 5) |
| `.condash/settings.json` | `<conception_path>/.condash/settings.json` (legacy fallbacks: `condash.json`, `configuration.json`)                                                                         | Per-conception, **per-host** (gitignored) | `workspace_path`, `worktrees_path`, `long_lived_branches`, `repositories`, `retired_apps`, `taskConfig` |

The two files have **disjoint** schemas: each top-level key is valid in exactly one of them — see the [full table](#all-config-keys) below for which. There is no override, no inheritance, and no merge: a key only ever has one value, read from its owning file. Putting a key in the wrong file is a validation error on save; for files written under the old shared-schema model, the boot-time [scope-partition migrator](#scope-partition-migrator) moves each mis-homed key into its owning file automatically on first open. The only field accepted in *both* files is the `$schema_doc` documentation pointer (which is not a setting).

### The `.condash/` workspace directory

`.condash/` is condash's per-conception state directory — the home of `settings.json` plus terminal logs at `.condash/logs/YYYY/MM/DD/HHMMSS-<sid>.txt`. **The whole directory is gitignored by default** (the auto-migrator appends a `.condash/` line to your `.gitignore` on first run when the conception is a git repo), so settings + logs are per-host state with no commit-leak risk. Teams that want to share a baseline config either commit `condash.json` alongside (legacy path still reads) or manually un-ignore `settings.json` in their `.gitignore`.

### Reading and writing

- **Read precedence**: `<conception>/.condash/settings.json` (canonical) → `<conception>/condash.json` (legacy) → `<conception>/configuration.json` (legacy²). Both legacy filenames are read indefinitely with no deprecation date.
- **Write target**: every save through the GUI or `condash config set` writes to `.condash/settings.json`. The auto-migrator copies the legacy content into the new path on first open, tombstones the source file (so accidental edits don't drift), and appends `.condash/` to `.gitignore`. Run `condash config migrate` to invoke it explicitly.
- **Key ownership**: every setting has exactly one home — `settings.json` (personal/per-machine) or `.condash/settings.json` (this tree's paths, repos, and tasks). A key written to the wrong file is rejected by the strict schema; the [scope-partition migrator](#scope-partition-migrator) relocates mis-homed keys on conception open. A conception file cannot set `lastConceptionPath` / `recentConceptionPaths` — a tree cannot describe its own location.
- **Environment override**: `CONDASH_CONCEPTION_PATH` still wins for the session, matching the legacy behaviour.

### Scope-partition migration { #scope-partition-migrator }

On every conception open — right after the legacy-filename migrator lifts any `condash.json` / `configuration.json` into `.condash/settings.json` — condash partitions both settings files so each holds only the keys it owns (per `SCOPE_OF` in `src/main/config-schema.ts`). A key found in the file that does not own it is **moved** to its owning file; if the owning file already sets that key, the two are reconciled by value type: an **object** value is **deep-merged** into the owning file's object (the owned-file value wins on any leaf conflict, so disjoint sub-keys that were split across the two files under the old override model — e.g. `terminal.screenshot_dir` in `settings.json` alongside `terminal.logging` in `.condash/settings.json` — are preserved), while a scalar or array value is **dropped** (the owned-file value wins wholesale). Every move, merge, and drop is logged. The pass is idempotent — once both files are partitioned, a re-run moves nothing — so a machine upgrading from the old shared-schema / override model has its settings split into the right files automatically on first open. (Implemented in `src/main/scope-partition-migrate.ts`.)

## All config keys { #all-config-keys }

Every top-level key, in one place. **Scope** is the one file the key lives in: _global_ keys belong to the per-machine `settings.json`; _conception_ keys belong to the per-tree `.condash/settings.json`. A key placed in the wrong file is rejected by the strict schema (and relocated by the [scope-partition migrator](#scope-partition-migrator) on conception open).

| Key                     | Scope       | Type         | Default  | What it does                                                                                                                                                                                                             |
| ----------------------- | ----------- | ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workspace_path`        | conception  | string       | —        | Root condash resolves repo paths against; populates the Code pane. Unset hides the pane. [↓](#workspace-keys)                                                                                                            |
| `worktrees_path`        | conception  | string       | —        | Extra sandbox root accepted by the "open in IDE" launchers. [↓](#workspace-keys)                                                                                                                                         |
| `repositories`          | conception  | array        | `[]`     | Ordered Code-pane repo list; also the app registry (`#handle`, `label`, `aliases`, `run`, `submodules`, `section`). [↓](#repositories)                                                                                   |
| `retired_apps`          | conception  | array        | `[]`     | Defunct `#handle`s still referenced by closed projects — resolve, never rendered. [↓](#retired_apps)                                                                                                                     |
| `long_lived_branches`   | conception  | array        | `["main", "master"]` | Branch glob patterns (`*` / `?`) protected from `condash worktrees remove`. Unset → `main` + `master`. [↓](#workspace-keys)                                                                                                |
| `agents`                | global      | array        | `[]`     | Flat `{id,label,command}` terminal-launcher list shown in the tab-strip spawn dropdown. [↓](#agents)                                                                                                                       |
| `taskConfig`            | conception  | object       | —        | Per-task `{schedule?, timeout?, runMode?, excludeFromLogs?, gateOnUpdatedTabs?}` keyed by slug — opt-in headless scheduling + run timeout + run mode (`--prompt`/`--run`) + run-log routing + activity gate. [↓](#tasks) |
| `open_with`             | global      | object       | —        | The three IDE/terminal launch slots (`main_ide`, `secondary_ide`, `terminal`). [↓](#open_with)                                                                                                                           |
| `pdf_viewer`            | global      | array        | —        | Ordered fallback chain of external PDF viewers.                                                                                                                                                                          |
| `terminal`              | global      | object       | —        | Shell, shortcuts, screenshot dir, `xterm` theming, `logging`, `memory` containment, project-action templates — one whole personal/per-machine key. [↓](#terminal)                                                                        |
| `dashboard`             | global      | object       | —        | Live terminal-tab summarization (direct OpenAI-compatible endpoint, DeepSeek by default): `{enabled, provider, apiKey, baseUrl, model, writerModel, cardReasoning, writerReasoning, cardInputChars, intervalSec, gateOnActivity, historyLimit}`. Off by default; set it in **Settings → Dashboard**, which writes to the global file (the `apiKey` is a secret). [↓](#dashboard)                                                                 |
| `autoSync`              | global      | object       | —        | GUI-driven periodic committer: `{enabled, intervalMinutes, quietPeriodSeconds, push}`. While a conception is open, runs `condash sync run` on a timer. Off by default; set it in **Settings → Auto-commit**. [↓](#auto-commit)                                                                                    |
| `theme`                 | global      | enum         | `system`  | Colour theme: `light` (Paper) \| `dark` (Warm Gallery) \| `console` (Console) \| `system` (follow the OS between Paper and Warm Gallery). [↓](#theme)                                                                     |
| `uiFonts`               | global      | object       | —        | Per-category UI typography `{cardTitle, heading, body, code, terminal}`, each a `{family, weight, size}` object. Any field left `default` keeps the theme's value for that surface. [↓](#uifonts)                            |
| `layout`                | global      | object       | —        | Persisted pane layout, including `leftView` (`projects` \| `tasks` \| `deliverables`). [↓](#layoutstate)                                                                                                                 |
| `welcome`               | global      | object       | —        | `{ dismissed }` — first-launch welcome-screen state.                                                                                                                                                                     |
| `cardMinWidth`          | global      | object       | —        | Per-surface minimum card width. [↓](#cardminwidth)                                                                                                                                                                       |
| `treeExpansion`         | global      | object       | —        | Remembered expand/collapse state of the tree panes.                                                                                                                                                                      |
| `selectedBranches`      | global      | array        | `[]`     | Code-pane branch-filter selection.                                                                                                                                                                                       |
| `branchFilterStickyAll` | global      | boolean      | `true`   | Branch filter "All (sticky)" mode — show every branch and auto-pin new ones.                                                                                                                                             |
| `lastConceptionPath`    | global      | string\|null | `null`   | Currently-open conception path.                                                                                                                                                                                          |
| `recentConceptionPaths` | global      | array        | `[]`     | Most-recently-opened paths, newest first (cap 5).                                                                                                                                                                        |

Task _definitions_ are **not** a config key — they live on disk at `<conception>/tasks/<slug>/` (see [Tasks](#tasks)). Their per-task **scheduling / log-routing** lives in the `taskConfig` key above, keyed by slug. condash also persists a few small UI-state fields it manages itself (e.g. `skillsActiveScope`) in `settings.json`; you don't edit those by hand. Strict-mode validation rejects any unknown top-level key on save.

## Config keys — shapes and ownership

The subsections below document the **shape** of each config key. Which file a key lives in is the **Scope** column in [All config keys](#all-config-keys): `conception` keys (`workspace_path`, `worktrees_path`, `long_lived_branches`, `repositories`, `retired_apps`, `taskConfig`) live in `.condash/settings.json`; everything else is `global` and lives in `settings.json`. A few blocks documented here for convenience — `terminal` (and its `logging` / `projectActions` / `newProjectActions` / `xterm`), `dashboard`, `open_with`, `agents` — are **global** (personal/per-machine), not per-conception. No key is valid in both files.

### `.condash/settings.json` (per-conception, per-host)

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
  ]
}
```

Only the six tree-shape keys (`workspace_path`, `worktrees_path`, `long_lived_branches`, `repositories`, `retired_apps`, `taskConfig`) are valid here; personal keys such as `open_with`, `pdf_viewer`, and `terminal` belong to the global `settings.json` and are rejected in a conception file (and lifted out by the [scope-partition migrator](#scope-partition-migrator) if found). Use absolute paths for `workspace_path` / `worktrees_path` — there is no `~` expansion for path keys. (The one place `~` works is a leading `~/` in an `open_with` _command_ token — see [Per-OS recipes](#per-os-recipes).) JSON does not carry comments — keep prose documentation in the project README or the per-tree `CLAUDE.md`.

`terminal` is **not** a conception key — the whole block (including its `logging` sub-block) lives in the per-machine `settings.json` and is edited once in **Settings → Terminal**, which live-rewrites `settings.json`. A boot-time migration in older condash builds lifted any pre-existing `terminal` block out of `configuration.json`; the scope-partition migrator now also lifts a `terminal` block out of any `.condash/settings.json` that still carries one (e.g. a tree configured under the old shared-schema model). Both passes are idempotent.

The legacy `terminal.launchers` array and the scalar `terminal.launcher_command` (condash ≤ 3.25) are dropped on the next write — the tab-strip dropdown is now populated from the top-level [agents](#agents) list. A legacy action-template `launcher` binding is renamed to `agent` in place.

### Terminal logging

Inside the `terminal` block, `terminal.logging` configures per-session capture. Each pty spawn produces a **single plain-text file** at `<conception>/.condash/logs/YYYY/MM/DD/HHMMSS-<sid>.txt`. Metadata travels inside the file as two `# condash: {...}` JSON lines:

- **Header** (line 1, always present) — `{ sid, side, repo?, cwd, cmd, argv, started }`.
- **Footer** (last line, only after the session exits) — `{ finished, exitCode }`.

The body also carries periodic `<!-- YYYY-MM-DD:HH:MM -->` timestamp markers (local time), written at the `markerIntervalSec` cadence but **only when new output has arrived** since the previous marker — an idle session is never stamped. For an in-band transcript the marker sits inline at a message boundary; for a grid snapshot it lands in a trailing `<!-- timeline -->` block (a repaint can't host inline markers). The HTML-comment form is invisible in rendered markdown and skippable by a parser.

The writer pipes pty bytes through a headless xterm (`@xterm/headless`), every 5 s renders each buffer row via `IBufferLine.translateToString(true)`, composes header + body (+ footer if exited), and atomically rewrites the file. Output is plain UTF-8 — no SGR, no CSI, no cursor-forward — so the file is grep-friendly and the viewer needs no ANSI parser. Colour / bold / underline fidelity belongs to the live terminal's **Save buffer** button.

Typed keystrokes are _not_ captured separately — the pty echoes them back through stdout, so the rendered buffer already shows what was typed. The Logs working surface (`View → Show Logs`, `Cmd+Shift+L`) lists sessions grouped by day; clicking a card opens a full-overlay viewer modal with virtualised text + case-insensitive search.

| Key             | Type          | Default | Meaning                                                                                                                                                                                                                                                  |
| --------------- | ------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`       | boolean       | `false` | Toggle capture entirely. Default flipped to opt-in for privacy (2.25.0). Disabling stops new writes on the next session spawn; existing files stay on disk for the janitor. The Logs pane stays usable for browsing past transcripts even when disabled. |
| `retentionDays` | integer ≥ 0   | `14`    | Day-directories older than this are removed on next janitor run. `0` disables age-based eviction (the size cap still applies).                                                                                                                           |
| `maxDirMb`      | integer ≥ 0   | `500`   | Total cap on `<conception>/.condash/logs/`. The janitor evicts oldest day-directories first while over cap, regardless of age.                                                                                                                           |
| `scrollback`    | integer ≥ 100 | `5000`  | Scrollback lines retained by the per-session headless xterm. Larger → more history captured, larger `.txt` files; smaller → older output rolls off the top of the buffer (same semantics as the live pane).                                              |
| `markerIntervalSec` | integer ≥ 0 | `60`  | Wall-clock seconds between in-body `<!-- YYYY-MM-DD:HH:MM -->` timestamp markers. A marker is emitted only when new output arrived since the previous one, so an idle session is never stamped. Applies to both transcript and grid logs. `0` disables periodic markers.                                            |

The janitor runs at app startup and every 24 hours: it (1) deletes day-dirs older than `retentionDays`, then (2) evicts the oldest surviving day-dir while total size is over `maxDirMb`. No compression pass since v2.27.0 — plain `.txt` files are small enough at the scrollback cap that gzip is not worth the round-trip cost. Errors are logged to stderr and never propagate into the IPC layer.

**Migration from `maxFileMb` / `ansiPolicy`:** both fields were dropped from the schema in v2.23.0 when per-file rotation and ANSI stripping were retired. Settings files that still carry them (typically conceptions upgraded straight from ≤ 2.22) are scrubbed in-flight on every read and the legacy keys vanish from disk on the next settings write — no manual action.

Legacy formats — JSONL event streams from condash ≤ 2.22, compressed `.txt.gz` files from 2.23–2.26 — are ignored by the new viewer and global search. They sit on disk until the janitor's age-based eviction sweeps them. To clear them immediately, delete `<conception>/.condash/logs/` and start fresh.

### Dashboard

The `dashboard` block configures **live terminal-tab summarization**: a periodic loop in the main process reads the recent output of the open terminal tabs and summarizes it by POSTing directly to an OpenAI-compatible LLM endpoint (DeepSeek by default), surfacing the result as (1) LLM-derived tab titles, (2) a hover popover, and (3) the **Dashboard** body in the bottom band — a handle next to **Terminal** (`Ctrl+Shift+D`) swaps the band between the terminals and the dashboard. For a full-screen agent tab it reads the program's clean [in-band transcript](../guides/terminal.md#in-band-transcript) when one is emitted (claude / opencode), falling back to the cleaned scrollback for plain shells — so a repainting TUI is summarized from its real conversation, not frame noise. The Dashboard shows a card for **every** open terminal tab (a fallback from the tab's command/cwd until a summary exists), so an idle or not-yet-summarized tab is never invisible. The roster is the **Terminal** pane's tabs only — the Code-pane **Run** sessions (long-running dev servers) are panes, not agent tabs, so they are not counted in the top-line tab tallies nor rendered as cards. A card — and its entry in the working/idle tally — is dropped the moment its tab closes, every tick and without an API call, so a status never outlives the tab it describes. Each card also carries an **Update** button that forces an immediate re-summarization of that one tab, bypassing the interval and the activity gate. It is **off by default** — nothing runs and no data leaves the machine until you enable it. State (per-tab summaries + a rolling event history) persists at `<conception>/.condash/dashboard/state.json`.

Edit it once in **Settings → Dashboard** (under **Personal · this machine**). The whole `dashboard` block is editable there — the secret `apiKey`, the endpoint (`baseUrl`), both model tiers (`model` / `writerModel`), their reasoning toggles (`cardReasoning` / `writerReasoning`), the card input window (`cardInputChars`), the interval, and the activity gate. It is a personal/per-machine setting written to `settings.json`; it is **not** a conception key, so nothing about the dashboard is ever committed to a tree's `.condash/settings.json`. The section also carries a **Test connection** button that runs a one-shot completion against the entered key/URL/card model.

| Key              | Type        | Default          | Meaning                                                                                                                                                                                  |
| ---------------- | ----------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`        | boolean     | `false`          | Master switch. Off → the engine is inert; on → summaries run on the interval.                                                                                                          |
| `provider`       | enum        | `deepseek`       | Auth/registry namespace. Only `deepseek` is accepted today (modelled as an enum so others can be added later); a custom `baseUrl` lets it reach any OpenAI-compatible endpoint regardless. |
| `apiKey`         | string      | —                | API key for the endpoint. **Global file only.** When unset, falls back to the `DEEPSEEK_API_KEY` environment variable.                                                                   |
| `baseUrl`        | string      | —                | OpenAI-compatible API base URL. Blank → the provider's built-in endpoint (`https://api.deepseek.com`). Set it to a self-hosted / proxy endpoint (e.g. an opencode-go server) to use any model id it serves. Falls back to `DEEPSEEK_BASE_URL`. |
| `model`          | string      | `deepseek-v4-flash` | **Card model** — the cheap, high-volume tier that pre-processes each tab's wide window into state + facts + a **draft title**. Without a `baseUrl` it must be a built-in DeepSeek model; with a `baseUrl`, any id the endpoint serves. A config that sets only `model` (no `writerModel`) drives both tiers with it.   |
| `writerModel`    | string      | `deepseek-v4-pro` | **Writer model** — the richer tier that composes each card's published **title** (3–7 words) + one-sentence **subtitle** (the work's context and purpose) from the card facts plus the tab's derived provenance (app / worktree / project), falling back to the card model's draft title when its reply omits one. Defaults to `model` when a single-tier config is in use (so a single-model endpoint keeps working). |
| `cardReasoning`  | boolean     | `false`          | Whether the card model reasons. Off by default: card work is mechanical state+fact extraction, where hidden reasoning only adds latency (~3–5× slower) with no quality gain. Sent as DeepSeek's `thinking:{type:disabled}` when off. |
| `writerReasoning`| boolean     | `false`          | Whether the writer model reasons. Off by default: a model bake-off found reasoning-on returns an empty reply on a non-trivial fraction of writer calls — unacceptable now that this tier owns the published title.                       |
| `cardInputChars` | integer     | `16000`          | Chars of recent tab output fed to the card model (floored at 2000). Wider than the legacy 6000 because the cheap tier can afford a larger window.                                       |
| `intervalSec`    | integer     | `120`            | Base seconds between a tab's refreshes — each tab runs on its own clock seeded from this plus a small per-tab jitter, **clamped to 30–300**.                                            |
| `gateOnActivity` | boolean     | `true`           | Skip a due tab's refresh when that tab produced no new output since its last summary (reuses the scheduler's per-tab growth gate). Off → refresh every due tab regardless.             |
| `historyLimit`   | integer     | `20`             | Maximum retained events per tab and in the global history; older events roll off.                                                                                                       |

> **Privacy:** enabling the dashboard transmits recent on-screen terminal output to the configured API endpoint — the DeepSeek API by default, or whatever `baseUrl` points at. Before any text leaves the machine it is run through the same secret redactor as `condash logs --redact` (provider key prefixes, bearer tokens, JWTs, secret-named assignments, PEM private-key blocks → `«redacted:…»`). That redactor is conservative by design and recognises only high-precision secret shapes, so it is a backstop, not a guarantee: leave the dashboard off for tabs that display credentials you don't want sent off-machine.

### Auto-commit

The `autoSync` block turns condash into the single writer for a conception shared by parallel agent sessions: while a conception is open, a main-process engine runs [`condash sync run`](cli.md#sync) on a timer, committing every settled, non-gitignored change and pushing. It is the same sweep as the CLI verb, with the same safety — the non-blocking lock, the quiet-period mid-edit guard, the mid-merge/conflict refusal, and push-as-a-warning — so nothing here can commit a half-written file or rewrite the tree under a live session.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch. Off by default — the engine is armed but never commits. |
| `intervalMinutes` | `10` | How often to sweep and commit. Clamped to 1–120. |
| `quietPeriodSeconds` | `90` | A file edited more recently than this is left for the next sweep — the guard against committing mid-edit. Clamped to 0–3600; `0` commits even just-touched files. |
| `push` | `true` | Push after committing (a rejected push is a warning; the next sweep retries). |

Edit it in **Settings → Auto-commit** (under **Personal · this machine**), which also carries a **Commit & push now** button (one sweep, regardless of the cadence) and a live status line (next-run ETA · last result · any error). It is a personal/per-machine setting written to `settings.json` — nothing about it is committed to a tree's `.condash/settings.json`.

The **status bar** surfaces the same engine at a glance: an auto-sync pill (synced / *N* to sync / syncing / failed / off) with its own **Sync now** button and a click-to-open list of the conception's most recent commits (each marked pushed or unpushed) — so you can see sync state and trigger a sweep without opening Settings. Alongside it, a **shipped-skills** pill shows whether the condash-shipped skills under `.agents/skills/` are in sync, with an **Install** action (runs [`condash skills install`](cli.md#skills)) when any are missing or outdated.

The first commit lands one interval **after** you enable it, never the instant the app opens. To keep a file out of auto-commit, gitignore it. Two caveats: the engine only runs while the condash app is open (for headless commits, use the [`systemd` timer](cli.md#sync)), and the quiet period is the *only* thing standing between an in-progress edit and a commit — set it comfortably longer than your longest pause between keystrokes.

### Workspace keys

| Key              | Meaning                                                                                                                                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace_path` | Directory condash resolves relative repo paths against. Every direct subdirectory containing a `.git/` shows up in the **Code** pane. If unset, the pane is hidden. Repos with an explicit `path` may live outside this root. |
| `worktrees_path` | Additional sandbox for the "open in IDE" buttons. Paths outside `workspace_path` and `worktrees_path` are rejected before the shell sees them.                                                                                |
| `long_lived_branches` | Branch name patterns that `condash worktrees remove` refuses to delete. Supports glob wildcards `*` (any run of characters) and `?` (one character) — e.g. `main`, `release/*`, `hotfix-?`. Defaults to `["main", "master"]` when unset, so leaving it empty does **not** disable protection. A non-empty list **replaces** the default — it does not extend it — so keep `main` / `master` in the list if you still want them protected (e.g. `["main", "master", "release/*"]`). Edited under **Settings → Workspace & paths**. |

Since the reframe, two panes read **hard-coded** directories — no config key controls either:

- The **Skills** pane reads the agedum sources at `<conception_path>/.agents/skills/` (and `~/.config/agents/skills/` for the User scope). The former `skills_path` key was dropped; condash never reads compiled per-harness outputs (`.claude/`, `.kimi/`, …). See the [Skills pane guide](../guides/skills-pane.md).
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
| `{"handle": "h", "aliases": ["OldName", "old-name"]}`     | Legacy spellings that resolve to this handle. `condash applications validate` flags a README `apps:` value matching an alias and suggests the `#handle` rewrite; `rename` records the old handle here automatically.                                                                                                                                                                                                                                                                                         |
| `{"name": "repo", "submodules": ["sub/a", "sub/b"]}`      | Renders the repo as an expandable row. Each submodule gets its own dirty count and "open with" buttons. Useful for monorepos where subtrees are edited independently. Submodule entries follow the same shape as parent entries (string or object).                                                                                                                                                                                                                                                          |
| `{"name": "repo", "run": "<cmd>"}`                        | Wires an [inline dev-server runner](inline-runner.md) into that row. `run` is independent of `submodules` — a parent's `run` is **not** inherited by its submodules; add `run` per submodule if they each have their own dev server.                                                                                                                                                                                                                                                                         |
| `{"name": "repo", "run": "<cmd>", "force_stop": "<cmd>"}` | Same as above plus a repo-level **force-stop** button. The button runs `force_stop` as a shell command (`/bin/sh -c` on POSIX, `cmd.exe /d /s /c` on Windows), without going through condash's own process tracking — use it to free a port held by a server condash didn't start. **Per-OS recipes for "kill whatever is holding port 8300":** Linux `fuser -k 8300/tcp` or `pkill -f 'manage.py runserver'`; macOS `lsof -ti tcp:8300 \| xargs kill -9`; Windows `for /f "tokens=5" %a in ('netstat -ano ^ | findstr :8300') do taskkill /F /PID %a`. Same shell trust level as `run` — you're running these commands on your own machine, so a malicious tree is a malicious shell. |
| `{"name": "repo", "label": "<text>"}`                     | Optional human-friendly label. The Code-pane card's primary pill is always the `#handle`; the label renders as a secondary subtitle beside it (falling back to the directory name when it differs from the handle). Useful when the handle is terse and a friendlier descriptor (`Kasten`, `Alice PEINTURES`) gives quicker context. Works on both top-level entries and submodules; combinable with `run` / `force_stop` / `submodules`.                                                                    |
| `{"name": "repo", "install": "<cmd>"}`                    | Install command run after `condash worktrees setup` creates a worktree — applied **unconditionally** when present (no flag needed); pass `--no-install` to skip. Typical: `npm install` for a Node repo, `pip install -e .` for a Python one. Same shell trust level as `run`.                                                                                                                                                                                                                               |
| `{"name": "repo", "env": [".env", ".env.local"]}`         | Files copied from the primary checkout into the worktree on `condash worktrees setup` — applied **unconditionally** when present (no flag needed); `--no-env` skips it. A new worktree gets every declared file (sources absent from the primary checkout are skipped); re-running setup on an already-present worktree backfills **only the declared files it is missing**, so a deliberately divergent copy (different ports to run two branches side by side) survives. Closes the silent-undefined-`VITE_*` footgun where forgetting `--copy-env` leaves a Vite SPA reading `import.meta.env.VITE_*` as `undefined`. Default empty → no copy. Path traversal is rejected (no `..`, no absolute paths).                                                                                                                         |
| `{"name": "repo", "pinned_branch": "<branch>"}`           | Pin the repo to a fixed branch. `condash worktrees setup` skips it instead of creating a worktree on the requested branch. Use for shared / vendored repos that should never track the project branch axis.                                                                                                                                                                                                                                                                                                  |
| `{"section": "<heading>"}`                                | Section marker — not a repo. Every repo that follows in `repositories[]` belongs to this section until the next `{"section"}` entry. The Settings modal renders a header row; the Code pane groups cards under the heading with an in-memory collapse toggle. Repos placed before the first marker live in an implicit default bucket that renders as today's flat list (no header). **Top-level only** — `submodules` cannot contain section markers. Carries no other field.                               |

Anything under `workspace_path` not named in `repositories` is ignored — only listed entries appear on the Code pane.

### `retired_apps`

Defunct app handles that closed-project READMEs still reference but whose repos no longer exist. Each entry is `{ "handle": "<h>", "label"?: "<l>", "aliases"?: ["<old>"] }`. They are validated against (so a historical `#handle` resolves) but never rendered as Code-pane cards and never appear in the generated Apps table. A handle is either live (in `repositories`) or retired (here) — never both.

```json
{
  "retired_apps": [
    { "handle": "kasten-manager", "label": "KastenManager", "aliases": ["KastenManager"] }
  ]
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

There are **no built-in defaults** — a slot is functional only once it carries a `command`. Unconfigured slots are omitted from the "Open with" buttons, and launching one anyway reports `open_with.<slot> is not configured`. Configure each slot you want to use.

#### Per-OS recipes { #per-os-recipes }

The `command` is invoked directly (not through a shell) — `~/` and `$VARS` are not expanded except for a leading `~/` which condash rewrites to the user's home. Pick a recipe matching your OS:

| Slot            | Linux                                                                                                                       | macOS                                                                                    | Windows                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `main_ide`      | `idea {path}` · `code {path}`                                                                                               | `open -na "IntelliJ IDEA" --args {path}` · `open -na "Visual Studio Code" --args {path}` | `idea64.exe {path}` · `code {path}` (after VS Code's "Add to PATH" installer step) |
| `secondary_ide` | `codium {path}` · `zed {path}`                                                                                              | `open -na "VSCodium" --args {path}` · `zed {path}`                                       | `code {path}` · `zed {path}`                                                       |
| `terminal`      | `gnome-terminal --working-directory {path}` · `konsole --workdir {path}` · `x-terminal-emulator --working-directory {path}` | `open -a Terminal {path}` · `open -a iTerm {path}` · `open -a Ghostty {path}`            | `wt.exe -d "{path}"` (Windows Terminal) · `cmd.exe /K "cd /d {path}"`              |

### `terminal`

Embedded-terminal preferences. All keys are optional; an empty string means "fall back to the built-in default".

| Key                         | Default                                                 | Meaning                                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `shell`                     | `$SHELL` → `/bin/bash`                                  | Absolute path to an interactive shell.                                                                                                                                               |
| `shortcut`                  | `` Ctrl+` ``                                            | Toggle the terminal pane. Modifiers: `Ctrl`, `Shift`, `Alt`, `Meta`. Key names follow the HTML `KeyboardEvent.key` convention.                                                       |
| `screenshot_dir`            | `~/Pictures/Screenshots` on Linux, `~/Desktop` on macOS | Directory scanned for "most recent screenshot" by the paste shortcut.                                                                                                                |
| `screenshot_paste_shortcut` | `Ctrl+Shift+V`                                          | Inserts the absolute path of the newest image in `screenshot_dir` into the active terminal. No `Enter` — you confirm.                                                                |
| _(agents)_                  | —                                                       | The tab-strip spawn dropdown lists **agents** from the top-level `agents` list — not a `terminal.*` key. See [Agents](#agents) below.                                                |
| `projectActions[]`          | `[]`                                                    | Configurable per-project actions — see [`terminal.projectActions`](#terminalprojectactions) below. Each entry adds an option to the dropdown next to a project's **Work on** button. |
| `newProjectActions[]`       | `[]`                                                    | Configurable starter prompts — see [`terminal.newProjectActions`](#terminalnewprojectactions) below. Each entry adds an option to the dropdown next to the **+ New project** button. |
| `move_tab_left_shortcut`    | `Ctrl+Left`                                             | Move the active tab to the left pane.                                                                                                                                                |
| `move_tab_right_shortcut`   | `Ctrl+Right`                                            | Move the active tab to the right pane.                                                                                                                                               |
| `xterm`                     | `{}`                                                    | xterm.js renderer settings — see [`terminal.xterm`](#terminalxterm) below. Editable through the Settings modal's **Terminal** section.                                               |
| `memory`                    | `{}` (enabled)                                          | Per-tab memory containment via a systemd user scope (Linux only) — see [`terminal.memory`](#terminal-memory) below.                                                                  |
| `autoRefreshOnTabSwitch`    | `true`                                                  | When `true` (default), switching to any tab automatically runs **Refresh** — full-screen TUIs, plain shells, and agent sessions are all repainted, so a hidden tab never shows a stale snapshot. Set explicitly to `false` to restrict auto-refresh to alternate-buffer tabs only (the previous default). See [Hidden terminal tabs parse off the main thread](../explanation/internals.md#terminal-worker). |

### Terminal memory { #terminal-memory }

On Linux with a systemd **user** manager and cgroup v2, condash spawns each terminal tab's pty inside its own transient `systemd-run --user --scope` carrying a memory ceiling. A tab that runs away — a leaking or over-eager agent — then trips its **own** cgroup's OOM killer and is killed **alone**, instead of the leak exhausting system RAM+swap and triggering a *global* OOM whose kill can land on condash's own renderer and take every tab down with it. On any other host the block is a no-op and tabs spawn directly. The tab strip shows each scoped tab's live usage, turning into a warning badge as it approaches the cap. Capability is probed with a throwaway scope; a **success is cached**, but a **transient failure is re-checked** on the next spawn — a momentary glitch (systemd busy under load, user manager restarting) never silently disables containment for the rest of the session. When a tab is nonetheless spawned uncapped on a capable host, condash logs a one-time warning.

The per-tab scope only binds processes spawned through the tab path. A child that skips it — a non-tab helper, or a tab left uncapped because the probe failed — stays in condash's own `app-gnome-condash-*.scope`, which carries no limit; a runaway there again escalates to a *global* OOM (this recurred and took down a whole GNOME session on 2026-07-05). The **`appScope` backstop** closes that: at startup condash caps its own app scope via `systemctl --user set-property`, so any child that escapes the per-tab cap trips condash's cgroup OOM instead of the machine's global one. Same Linux + systemd gate; a no-op elsewhere.

All keys optional; sizes are systemd size strings (`"6G"`, `"512M"`, `"infinity"`).

| Key        | Default   | Meaning                                                                                                                       |
| ---------- | --------- | --------------------------------------------------------------------------------------------------------------------------- |
| `enabled`  | `true`    | Master switch for the per-tab caps. Set `false` to force plain spawns everywhere. No effect on hosts without a systemd user manager + cgroup v2.  |
| `high`     | `"6G"`    | Soft limit (`MemoryHigh`): the kernel throttles + reclaims the tab's cgroup past this, buying time before the hard wall.     |
| `max`      | `"8G"`    | Hard limit (`MemoryMax`): the tab's cgroup is OOM-killed at this ceiling — what guarantees a leak kills only the one tab.    |
| `swapMax`  | `"2G"`    | Swap ceiling (`MemorySwapMax`) so a capped tab can't instead exhaust system swap.                                            |
| `appScope` | `{}` (on) | Backstop cap on condash's **own** app scope — see below.                                                                     |

Raise `max` for legitimately memory-hungry runs (e.g. a multi-agent session); the trade-off is a higher ceiling before a runaway is contained.

**`terminal.memory.appScope`** — the whole-session backstop. All keys optional.

| Key       | Default             | Meaning                                                                                                                                     |
| --------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled` | `true`              | Set `false` to leave condash's app scope uncapped (per-tab caps still apply).                                                              |
| `max`     | physical RAM − 3 GB | Hard limit (`MemoryMax`) on condash + any child not in its own tab scope. Floored at half RAM. Kept below total RAM so the cgroup OOM fires before the system's global one. |
| `swapMax` | `"2G"`              | Swap ceiling (`MemorySwapMax`) on the app scope — the lever that stops a runaway from thrashing all of system swap into a global OOM.        |

### Agents { #agents }

**Agents** are a flat list of terminal launchers under the top-level `agents` key. The tab-strip spawn dropdown lists them (it always offers `New shell` first, then each agent by `label`). Picking one opens a new terminal tab running its `command` — that's the whole model. `agents` is a **global** key: these are personal launcher tools, identical no matter which conception is open, so the list lives once in the per-machine `settings.json`.

**Favourites.** Mark agents with `"favorite": true` to keep the dropdown short: it then shows `New shell` + the favourites (each prefixed with a ★) directly, and tucks every non-favourite under a `More ▸` fly-out submenu. With **no** agent marked favourite, the dropdown lists every agent inline — so the split only takes effect once at least one agent opts in. Order within each group follows config order. A long `More ▸` list never runs off-screen: the fly-out is capped to the viewport and wraps into multiple columns (scrolling only as a last resort), and flips left or up so the whole popup stays visible.

```json
{
  "agents": [
    { "id": "claude", "label": "Claude", "command": "claude", "favorite": true },
    { "id": "claude-kimi", "label": "Claude · Kimi", "command": "claude-kimi", "favorite": true },
    { "id": "opencode-kimi", "label": "OpenCode · Kimi", "command": "opencode-kimi" }
  ]
}
```

| Key           | Type   | Required | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | string | yes      | Stable identity referenced by [tasks](#tasks) and the `agent` field of [project / new-project actions](#terminalprojectactions). Non-empty.                                                                                                                                                                                                                                                                                                                                                                         |
| `label`       | string | yes      | Display name shown in the spawn dropdown and as the pinned tab title.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `command`     | string | yes      | Shell command run on launch, in a fresh tab with the terminal's ambient environment. Point it at a wrapper on `PATH` or inline the invocation. Blank → skipped.                                                                                                                                                                                                                                                                                                                                                     |
| `promptFlags` | bool   | no       | Default `false`. Set `true` when `command` understands [agedum](../guides/agent-clis-and-models.md)'s `--prompt` / `--run` flags. [Tasks](#tasks) and agent-bound [actions](#terminalprojectactions) then pass the prompt in argv — `<command> --run "<prompt>"` when submitting (non-interactive, exits) or `<command> --prompt "<prompt>"` otherwise (interactive, seeded) — instead of spawning the bare command and typing the prompt into the live TUI. Leave off for an opaque command (e.g. a raw `claude`). |
| `favorite`    | bool   | no       | Default `false`. Surface this agent directly in the spawn dropdown (prefixed with a ★); non-favourites move under a `More ▸` fly-out. When no agent is marked, every agent is listed inline.                                                                                                                                                                                                                                                                                                                        |

condash builds **no** provider environment and stores **no** secrets — model/provider wiring and any API token live entirely in `command` (usually a `~/bin` wrapper script). See the [Agent CLIs and model providers guide](../guides/agent-clis-and-models.md) for wrapper recipes. Edit the list in the Settings modal's **Launchers** section (under **Personal · this machine**) or in `settings.json` directly. **Migration:** condash ≤ 3.25 had `terminal.launchers` + the scalar `terminal.launcher_command`; both are dropped on read. (A later per-file `<conception>/agents/<slug>.json` harness store was also replaced by this `agents` list.)

### Tasks { #tasks }

**Tasks** are reusable, parameterized agent prompts — like agents, they live under the conception (not a `condash.json` key), managed by the **Tasks** pane (left activity rail → **Tasks**). A task is a referenced agent plus a markdown prompt with fillable `{markers}`.

- **Definition** — `<conception>/tasks/<slug>/`, one directory per task. `task.json` carries `name`, `agent` (the `id` of an agent from the `agents` list above), and `submit` (optional bool, default `true`); `prompt.md` is the raw markdown prompt with markers. Config in JSON, prose in markdown — both are safe to commit. The slug is the directory name (`^[a-z0-9-]+$`); the `tasks/` tree is created on first save.
- **Markers** — `{KEY}` (required field) or `{KEY:default}` (prefilled). Reserved `{APP}` / `{PROJECT}` (and their `{APP_PATH}` / `{PROJECT_BRANCH}` / … sub-tokens) render as searchable pickers; one selection fills the whole family. `{TABS}` and `{UPDATED_TABS}` are **condash-provided** (never fields) — both expand to the open-tab list `[{sid,cwd,repo,cmd}]`, `{UPDATED_TABS}` narrowed to the tabs that produced new output since the task's last scheduled run. A `{KEY:default}` marker must not have whitespace right after the `:` — code-like fragments such as `{key: .sid}` (e.g. inside an inline `jq` snippet) are not treated as markers.
- **Run** — spawns the task's agent in a fresh terminal tab (cwd = conception root). For an opaque agent it types the substituted prompt and presses Enter when `submit` is true; for an agent with [`promptFlags`](#agents) it instead passes the prompt in argv per the task's **run mode** (`--prompt` interactive, or `--run` one-shot) and types nothing.
- **`taskConfig`** — per-task scheduling + run mode + log routing, keyed by slug, in **`.condash/settings.json`** — _not_ in `task.json`. It is a conception key (it describes this tree's tasks) and lives only in the conception file. Each entry is `{ schedule?, timeout?, runMode?, excludeFromLogs?, gateOnUpdatedTabs? }`:
  - `schedule` — opt-in cadence (`s` / `m` / `h` / `d`, e.g. `5m` / `1h` / `7d`). The editor takes a free-text cadence and shows the parsed interval beside the field. A scheduled task runs **headless** (no tab) on that interval, single-flighted (never overlaps its own still-running run); the tabs that changed since the last run are handed to it as `{UPDATED_TABS}` (see `gateOnUpdatedTabs` to also skip idle ticks). Its console output is teed to `.condash/scheduled/<slug>/` (last ~5), **never** the normal logs. No default schedule; the task must carry a prompt-seedable agent.
  - `timeout` — per-run hard cap (same cadence syntax; absent = `10m`). With `runMode: oneshot` the agent exits on its own and this is a pure backstop; with the default `interactive` it is also the _discard_ mechanism for an agent that finishes its work but never exits. Keep it ≤ `schedule` or single-flight stretches the effective cadence to the timeout. The editor offers 1m / 5m / 10m / 30m / 1h.
  - `runMode` — per-task default for how a `promptFlags` agent is driven: `interactive` (agedum `--prompt`, the default — the session stays open) or `oneshot` (`--run` — runs the prompt once and exits). Overridable per run in the run popup. **Prefer `oneshot` for a scheduled task** so its headless run exits cleanly instead of being killed at `timeout`. Ignored for an opaque agent (keystroke path, interactive only).
  - `excludeFromLogs` — per-task default for routing a _manual_ run's `.txt` to `.condash/manual/<slug>/` instead of `.condash/logs/` (overridable per run in the run popup). The tab stays visible.
  - `gateOnUpdatedTabs` — opt-in growth gate (default off). When `true`, a due tick is **skipped** unless some open tab produced new output since the task's last run, so a quiet workspace spends nothing. Leave it off (the default) and the task runs on every interval regardless of tab activity. Enable it only for a task that acts on `{UPDATED_TABS}`; a task that doesn't read updated tabs would be starved by it.

  Both segregated stores are browsable from the Logs pane's **Task runs** view and stay invisible to the normal Logs list, search, and reports.

See the [Tasks pane guide](../guides/tasks-pane.md). The same `{KEY:default}` fallback applies to the project / new-project action templates below.

### `terminal.projectActions` { #terminalprojectactions }

Per-entry actions rendered in the per-card **Work on** dropdown on the Projects pane. The control is a single dropdown button: clicking it opens a menu whose first row is the built-in **Work on <slug>** action and whose remaining rows are the entries below. When `projectActions` is empty or missing, the menu still opens but contains only the default row.

```json
{
  "terminal": {
    "projectActions": [
      {
        "label": "Claude review",
        "template": "claude \"review project {shortSlug}\"",
        "submit": true
      },
      {
        "label": "Kimi summary",
        "template": "summarise {shortSlug}",
        "submit": true,
        "agent": "kimi"
      }
    ]
  }
}
```

| Key        | Type   | Required | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `label`    | string | yes      | User-defined name shown in the dropdown. Empty or whitespace is treated as the entry being unset (no dropdown option rendered).                                                                                                                                                                                                                                                                                                                                                                                               |
| `template` | string | yes      | Text pasted into the focused terminal when the entry is selected. May contain `{slug}`, `{shortSlug}`, `{title}`, `{branch}`, `{base}`, `{kind}`, `{status}`, `{date}`, `{apps}`, `{firstApp}`, `{path}`, `{relPath}`, and global placeholders (`{today}`, `{conception}`, `{conceptionPath}`). A `{placeholder:default}` form falls back to `default` when the placeholder is unknown; a default-less unknown placeholder is left verbatim so typos remain visible. Empty or whitespace is treated as the entry being unset. |
| `submit`   | bool   | no       | When `true`, condash presses Enter after pasting the template. Default `false` — matches the current **Work on** behaviour and lets templates that end with a colon wait for the user to type the variable bit.                                                                                                                                                                                                                                                                                                               |
| `agent`    | string | no       | When set, the `id` of an agent from the `agents` list. The action spawns a fresh tab running that agent's command before typing the template — useful for binding an action to a specific agent. Empty / missing → type into the focused tab (a plain shell when no tab exists). An id that no longer matches an agent falls through to the focused-tab flow.                                                                                                                                                                 |

### `terminal.newProjectActions` { #terminalnewprojectactions }

Per-entry starter prompts rendered in the **+ New project** dropdown. The control is a single dropdown button: clicking it opens a menu whose first row opens the New project modal (the built-in default) and whose remaining rows are the configured starter prompts. When `newProjectActions` is empty or missing, the menu still opens but contains only the default row.

```json
{
  "terminal": {
    "newProjectActions": [
      {
        "label": "Spec + design starter",
        "template": "start project for new feature, make spec.md note with functional specification, and design.md note with design plan:",
        "submit": false
      },
      {
        "label": "Start new project (Claude)",
        "template": "Start new project ",
        "agent": "claude-kimi"
      }
    ]
  }
}
```

| Key        | Type   | Required | Meaning                                                                                                                                                                                                                                                                                                                                                   |
| ---------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `label`    | string | yes      | User-defined name shown in the dropdown. Empty or whitespace is treated as the entry being unset.                                                                                                                                                                                                                                                         |
| `template` | string | yes      | Text pasted into the focused terminal. May contain global placeholders only: `{today}`, `{conception}`, `{conceptionPath}`. A `{placeholder:default}` form falls back to `default`; a default-less unknown placeholder is left verbatim. Empty or whitespace is treated as the entry being unset.                                                         |
| `submit`   | bool   | no       | When `true`, condash presses Enter after pasting. Default `false`.                                                                                                                                                                                                                                                                                        |
| `agent`    | string | no       | When set, the `id` of an agent from the `agents` list. The action spawns a fresh tab running that agent's command and types the template into the new tab — gives each entry a predictable starting environment (e.g. **Start new project → claude-kimi** always opens a fresh agent shell). Empty / missing keeps the "type into focused tab" behaviour. |

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
    "projectsSplit": 0.42
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
    "skills": ["pr"],
    "skillsUser": ["git"]
  },
  "selectedBranches": ["feature-foo", "release-2026-05"],
  "branchFilterStickyAll": false,
  "skillsActiveScope": "conception"
}
```

| Key                     | Meaning                                                                                                                                                                                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lastConceptionPath`    | Absolute path to the conception tree condash should render. Replaces the older `conceptionPath` field — a one-shot migration on first read rewrites old files.                                                                                                                                                 |
| `recentConceptionPaths` | Newest-first list of paths the user has opened (cap 5). Drives the **File → Open Recent** submenu and the Settings modal's recents section.                                                                                                                                                                    |
| `theme`                 | A theme preset id (`light`, `dark`, `console`) or `system`. Persisted by `setTheme`. See [Theme](#theme).                                                                                                                                                                                                      |
| `uiFonts`               | Per-category UI typography (family, weight, size). See [UiFonts](#uifonts) below. Set in **Settings → Appearance**; applied live via the `--ui-font-*` / `--ui-weight-*` / `--ui-size-*` CSS variables. Any field unset ⇒ `default`.                                                                              |
| `terminal.*`            | Embedded-terminal preferences. See [Terminal preferences](#terminal-preferences) above for every sub-key.                                                                                                                                                                                                      |
| `layout`                | Composite-layout state. See [LayoutState](#layoutstate) below.                                                                                                                                                                                                                                                 |
| `welcome`               | First-launch state. `welcome.dismissed: true` hides the Welcome screen even when both Projects and Knowledge are empty.                                                                                                                                                                                        |
| `cardMinWidth`          | Per-pane card grid min-width. See [CardMinWidth](#cardminwidth) below.                                                                                                                                                                                                                                         |
| `treeExpansion`         | Per-pane set of expanded directory `relPath`s for the Knowledge / Resources / Skills tree panes (`knowledge`, `resources`, `skills` for the conception scope, `skillsUser` for the user scope of the Skills pane). Empty (or missing) means everything is collapsed — the on-purpose first-load state per #89. |
| `selectedBranches`      | Branches pinned by the Code-pane top-of-pane filter. The primary worktree row is always rendered; this set is additive on top of it. Honoured only when `branchFilterStickyAll` is false.                                                                                                                      |
| `branchFilterStickyAll` | True ⇒ Code-pane filter is in **All (sticky)** mode: every branch is shown and new ones auto-pin. False ⇒ honour `selectedBranches` exactly (empty = main only). Defaults to true on first read when no explicit selection was ever made, false otherwise.                                                     |
| `skillsActiveScope`     | Active scope in the Skills pane — `conception` or `user`. Defaults to `conception`. Persisted on every scope switch.                                                                                                                                                                                           |

Personal/per-machine keys — `terminal`, `agents`, `open_with`, `pdf_viewer`, `dashboard`, `theme`, `uiFonts`, `layout`, `cardMinWidth`, `treeExpansion`, `selectedBranches`, `branchFilterStickyAll`, `welcome`, `skillsActiveScope` — are valid **only** in `settings.json`; a conception file that carries one is rejected (and the [scope-partition migrator](#scope-partition-migrator) lifts it here on open). Conversely, the tree-shape keys `workspace_path`, `worktrees_path`, `long_lived_branches`, `repositories`, `retired_apps`, and `taskConfig` are conception-only and are **not** accepted in `settings.json`. `lastConceptionPath` / `recentConceptionPaths` are global-only too — a conception's file cannot set them, since those describe the tree's own location and the machine-local recents list.

### LayoutState

`settings.json` carries the composite-layout snapshot so a fresh launch reopens with the last layout.

| Field           | Type                                                                 | Meaning                                                                                                                                                                                                                                                                         |
| --------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projects`      | bool                                                                 | Show or hide the left band.                                                                                                                                                                                                                                                     |
| `leftView`      | `'projects' \| 'tasks' \| 'deliverables'`                            | Which pane fills the left band — the Projects list, the Tasks list, or the Deliverables aggregation of every project's `## Deliverables`. Selected by the left activity rail. Defaults to `'projects'`. A persisted `'outputs'` (v3.20.0) is migrated to `'deliverables'`. |
| `working`       | `'code' \| 'knowledge' \| 'resources' \| 'skills' \| 'logs' \| null` | Six-state. `'code'`, `'knowledge'`, `'resources'`, `'skills'`, or `'logs'` shows that pane in the working slot; `null` hides them all.                                                                                                                                          |
| `terminal`      | bool                                                                 | Show or hide the Terminal pane at the bottom.                                                                                                                                                                                                                                   |
| `projectsSplit` | number 0.02 – 0.98                                                   | Splitter position as a fraction of the band width, set by dragging. A fraction (not a pixel width) so the split stays proportional when the window is resized. The bounds are loose on purpose — the renderer's px clamp (a 200px floor per pane) is the real constraint, and a tighter fraction bound would disagree with it on a wide monitor and snap the handle away from where it was released. Upgrading from the older `projectsWidth` drops that key; an existing `projectsSplit` is kept, and only an absent or non-numeric one falls back to the default. The pixel value is not converted — the band width it was measured against is unknowable at parse time. |

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

### Theme

`theme` names one of the presets in the registry (`src/shared/themes.ts`), or `system`.

| Value     | Name         | Kind  | Character                                                        |
| --------- | ------------ | ----- | ---------------------------------------------------------------- |
| `light`   | Paper        | light | Warm paper light — the vcoeur editorial palette.                   |
| `dark`    | Warm Gallery | dark  | Gold on warm black — the gallery-dark lead theme.                  |
| `console` | Console      | dark  | Terminal-native: deep ink, phosphor green, monospace throughout.   |
| `system`  | System       | —     | Follows the OS preference between Paper and Warm Gallery.          |

Each preset is **self-contained**: it carries its own palette, and `console` also
tightens the radius scale and re-points the brand font stacks at JetBrains Mono.
There is no separate dark/light switch — a preset's `kind` is the only place the
distinction lives, and it is what every binary subsystem (xterm, CodeMirror,
highlight.js, mermaid) reads.

Pick a theme in **Settings → Appearance**, where each preset renders as a card
with a swatch of its own colours. **Selecting a card previews it immediately**
across the whole app — that is how you see a theme before committing to it — but
nothing is written until you press Save, so closing the modal without saving
puts the current theme back. The status-bar moon/sun button cycles through the
list and persists straight away. Note that the ids `light`
and `dark` predate the registry and are kept so existing `settings.json` files
keep working — they are the *ids* of Paper and Warm Gallery, not a mode.

The renderer resolves the choice in JS and stamps two attributes on `<html>`:
`data-theme` (the preset id, selecting the palette block in `styles.css`) and
`data-theme-kind` (`dark` or `light`, which every dark-only CSS rule keys on).
Adding a preset is one registry entry plus one `[data-theme='<id>']` block.

### UiFonts

`uiFonts` groups the UI into five typographic categories, each a `{ family, weight, size }` object that restyles every element in the group at once. Each field is independent and any left `default` keeps the theme's value for that surface, so an all-`default` category (or an unset key) renders exactly as before the picker existed.

| Category    | Elements                                                              | `default` family |
| ----------- | -------------------------------------------------------------------- | ---------------- |
| `cardTitle` | Project, knowledge, and task card/list titles.                       | editorial serif  |
| `heading`   | Pane headers, section titles, modal titles, project-preview title.   | editorial serif  |
| `body`      | Sidebar, controls, and general UI/body text.                         | UI sans          |
| `code`      | Task ids, code-pane names, deliverables, and code blocks.            | monospace        |
| `terminal`  | Terminal chrome and log viewers.                                     | monospace        |

Each category field:

- **`family`** — `default` or one of the cross-platform faces `sans`, `serif`, `mono`, `system`, `georgia`, `times`, `helvetica`, `verdana`, `trebuchet`, `palatino`, `courier` (no fonts are bundled — the picker renders each option in its own face).
- **`weight`** — `default`, `light`, `regular`, `medium`, `semibold`, or `bold` (300–700).
- **`size`** — `default`, `xs` (85%), `sm` (92%), `lg` (112%), or `xl` (128%), a relative scale multiplied onto the element's base size.

The renderer applies each non-`default` field as a `:root` CSS variable — `--ui-font-*` (family), `--ui-weight-*` (numeric weight), `--ui-size-*` (scale factor) — plus a matching `data-ui-*` attribute that scopes the rule in `ui-fonts.css`, so live edits in the Settings modal restyle the app without a reload. `default` sets no variable, so the element keeps its own family/weight/size. Family covers every element in a category (via the role tokens and carved `--ui-font-*` vars); weight and size apply to each category's primary text surfaces.

The embedded terminal's own canvas font is set separately in **Settings → Terminal** (`terminal.xterm`); the `terminal` category here governs the surrounding terminal/log chrome text.

`uiFonts` supersedes the earlier single `projectCardTitleFont` scalar (v4.86.0). A saved `projectCardTitleFont` value is folded into `uiFonts.cardTitle.family` and the legacy key dropped on the next read (see [config migration](#scope-partition-migrator)).

Resolution order for the conception path, checked in sequence:

1. `CONDASH_CONCEPTION_PATH` env var (session-scoped override; doesn't touch `settings.json`).
2. `lastConceptionPath` in `settings.json`.
3. The first-launch folder picker. On selection, the picker writes the chosen path to `lastConceptionPath` and prepends it to `recentConceptionPaths` (cap 5) so the next launch picks it up automatically.
4. **File → Open Recent** lets the user switch between recent paths without a folder dialog. Picking a recent promotes it to the head of the list and swaps the active conception immediately.

The file is created on demand: the first-launch folder picker writes it; you can also create it by hand.

## Editing from the dashboard

**File → Settings…** (`Ctrl+,`) opens a full-viewport modal — one scrolling surface, no tabs and no in-modal JSON editor; each persisted preference has its own form control. The left rail groups the sections under two scope headers, one per file:

**Personal · this machine** — writes `settings.json`:

- **Recent conceptions** — manage the recents list backing **File → Open Recent**.
- **Appearance** — theme (preset cards with swatches; selecting one previews it live); per-category UI fonts (with a live preview); per-pane card-grid min-widths.
- **Terminal** — embedded terminal preferences (`terminal`, including `xterm`, `logging`, and the project-action templates).
- **Launchers** — the `agents` list.
- **Open with** — the three IDE/terminal launch slots.
- **Dashboard** — live tab-summarization config (incl. the secret `apiKey`).

**This conception** — writes `.condash/settings.json` (the legacy `condash.json` / `configuration.json` are read but never written to):

- **Workspace & paths** — `workspace_path`, `worktrees_path`, `long_lived_branches`.
- **Repositories** — the ordered repo list, per-repo `run` / `force_stop`.

Each section carries a **scope chip** naming the file it writes (`settings.json` or `.condash/settings.json`). Because every setting has exactly one home, there are **no** inheritance badges, no override state, and no Reset-to-global controls — the old two-tab + badge machinery was removed with the scope-partition revamp. Edits stage as drafts (a per-section dirty pip flags unsaved changes); **Save** flushes them and **Discard** drops them. Each draft round-trips through atomic CAS — `settings.json` via `patchSettings` / `writeGlobalSettings`, `.condash/settings.json` via `patchConfig` / `writeNote` — schema-validated by the [strict zod schemas](https://github.com/vcoeur/condash/blob/main/src/main/config-schema.ts) (`globalSettingsSchema` and `conceptionConfigSchema`, now **disjoint**) before the bytes hit disk.

The rail also carries **Open settings.json** and **Open .condash/settings.json** buttons (open the file in the OS default editor).

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
