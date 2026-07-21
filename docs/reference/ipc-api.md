---
title: IPC API · condash reference
description: The full Electron IPC contract between the renderer and the main process — every verb, what it does, and which file owns the handler.
---

# IPC API

> **Audience.** Developer.

condash is a single-process Electron app: there is no embedded HTTP server, no axum, no `127.0.0.1:<port>`. The renderer talks to the main process exclusively through Electron IPC, and the entire surface is the [`CondashApi`](https://github.com/vcoeur/condash/blob/main/src/shared/api.ts) interface in `src/shared/api.ts`.

This page is the public reference for that contract. The preload bridge ([`src/preload/index.ts`](https://github.com/vcoeur/condash/blob/main/src/preload/index.ts)) exposes one method per verb on `window.condash`; the main-process registry ([`src/main/index.ts:registerIpc`](https://github.com/vcoeur/condash/blob/main/src/main/index.ts)) registers exactly one handler per verb. No string-mux'd actions, no implicit channels.

> **Why no HTTP API?** The Electron build doesn't need one. Tauri's `condash-serve` headless mode existed because Tauri wraps an HTTP server; Electron has direct IPC, so a dual-protocol front door would be pure cost. Drive the renderer through Electron itself for end-to-end tests.

## Calling convention

All request/response verbs return a `Promise`. Subscriptions return an unsubscribe function the renderer calls from `onCleanup`:

```ts
const stop = window.condash.onTreeEvents((events) => { /* … */ });
onCleanup(stop);
```

Verb names are **camelCase** (e.g. `toggleStep`, `termSpawn`) on both sides of the bridge. The dotted form (`step.toggle`, `term.spawn`) is not used.

## Boot bundle

| Verb | Returns | What it does |
|---|---|---|
| `bootstrap()` | `BootstrapData` | One-shot mount-time bundle: the active conception path plus every startup settings value (theme, layout, welcome flag, card min-widths, tree expansion, branch filter, skills scope, open-with slots, terminal prefs) in a single round-trip backed by one `readSettings()` in main. The renderer calls it once at startup so its stores skip the serial `getConceptionPath` gate and the ~15 individual settings getters; the getters remain for reloads. Owned by `ipc/bootstrap.ts`. |

## Tree reads

| Verb | Returns | What it does |
|---|---|---|
| `listProjects()` | `Project[]` | Walk `projects/<month>/<slug>/README.md`, parse the metadata block, return the full project list. |
| `getProject(path)` | `Project \| null` | Re-parse a single README — used to patch the in-memory list after a watcher event. |
| `listProjectFiles(path)` | `ProjectFileEntry[]` | List a project directory's contents recursively — files *and* directories (`kind: 'file' \| 'dir'`), dot-entries skipped. Directory entries are emitted too so the preview's file tree can render structure, including empty dirs. |
| `readKnowledgeTree()` | `KnowledgeNode \| null` | Walk `knowledge/`, return the directory + file structure (or `null` if no `knowledge/` exists). |
| `readResourcesTree()` | `ResourceNode \| null` | Walk `<conception>/resources/` (hard-coded, not configurable), return the file tree with per-file MIME / category metadata. `null` if the directory doesn't exist. |
| `readSkillsTree(scope, tab)` | `SkillNode \| null` | Walk the `(scope, tab)` skills directory — `local` reads the conception, `global` reads the per-machine user scope (`~/.config/agents/`, `~/.claude/`, `~/.kimi/`, `~/.config/opencode/`). Markdown only, with title / summary parsed from the head and optional `shipped` / `diverged` chips (condash ships only the Generic `.agents/skills/` tree). `null` when the directory is absent. |
| `readSkillFile(path)` | `string` | Read-only content fetch for a Skills-pane file. Like `readNote` but also permits the user-scope skill locations (the global scope lives outside the conception); rejects anything else. |
| `search(query, scopes?)` | `SearchResults` | Full-text search across projects, knowledge, resources, skills, and logs. Markdown sources are served from an in-memory index; logs are scanned on disk, and only when in scope (see [Internals — The search index](../explanation/internals.md#search-index)). |

## Mutations

Every mutation carries the **expected** state of the region it's about to change. The main process refuses to write if disk has drifted from the expectation. The renderer surfaces a "reload before saving" toast on conflict.

| Verb | Drift check |
|---|---|
| `toggleStep(path, lineIndex, expectedMarker, newMarker)` | Compare line's existing marker (`[ ]`, `[~]`, `[x]`, `[-]`, `[!]`) to `expectedMarker`. |
| `editStepText(path, lineIndex, expectedText, newText)` | Compare line's existing text to `expectedText`. |
| `addStep(path, text)` | Append-only — no drift check. |
| `setStatus(path, newStatus, opts?)` | Verify the metadata block contains a Status line. On done-edges (close: prev → done, reopen: done → prev) also append a `Closed.` / `Reopened.` line to `## Timeline`. Returns `TransitionResult` with `timelineAppended` non-null exactly when a timeline line was written. |
| `createProject(input)` | Allocate `projects/<YYYY-MM>/<YYYY-MM-DD>-<slug>/` from the canonical kind template. Returns `{ slug, readmePath }`. |
| `createProjectNote(projectPath, slug)` | Create `<projectPath>/notes/NN-<slug>.md`. Scans `notes/` for the highest existing `NN-` prefix, increments by one, sanitises the slug, writes an empty file, returns the absolute path. |
| `writeNote(path, expectedContent, newContent)` | Full-file content compare. For `.condash/settings.json` (or the legacy `condash.json`), the main process canonicalises the JSON through the Zod schema before writing — the bytes that hit disk can differ from `newContent`. Returns the bytes actually written so the caller can keep its CAS baseline aligned with disk. |
| `readNote(path)` | Read a single file's contents. Path must resolve under the conception. |
| `exportNotePdf(path, html)` | Export a rendered note as a PDF. `html` is the self-contained document the renderer built (`note-modal-parts/export-pdf.ts`); `path` is the source note, used only to seed the save dialog's default `<name>.pdf`. Main pops the save dialog, prints the document via `printToPDF` in a hidden window, and writes the result. Returns the saved path, or `null` on cancel. |

Step markers are `[ ]` (open), `[~]` (in-progress), `[x]` (done), `[-]` (abandoned), `[!]` (blocked). The dashboard cycle order through the toggle button is `open → progress → done → abandoned → open` (see [`src/renderer/panes/projects.tsx`](https://github.com/vcoeur/condash/blob/main/src/renderer/panes/projects.tsx)); `[!]` is reachable by editing the README directly and round-trips through every layer (parser, counter, writer, renderer badge).

All writes are `tmp` → `fsync` → `rename`. The per-file write queue (`mutate.ts:withFileQueue`) serialises concurrent writes to the same path.

## Repos + runners

| Verb | What it does |
|---|---|
| `listRepos()` | Read the conception's `repositories` (from `.condash/settings.json`, or legacy `condash.json` / `configuration.json`), scan each for a `.git/`, attach cached dirty count and worktrees. |
| `listReposForPrimary(name)` | Per-primary partial reload — returns the primary's `RepoEntry` plus its submodule children freshly re-read. Driven by the structural FS-watcher event `repo-worktrees-changed`. |
| `invalidateGitStatus()` | Drop the 3 s TTL git-status cache (used by the Refresh button). |
| `getDirtyDetails(path, opts?)` | Detailed `git status -s` + `git diff --stat HEAD` for a worktree path. Powers the click-to-inspect popover on the per-branch `N dirty` badge. Returns `null` when the path is missing or not a git repo. |
| `forceStopRepo(repoName)` | Run the repo's `force_stop:` shell command — escape hatch for a port held by a non-condash process. |
| `pullBranch(path)` | Fast-forward a worktree to its upstream (`git pull --ff-only`) — the per-branch **Pull branch** menu action. Refuses on a dirty tree and returns `updated` / `up-to-date` / `diverged` / `dirty` so the caller can toast the outcome; throws on an unexpected git failure (no upstream, network, not a repo). |
| `lookupPullRequest(path, branch)` | Resolve the open GitHub PR whose head is `branch` (`gh pr list --head`, run in the worktree at `path`) — backs the per-branch **Open PR** menu item. Returns the PR (`number` / `url` / `title` / `isDraft`) or `null` when there's no open PR or `gh` can't run (unauthenticated, no GitHub remote); never throws, so the menu simply omits the row. TTL-cached by `(path, branch)`. |
| `listOpenPullRequests(app)` | List every open GitHub PR (with its `headRefName`) for the repo the `apps:` token `app` resolves to — `gh pr list --state open`, one call per repo. Backs the **Projects-pane card badges**: the renderer indexes the results by head branch so each project card matches its own branch without a per-card call. `app` is resolved to the configured repo via the name / `#handle` / alias map (never a renderer-supplied path). Returns `[]` for an unknown app or a lookup that can't run. TTL-cached by repo path. |
| `listOpenWith()` | Return `open_with` slots from `<conception>/.condash/settings.json` (with legacy `condash.json` / `configuration.json` as read fallbacks). Slots resolve through the conception ⊕ global precedence; the global `settings.json` provides defaults. |
| `launchOpenWith(slot, path)` | Spawn the configured editor against `path`. |
| `openInEditor(path)` | Resolve the user's preferred editor and open the file. |
| `openConceptionDirectory()` | Reveal the conception root in the OS file manager. |
| `openExternal(target)` | Open `target` with the OS default handler. Accepted schemes: `http:`, `https:`, `mailto:`. Other schemes (including `file:`) reject — call `openPath` for filesystem paths. |
| `openPath(target)` | Open a local filesystem path with the OS default handler. Used by the Settings modal's "Open externally" buttons for `.condash/settings.json` and the global `settings.json`. Caller passes an absolute path. |
| `showInFolder(target)` | Reveal a file or directory in the OS file manager (selects it in its parent folder). Backs the "reveal in file manager" affordance on the Resources / Logs / Deliverables / Code card panes. Absolute path. |
| `pdfToFileUrl(path)` | Build a `file://` URL for a local PDF (handles Windows drive letters and percent-encoding). Returns the URL plus the basename so the renderer can render it without doing its own POSIX-only path split. |

## PTY sessions

The terminal pane spawns and drives node-pty sessions. Lifecycle: `termSpawn` → stream `onTermData` events → `termWrite` for stdin → `termClose` on user exit. Window close runs the kill pipeline against every live session.

| Verb | What it does |
|---|---|
| `termSpawn(request)` | Allocate a pty (setsid → own process group), return session id and resolved cwd. |
| `termWrite(id, data)` | Forward stdin bytes. |
| `clipboardReadText()` | Read the system clipboard via the main-process Electron `clipboard`. Backs the terminal's `Ctrl+V` handler — the renderer's `navigator.clipboard.readText()` is permission-gated and unreliable. |
| `termResize(id, cols, rows)` | `TIOCSWINSZ` on the pty. |
| `termClose(id)` | Run the kill pipeline: `SIGTERM` → optional `force_stop` → 500ms wait → `SIGKILL` on the process group. |
| `termList()` | Snapshot of live (or recently-exited) sessions. Used by the panel rebuild on pane switch. |
| `termAttach(id)` | Pull the buffered output for an existing session, used on renderer mount to replay history into a freshly-created xterm. |
| `termSetSide(id, side)` | Re-side a session — used by the Code-pane pop-out button to surface a running dev server in the bottom "My terms" pane. `side` is `'my'` or `'code'`. |
| `termGetPrefs()` | Read `settings.json:terminal` (shell, shortcut, font, palette). |
| `termSetPrefs(prefs)` | Replace the persisted terminal prefs in `settings.json`. The patch is a full replacement; pass `{}` to clear back to defaults. |
| `termLatestScreenshot(dir)` | Find the newest `*.png` under `dir` (used by the screenshot-paste helper). |
| `onTermData(cb)` | Subscribe to stdout/stderr bytes — single channel, multiplexed by session id. |
| `onTermExit(cb)` | Subscribe to session-exit events. |
| `onTermSessions(cb)` | Sessions changed (spawn / exit / close). Receives the full snapshot. |
| `termTabsContext()` | The open, live tabs as `[{sid,cwd,repo,cmd}]` — the `{TABS}` provided-var payload (capability 2), used to seed a manual task run. A manual run seeds `{UPDATED_TABS}` from the same list (no per-run watermark to diff against). |

> **Flow control (`termAck`).** `onTermData` payloads carry an `epoch` field, and for every payload the preload fires a fire-and-forget `ipcRenderer.invoke('termAck', id, byteLength, epoch)` back to main. This is a backpressure ack — main counts the acked bytes to decide when to pause / resume the pty — **not** part of the typed `CondashApi`; it lives below the interface as a preload-internal channel. The `epoch` guards against a stale ack (minted before a renderer re-navigation flow reset) debiting the fresh flow. It fails soft: a dropped ack can only stall the pty, never corrupt it.

## Terminal log surfaces

Per-session terminal capture (when `terminal.logging.enabled` is true) lands at `<conception>/.condash/logs/YYYY/MM/DD/HHMMSS-<sid>.txt`. The Logs working surface reads the directory tree through this set of verbs; deletions go through the same paths the in-app janitor uses, with `requirePathUnder` bounding every input against the conception's logs root.

| Verb | What it does |
|---|---|
| `logsListDays()` | List day directories under `.condash/logs/` newest first. Returns `Array<{ day: 'YYYY-MM-DD', sessionCount: number, totalBytes: number }>`. |
| `logsListSessions(day)` | List session files within a given day. Returns `TermLogSessionMeta[]` — see [`src/shared/types/logs.ts:TermLogSessionMeta`](https://github.com/vcoeur/condash/blob/main/src/shared/types/logs.ts). Parses the `# condash: {...}` header (+ footer when present) on each file. |
| `logsReadSession(filePath)` | Read one session file. Returns `TermLogSessionRead` — `{ text, meta }` with metadata header / footer stripped from the body. |
| `logsDeleteDay(day)` | Delete an entire day directory. Returns the number of session files removed. |
| `logsDeleteSession(filePath)` | Delete one session file. Refuses paths outside `.condash/logs/`. |
| `logsListTaskRuns()` | Enumerate the segregated task-run store under `.condash/{scheduled,manual}/<slug>/` (capabilities 1 + 4). One `TaskRunGroup` per `<trigger>/<slug>`, runs newest-first. Never reads `.condash/logs/`; the Logs pane's **Task runs** view renders it. |
| `listRunningTaskRuns()` | Snapshot of the headless scheduled runs currently in flight (capability 1) — `RunningTaskRun[]` of `{ slug, sid, startedAt, logPath }`. Feeds the Tasks pane's **Running** section. |
| `killTaskRun(sid)` | Kill (SIGKILL) and discard the live run with this `sid`. Returns `false` when none is live. |

## Agents + tasks

Agents are terminal launchers (`ipc/agents.ts`); tasks are reusable parameterised prompts stored under `<conception>/tasks/<slug>/` (`ipc/tasks.ts`). Per-task scheduling / log-routing lives in the `taskConfig` config key, keyed by slug.

| Verb | What it does |
|---|---|
| `listAgents()` | List the configured `agents` (`{id,label,command}` launchers) from the global `settings.json`. Empty when no conception or no agents. |
| `listTasks()` | List tasks under `<conception>/tasks/*`, each with its referenced agent, agent-presence flag, and parsed markers. Empty when no conception. |
| `readTask(slug)` | Read one task by slug (`name` / `agent` / `submit` / `prompt`). `null` when absent. |
| `writeTask(slug, def, previousSlug?)` | Create / update a task directory (`task.json` + `prompt.md`). When `previousSlug` differs from `slug`, the old directory is removed (rename). Returns the resolved slug. |
| `deleteTask(slug)` | Delete a task directory by slug. |
| `getTaskConfig()` | Per-task config map keyed by slug (`{schedule?, timeout?, runMode?, excludeFromLogs?, gateOnUpdatedTabs?}`) from the effective config. Empty when no conception. |
| `setTaskConfig(slug, entry)` | Persist one task's config entry into the conception's `taskConfig`. An entry with no scheduling / routing fields is removed. |
| `onTaskRuns(cb)` | Subscribe to the live headless task-run roster, pushed on each run start / exit so the Tasks pane's **Running** section updates without polling. Initial state seeded by `listRunningTaskRuns()`. Returns an unsubscribe function. |

## Dashboard (live tab summaries)

The opt-in dashboard engine (`ipc/dashboard.ts`) periodically summarizes the open terminal tabs by POSTing to an OpenAI-compatible endpoint. State pushes over the `dashboard-tab-summaries` / `dashboard-state` channels; secrets never cross the boundary (the config view carries only `hasApiKey`).

| Verb | What it does |
|---|---|
| `dashboardGetState()` | Latest dashboard snapshot (per-tab cards + rolling history), or `null` when the engine hasn't produced one yet. Read on Dashboard-pane mount so it shows the last state without waiting for the next cycle. |
| `dashboardGetConfigView()` | Resolved dashboard config **minus** the secret `apiKey` (plus a `hasApiKey` boolean). Drives the pane's off / no-key / waiting empty states. |
| `dashboardTestConnection(settings)` | Run a one-shot completion against the given (unsaved-draft) settings to verify the key / base URL / card model. Resolves `{ ok, error? }`; never rejects. |
| `dashboardRefreshTab(sid)` | Force an immediate re-summarization of one tab card (the per-card **Update** button), bypassing the interval and activity gate. No-ops when the engine is off / unkeyed / mid-cycle or `sid` isn't a live tab. |
| `onDashboardState(cb)` | Subscribe to full dashboard-state snapshots pushed after each engine cycle. Returns an unsubscribe function. |
| `onDashboardTabSummaries(cb)` | Subscribe to the per-tab summaries pushed each cycle (tab titles + hover popovers). Returns an unsubscribe function. |

## Tree mutations (Knowledge / Resources / Skills panes)

The three tree panes (Knowledge / Resources / Skills) expose create-file / create-dir / import-file verbs so the user can add content without leaving the dashboard. Each verb names the target tree explicitly so the main process can bound the write against the correct root (knowledge is hardcoded to `knowledge/`; resources and skills resolve from the conception's config).

| Verb | What it does |
|---|---|
| `createProjectNote(projectPath, slug)` | Create `<projectPath>/notes/NN-<slug>.md`. Scans `notes/` for the highest existing `NN-` prefix, increments by one, sanitises the slug, writes an empty file, returns the absolute path. Used by the "+ Note" button on every project card. |
| `createProjectFile(projectPath, dirRelPath, name)` | Create an empty file named `name` inside `<projectDir>/<dirRelPath>/` (`''` = the project root; `projectPath` is the README path or the project directory). The project dir must resolve under the conception's `projects/` tree and the target's parent must exist and resolve back under the project dir (both realpath-bounded at the handler). Names are kept verbatim but rejected when empty, containing path separators, or starting with a dot; an existing target is refused (`wx`). Returns the new file's absolute posix path. Backs the preview file tree's inline "new file" input. |
| `createProjectDir(projectPath, dirRelPath, name)` | Like `createProjectFile` but creates an empty directory (non-recursive `mkdir`, so an existing target — symlinks included — is refused). Backs the file tree's inline "new folder" input. |
| `treeCreateMd(root, dirRelPath, filename, skillTab?)` | Create an empty `.md` file under `<root>/<dirRelPath>/<filename>`. `root` is `'knowledge' \| 'resources' \| 'skills'`; `skillTab` selects which Skills sub-root (`generic` / `claude` / `kimi`) for the Skills pane. Filename must end in `.md` and pass slug-safety checks. |
| `treeMkdir(root, dirRelPath, name, skillTab?)` | Create an empty directory at `<root>/<dirRelPath>/<name>`. Same path-bounding rules as `treeCreateMd`. |
| `treeImportFile(root, dirRelPath, skillTab?)` | Open an OS file picker, then copy the chosen file into `<root>/<dirRelPath>/`. Used to drop PDFs / images into the Resources pane without leaving the dashboard. |

## Conception path + first launch

| Verb | What it does |
|---|---|
| `pickConceptionPath()` | Open a native folder picker, write the choice to `settings.json:lastConceptionPath`. Returns the picked path or `null` on cancel. |
| `getConceptionPath()` | Return the saved path (`null` if unset). |
| `getConceptionConfigPath()` | Absolute path to the active conception's per-tree config file (`.condash/settings.json`; falls back to legacy `condash.json` / `configuration.json` when one of those is the source of truth). Used by the Settings modal's "Open externally" button on the **This conception** tab. |
| `openConception(path)` | Switch the active conception to `path`. Validates that the folder exists and has a recognisable shape, writes `path` to `settings.json:lastConceptionPath`, promotes it to the head of `recentConceptionPaths`, and reloads every tree. |
| `getRecentConceptionPaths()` | Read the recents list (newest first, capped at 5). Drives the **File → Open Recent** submenu and the Settings modal's recents section. |
| `clearRecentConceptionPaths()` | Empty the recents list. Used by the Settings modal's "Clear all" button. |
| `removeRecentConceptionPath(path)` | Drop one entry from the recents list. Used by the per-row remove button in the Settings modal. |
| `detectConceptionState(path)` | Probe a candidate folder — does it already have `projects/` and a configuration file (`.condash/settings.json`, `condash.json`, or `configuration.json`)? Used by the first-launch flow before deciding whether to offer initialisation. |
| `initConception(path)` | Lay the bundled `conception-template/` tree into `path`. Existing files are preserved. Returns `{ created: string[] }`. |
| `getSettingsPath()` | Absolute path to `~/.config/condash/settings.json` (or platform equivalent), for the Settings modal's "Open externally" button on the **Global** tab. |

## UI plumbing

| Verb | What it does |
|---|---|
| `getTheme()` / `setTheme(theme)` | Persist `'system'` or a preset id — `'light'` \| `'dark'` \| `'console'` — in `settings.json`. The accepted set is `THEME_VALUES` in `src/shared/themes.ts`; adding a preset there widens this verb. |
| `getLayout()` / `setLayout(layout)` | Read or write the composite-layout snapshot (`projects: bool`, `working: 'code' \| 'knowledge' \| 'resources' \| 'skills' \| 'logs' \| null`, `terminal: bool`, `projectsSplit: number`). See [Config — LayoutState](config.md#layoutstate). |
| `getWelcomeDismissed()` / `setWelcomeDismissed(value)` | Persistent first-launch welcome-screen flag (`welcome.dismissed` in `settings.json`). |
| `getCardMinWidth()` / `setCardMinWidth(prefs)` | Read or write the per-pane card-grid min-width block (`projects`, `code`, `knowledge`, `resources`, `skills`, `logs`, `tasks`, `deliverables`). See [Config — CardMinWidth](config.md#cardminwidth). |
| `getTreeExpansion()` / `setTreeExpansion(prefs)` | Read or write the per-pane set of expanded directory `relPath`s (Knowledge / Resources / Skills tabs). Empty values mean every directory is collapsed — the on-purpose first-load state. |
| `getSelectedBranches()` / `setSelectedBranches(list)` | Read or write the Code-pane top-of-pane branch filter selection. Honoured only when `branchFilterStickyAll` is false. |
| `getBranchFilterStickyAll()` / `setBranchFilterStickyAll(value)` | Read or write the "All (sticky)" mode flag for the Code-pane branch filter — when true, every branch is shown and new branches auto-pin. |
| `getSkillsActiveScope()` / `setSkillsActiveScope(scope)` | Read or write the active scope in the Skills pane (`local` / `global`). Persisted per-machine; defaults to `local`. |
| `getGlobalSettingsRaw()` | Return the raw JSON text of the global `settings.json` (or `''` if the file does not exist). Used by the Settings modal to seed its in-memory editor without parsing through the Zod schema. |
| `writeGlobalSettings(expectedContent, newContent)` | Atomic rewrite of the global `settings.json` with a full-content drift check, mirroring `writeNote`. Returns the bytes actually written (after Zod canonicalisation). |
| `getAppInfo()` | About-modal payload: `{ name, version, electron, chrome, node, platform }`. `platform` is the Node string (`linux`/`darwin`/`win32`). |
| `readHelpDoc(name)` | Read a bundled help doc from the asar. Allowed names: `welcome`, `quick-start`, `shortcuts`, `configuration`, `cli`, `why-markdown`. Anything else rejects. |
| `quitApp()` | Trigger app quit. Renderer is responsible for any user confirmation; main runs `killAll` against live ptys before window close. |
| `onMenuCommand(cb)` | Receive commands from the OS menu (File / View / Help). See [MenuCommand values](#menucommand-values). |
| `onMenuOpenRecent(cb)` | Receive **File → Open Recent → \<path\>** dispatch events. The renderer reacts by calling `openConception(path)`. |
| `onMenuClearRecents(cb)` | Receive **File → Open Recent → Clear** dispatch events. The renderer reacts by calling `clearRecentConceptionPaths()`. |

## Push events

The main process pushes to the renderer over several one-way channels, **all** delivered through the shared `safeSend` guard (`src/main/safe-send.ts`), which drops a payload whose target frame is gone and reports whether it landed. The PTY (`onTermData` / `onTermExit` / `onTermSessions`) and dashboard (`onDashboardState` / `onDashboardTabSummaries`) channels are documented in their own sections above; the file-watcher and status channels follow. A single chokidar watcher rooted at `<conception>/`, debounced 250 ms, drives `onTreeEvents` and `onRepoEvents`.

### `onTreeEvents(cb)`

Per-path tree events for projects + knowledge + resources + skills + logs + configuration. Classification:

- `project` — `projects/<month>/<slug>/README.md` add/change/unlink. Renderer patches the project list in place via `getProject`.
- `knowledge` — any `.md` under `knowledge/`. Coarse — renderer bumps `refreshKey`.
- `resources` — any file under `<conception>/resources/`. Coarse.
- `skills` — any file under `<conception>/.agents/skills/`, the agedum source tree the Skills pane reads. Coarse.
- `logs` — any session file under `.condash/logs/`. Drives the Logs pane's live refresh.
- `config` — `.condash/settings.json` (canonical), `condash.json` (legacy), or `configuration.json` (legacy²) at the conception root. Same coarse handling.
- `unknown` — any classification failure. Forces a full re-render.

A burst of `unknown` events collapses to one event before the renderer is notified.

### `onRepoEvents(cb)`

Per-repo events emitted when a repo's working tree or `.git/{index,HEAD,refs/heads}` changes. The renderer uses these to patch a single `RepoEntry.dirty` (or a worktree's dirty count) in place — no list refetch, no Suspense remount, dropdowns stay open. Event kinds:

- `repo-dirty` — working tree changed; new dirty count attached.
- `repo-upstream` — remote-tracking branch changed.
- `repo-worktrees-changed` — `.git/worktrees/` directory changed; renderer pulls a fresh `RepoEntry` via `listReposForPrimary`.

### `onWatcherStatus(cb)`

File-watcher status notices on the `watcher-status` channel — a chokidar `error` (inotify exhaustion, EMFILE/ENOSPC) that would otherwise leave coverage partial and stderr-only. Each message is `{ message, kind: 'error' | 'info' }`; the renderer surfaces it as an actionable toast. Emitted by `src/main/watcher-status.ts`; the same event triggers one guarded re-arm of the watcher set.

## MenuCommand values

The full `MenuCommand` union dispatched by `onMenuCommand`:

```
search                 toggle-projects        about
open-folder            toggle-terminal        help-welcome
open-conception        show-code              help-quick-start
open-settings          show-knowledge         help-shortcuts
new-project            show-resources         help-configuration
request-quit           show-skills            help-cli
                       show-logs              help-why-markdown
                       show-dashboard
                       hide-working
                       refresh
```

Every entry maps one-to-one to a menu item — see [Keyboard shortcuts — Application menu](shortcuts.md#application-menu) for the user-facing list.

## What is intentionally **not** here

- **No HTTP fallback.** No clipboard endpoint, no asset routes, no embedded server. Copy writes the clipboard through the browser's native [`navigator.clipboard`](https://developer.mozilla.org/docs/Web/API/Clipboard_API) API; paste reads it through the `clipboardReadText` IPC (main-process Electron `clipboard`), since `navigator.clipboard.readText()` is permission-gated in the renderer.
- **No vendored CDN bundles.** Electron ships Chromium directly; assets are bundled into the asar at package time.
- **No auth layer.** condash is single-user, local-only.
- **No `step set`-style verbs.** Step markers cycle only through `toggleStep`; there is no "set marker to X" verb. Use the cycle.

## See also

- [`src/shared/api.ts`](https://github.com/vcoeur/condash/blob/main/src/shared/api.ts) — the IPC contract, source of truth.
- [`src/main/mutate.ts`](https://github.com/vcoeur/condash/blob/main/src/main/mutate.ts) — drift checks + atomic write + per-file queue, all in one file.
- [`src/main/terminals.ts`](https://github.com/vcoeur/condash/blob/main/src/main/terminals.ts) — pty lifecycle + the kill pipeline.
- [`src/main/git-status-cache.ts`](https://github.com/vcoeur/condash/blob/main/src/main/git-status-cache.ts) — the TTL cache.
- [`src/main/watcher.ts`](https://github.com/vcoeur/condash/blob/main/src/main/watcher.ts) — chokidar wiring + event classification.
- [`src/main/repo-watchers.ts`](https://github.com/vcoeur/condash/blob/main/src/main/repo-watchers.ts) — per-repo watcher set + `onRepoEvents` plumbing.
