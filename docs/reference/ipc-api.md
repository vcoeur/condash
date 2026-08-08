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
| `readSkillsTree(scope)` | `SkillNode \| null` | Walk one skills scope. `SkillScope` is `'conception' \| 'user'`: `conception` reads `<conception>/AGENTS.md` + `<conception>/.agents/skills/`; `user` reads `~/.config/agents/AGENTS.md` + `~/.config/agents/skills/`. Both are [agedum](skill.md#the-harness-launcher-agedum) **sources** — condash never reads a per-harness compiled output (`~/.claude/`, `~/.kimi/`, `~/.config/opencode/`). Markdown only, with title / summary parsed from the head and optional `shipped` / `diverged` chips (shipped SHAs come from `.condash-skills.json` when present). `null` when neither the skills directory nor the `AGENTS.md` exists. |
| `readSkillFile(path)` | `string` | Read-only content fetch for a Skills-pane file. Like `readNote` but also permits the user-scope skill locations (the global scope lives outside the conception); rejects anything else. |
| `search(query, scopes?)` | `SearchResults` | Full-text search across projects, knowledge, resources, skills, and logs. Markdown sources are served from an in-memory index; logs are scanned on disk, and only when in scope (see [Internals — The search index](../explanation/internals.md#search-index)). |

## Mutations

Every mutation carries the **expected** state of the region it's about to change. The main process refuses to write if disk has drifted from the expectation, and the error carries the `WRITE_DRIFT_MARKER` substring (`src/shared/ipc-channels.ts`) so a caller can tell that failure apart from a schema rejection. Most callers surface it as a "reload before saving" toast.

The Settings modal does not: it holds its baseline for as long as it is open, so any other write to the same file — its own Performance-recording toggle, a `condash config set`, a second window, a hand edit — would otherwise reject the user's whole staged batch. On drift it re-reads the file, three-way merges the staged draft onto the new content (a subtree only one side moved takes that side; a genuine leaf conflict keeps the staged value, since that is what the modal is showing), and retries once against the fresh baseline.

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

Step markers are `[ ]` (open), `[~]` (in-progress), `[x]` (done), `[-]` (abandoned), `[!]` (blocked). The dashboard cycle order through the toggle button is `open → progress → done → abandoned → open` (`CLICK_CYCLE` in [`src/renderer/panes/projects-parts/data.ts`](https://github.com/vcoeur/condash/blob/main/src/renderer/panes/projects-parts/data.ts), re-exported through `projects.tsx`); `[!]` is reachable by editing the README directly and round-trips through every layer (parser, counter, writer, renderer badge).

All writes are `tmp` → `fsync` → `rename`. The per-file write queue (`mutate-shared.ts:withFileQueue`) serialises concurrent writes to the same path.

## Repos + runners

| Verb | What it does |
|---|---|
| `listRepos()` | Read the conception's `repositories` (from `.condash/settings.json`, or legacy `condash.json` / `configuration.json`), scan each for a `.git/`, attach cached dirty count and worktrees. |
| `listReposForPrimary(name)` | Per-primary partial reload — returns the primary's `RepoEntry` plus its submodule children freshly re-read. Driven by the structural FS-watcher event `repo-worktrees-changed`. |
| `invalidateGitStatus()` | Drop the 3 s TTL git-status cache (used by the Refresh button). |
| `getDirtyDetails(path, opts?)` | Detailed `git status -s` + `git diff --numstat HEAD` for a worktree path. Powers the click-to-inspect popover on the per-branch `N dirty` badge. Returns `null` when the path is missing or not a git repo. |
| `forceStopRepo(repoName)` | Run the repo's `force_stop:` command, argv-split and spawned directly (no shell) — escape hatch for a port held by a non-condash process. |
| `pullBranch(path)` | Fast-forward a worktree to its upstream (`git pull --ff-only`) — the per-branch **Pull branch** menu action. Refuses on a dirty tree and returns `updated` / `up-to-date` / `diverged` / `dirty` so the caller can toast the outcome; throws on an unexpected git failure (no upstream, network, not a repo). |
| `lookupPullRequest(path, branch)` | Resolve the open GitHub PR whose head is `branch` (`gh pr list --head`, run in the worktree at `path`) — backs the per-branch **Open PR** menu item. Returns the PR (`number` / `url` / `title` / `isDraft`) or `null` when there's no open PR or `gh` can't run (unauthenticated, no GitHub remote); never throws, so the menu simply omits the row. TTL-cached by `(path, branch)`. |
| `listOpenPullRequests(app)` | List every open GitHub PR (with its `headRefName`) for the repo the `apps:` token `app` resolves to — `gh pr list --state open`, one call per repo. Backs the **Projects-pane card badges**: the renderer indexes the results by head branch so each project card matches its own branch without a per-card call. `app` is resolved to the configured repo via the name / `#handle` / alias map (never a renderer-supplied path). Returns `[]` for an unknown app or a lookup that can't run. TTL-cached by repo path. |
| `listOpenWith()` | Return the `open_with` launch slots (a global-only key) from the effective config — `getEffectiveConceptionConfig`, the merged view of `settings.json`; no built-in defaults. |
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
| `termSpawn(request)` | Allocate a pty (setsid → own process group), return session id and resolved cwd. A `side: 'code'` spawn carrying a `repo` first stops every existing code-side session for that repo, so a repo never has two dev servers racing on one port. |
| `termRestart(id)` | Relaunch an **exited** session with its original command, cwd, and side, retiring the dead row. Returns the new `{ id, cwd }`. Rejects for an unknown id or a session that is still running. Backs the **Restart** action on an abnormally-exited tab. |
| `termWrite(id, data)` | Forward stdin bytes. |
| `clipboardReadText()` | Read the system clipboard via the main-process Electron `clipboard`. Backs the terminal's `Ctrl+V` handler — the renderer's `navigator.clipboard.readText()` is permission-gated and unreliable. |
| `termResize(id, cols, rows)` | `TIOCSWINSZ` on the pty. |
| `termGeometry(id)` | The pty's current winsize, or `null` for an unknown session. Main owns the pty, so this is the only authoritative geometry — the renderer writes size but is never told it. Read when hydrating a hidden tab so the snapshot is replayed at the size its frame was drawn for. |
| `termClose(id)` | Run the kill pipeline: `SIGTERM` → optional `force_stop` → 500ms wait → `SIGKILL` on the process group. |
| `termList()` | Snapshot of live (or recently-exited) sessions. Used by the panel rebuild on pane switch. |
| `termAttach(id)` | Pull the buffered output for an existing session, used on renderer mount to replay history into a freshly-created xterm. |
| `termSetSide(id, side)` | Re-side a session — used by the Code-pane pop-out button to surface a running dev server in the bottom "My terms" pane. `side` is `'my'` or `'code'`. |
| `termGetPrefs()` | Read `settings.json:terminal` (shell, shortcut, font, palette). |
| `termSetPrefs(prefs)` | Replace the persisted terminal prefs in `settings.json`. The patch is a full replacement; pass `{}` to clear back to defaults. |
| `termLatestScreenshot(dir)` | Return the most recently modified **file** at the top level of `dir` — any extension, no recursion, no image-type filter. `null` when the directory is missing or holds no files. Backs the [screenshot-paste shortcut](shortcuts.md#screenshot-paste-flow). |
| `onTermData(cb)` | Subscribe to stdout/stderr bytes — single channel, multiplexed by session id. |
| `onTermExit(cb)` | Subscribe to session-exit events. |
| `onTermSessions(cb)` | Sessions changed (spawn / exit / close). Receives the full snapshot. |
| `termTabsContext()` | The open, live tabs as `[{sid,cwd,repo,cmd}]` — the `{TABS}` provided-var payload (capability 2), used to seed a manual task run. A manual run seeds `{UPDATED_TABS}` from the same list (no per-run watermark to diff against). |
| `perfVitals()` | Read main-process performance vitals (recording state, write-failure latch, live event-loop delay, heap) without disturbing the recording window. Cheap enough for the Performance pane to poll. |
| `perfSetEnabled(enabled)` | Flip `terminal.perf.enabled`, re-open the recorder against the active conception, and return the resulting vitals. Merges over the current terminal prefs — `setTerminalPrefs` replaces the whole block. |
| `perfRendererReport(report)` | Ship one window of renderer counters (loop delay, frames, spans, counters, peaks) into the main-process perf record. Sent once per 2.5 s drain while recording and only when the window holds something — never per frame. The reply `{recording}` is authoritative: the renderer stops sampling on a `false`. |
| `onPerfState(cb)` | Subscribe to performance-recording state on the `perf-state` channel, pushed whenever main applies `terminal.perf.enabled`. This is what starts and stops the renderer's own counters, so recording flipped from the pane, the Settings modal, a hand-edited `settings.json`, or a conception switch reaches both halves of the instrument. |

> **Flow control (`termAck`).** `onTermData` payloads carry an `epoch` field, and for every payload the preload fires a fire-and-forget `ipcRenderer.invoke('termAck', id, byteLength, epoch)` back to main. This is a backpressure ack — main counts the acked bytes to decide when to pause / resume the pty — **not** part of the typed `CondashApi`; it lives below the interface as a preload-internal channel. The `epoch` guards against a stale ack (minted before a renderer re-navigation flow reset) debiting the fresh flow. It fails soft: a dropped ack can only stall the pty, never corrupt it.

## Auto-commit and status indicators

The opt-in [auto-commit engine](config.md#auto-commit) runs [`condash sync run`](cli.md#sync) on a timer while a conception is open (`ipc/auto-sync.ts`). Two further read-only verbs back the status-bar pills and deliberately stay **disjoint** from the engine — neither takes the sync lock, so polling them can never block a sweep.

| Verb | What it does |
|---|---|
| `autoSyncGetStatus()` | Latest engine status — phase, next-run ETA, last result. Read on mount of the **Settings → Auto-commit** section so it shows current state without waiting for the next push. |
| `autoSyncNow()` | Run one sweep now regardless of the cadence — the **Commit & push now** button and the status bar's **Sync now**. Resolves the resulting status; no-ops when the engine is unarmed or already mid-sweep. |
| `onAutoSyncStatus(cb)` | Subscribe to engine status pushed on every state change (channel `auto-sync-status`). Returns an unsubscribe function. |
| `syncStatusSnapshot()` | Read-only git snapshot of the conception checkout: uncommitted-file count, unpushed-commit count, and the recent commits (each flagged pushed / unpushed) behind the status bar's click-to-open list. Zeroed when no conception is active or git can't be read. |
| `skillsSyncStatus()` | Aggregate shipped-skills state for the status bar: whether condash-shipped skills are installed, and how many files are missing or outdated. Defaults to not-installed when no conception is active. |

## Terminal log surfaces

Per-session terminal capture (when `terminal.logging.enabled` is true) lands at `<conception>/.condash/logs/YYYY/MM/DD/HHMMSS-<sid>.txt`. The Logs working surface reads the directory tree through this set of verbs; deletions go through the same paths the in-app janitor uses, with `requirePathUnder` bounding every input against the conception's logs root.

| Verb | What it does |
|---|---|
| `logsListDays()` | List day directories under `.condash/logs/` newest first. Returns `Array<{ day: string; path: string; sessions: number }>` — `day` is `YYYY-MM-DD`, `path` the absolute directory, `sessions` the file count. Empty when no conception is active or nothing has been captured. |
| `logsListSessions(day)` | List session files within a given day. Returns `TermLogSessionMeta[]` — see [`src/shared/types/logs.ts:TermLogSessionMeta`](https://github.com/vcoeur/condash/blob/main/src/shared/types/logs.ts). Parses the `# condash: {...}` header (+ footer when present) on each file. |
| `logsReadSession(filePath)` | Read one session file. Returns `TermLogSessionRead` — `{ text, meta }` with metadata header / footer stripped from the body. |
| `logsDeleteDay(day)` | Delete an entire day directory. Returns `{ deleted: boolean }` — not a count. |
| `logsDeleteSession(filePath)` | Delete one session file. Returns `{ deleted: boolean }`. Refuses paths outside `.condash/logs/` and files that don't end in `.txt`. |
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

## Tree mutations (Knowledge / Resources panes)

The two **writable** tree panes — Knowledge and Resources — and the project preview's file tree expose create-file / create-dir / import verbs so the user can add content without leaving the dashboard. Each verb names its target explicitly so the main process can bound the write against the correct root: `knowledge` is hardcoded to `<conception>/knowledge/`, `resources` to `<conception>/resources/`, and the project create verbs against the item's own directory.

!!! warning "The Skills pane is read-only"

    `root === 'skills'` is **rejected** by all three `tree*` verbs (`Skills tree is read-only`). Post-reframe, [agedum](skill.md#the-harness-launcher-agedum) owns the skills source of truth and condash only surfaces it — see [`readSkillsTree`](#tree-reads). There is no `skillTab` parameter on any verb; earlier drafts of this page listed one, and it never shipped.

| Verb | What it does |
|---|---|
| `createProjectNote(projectPath, slug)` | Create `<projectPath>/notes/NN-<slug>.md`. Scans `notes/` for the highest existing `NN-` prefix, increments by one, sanitises the slug, writes an empty file, returns the absolute path. Used by the "+ Note" button on every project card. |
| `createProjectFile(projectPath, dirRelPath, name)` | Create an empty file named `name` inside `<projectDir>/<dirRelPath>/` (`''` = the project root; `projectPath` is the README path or the project directory). The project dir must realpath to an actual **item** directory — `projects/<YYYY-MM>/<YYYY-MM-DD-slug>/` — so the verb can neither scatter entries into the `projects/` root or a month bucket nor fabricate item dirs; the target's parent must exist and resolve back under the item dir (symlink-escape safe). Names keep their case after a trim but are rejected when empty, containing path separators, starting or ending with a dot, or matching a Windows reserved device name; an existing target is refused (`wx`). Returns the new file's absolute posix path. Backs the preview file tree's inline "new file" input. |
| `createProjectDir(projectPath, dirRelPath, name)` | Like `createProjectFile` but creates an empty directory (non-recursive `mkdir`, so an existing target — symlinks included — is refused). Backs the file tree's inline "new folder" input. |
| `treeCreateMd(root, dirRelPath, filename)` | Create an empty file under `<root>/<dirRelPath>/<filename>`, returning its absolute path. The stem is sanitised to lowercase-hyphen; knowledge always forces `.md`, resources keep a supplied extension and default to `.md`. Refuses to overwrite an existing file. |
| `treeMkdir(root, dirRelPath, name)` | Create a subdirectory at `<root>/<dirRelPath>/<name>`, returning its absolute path. `name` is sanitised the same way. Idempotent for a plain existing directory, but refuses when the target already exists **as a symlink** — `mkdir({recursive:true})` would otherwise create straight through it. |
| `treeImportFile(root, dirRelPath)` | Open an OS file picker, then copy the chosen file into `<root>/<dirRelPath>/`. Resolves to the destination's absolute path, or `null` when the user cancels. Refuses to overwrite. Used to drop PDFs / images into the Resources pane without leaving the dashboard. |

Every one of the three normalises `dirRelPath` and then re-checks the joined result is still under the pane's root via `requirePathUnder`, so a `..` segment or an absolute path from the renderer cannot escape the bound.

## Conception path + first launch

| Verb | What it does |
|---|---|
| `pickConceptionPath()` | Open a native folder picker, write the choice to `settings.json:lastConceptionPath`. Returns the picked path or `null` on cancel. |
| `getConceptionPath()` | Return the saved path (`null` if unset). |
| `getConceptionConfigPath()` | Absolute path to the active conception's per-tree config file (`.condash/settings.json`; falls back to legacy `condash.json` / `configuration.json` when one of those is the source of truth). Backs the Settings rail's **Open .condash/settings.json** button. |
| `openConception(path)` | Switch the active conception to `path`. Validates that the folder exists and has a recognisable shape, writes `path` to `settings.json:lastConceptionPath`, promotes it to the head of `recentConceptionPaths`, and reloads every tree. |
| `getRecentConceptionPaths()` | Read the recents list (newest first, capped at 5). Drives the **File → Open Recent** submenu and the Settings modal's recents section. |
| `clearRecentConceptionPaths()` | Empty the recents list. Used by the Settings modal's "Clear all" button. |
| `removeRecentConceptionPath(path)` | Drop one entry from the recents list. Used by the per-row remove button in the Settings modal. |
| `detectConceptionState(path)` | Probe a candidate folder — does it already have `projects/` and a configuration file (`.condash/settings.json`, `condash.json`, or `configuration.json`)? Used by the first-launch flow before deciding whether to offer initialisation. |
| `initConception(path)` | Lay the bundled `conception-template/` tree into `path`. Existing files are preserved. Returns `{ created: string[] }`. |
| `getSettingsPath()` | Absolute path to `~/.config/condash/settings.json` (or platform equivalent). Backs the Settings rail's **Open settings.json** button. |

## UI plumbing

| Verb | What it does |
|---|---|
| `getTheme()` / `setTheme(theme)` | Persist `'system'` or a preset id — `'light'` \| `'mist'` \| `'dark'` \| `'nocturne'` \| `'console'` — in `settings.json`. The accepted set is `THEME_VALUES` in `src/shared/themes.ts`; adding a preset there widens this verb. |
| `getLayout()` / `setLayout(layout)` | Read or write the composite-layout snapshot (`projects: bool`, `leftView: 'projects' \| 'tasks' \| 'deliverables' \| 'perf'`, `working: 'code' \| 'knowledge' \| 'resources' \| 'skills' \| 'logs' \| null`, `terminal: bool`, `projectsSplit: number`). See [Config — LayoutState](config.md#layoutstate). |
| `getWelcomeDismissed()` / `setWelcomeDismissed(value)` | Persistent first-launch welcome-screen flag (`welcome.dismissed` in `settings.json`). |
| `getCardMinWidth()` / `setCardMinWidth(prefs)` | Read or write the per-pane card-grid min-width block (`projects`, `code`, `knowledge`, `resources`, `skills`, `logs`, `tasks`, `deliverables`). See [Config — CardMinWidth](config.md#cardminwidth). |
| `getTreeExpansion()` / `setTreeExpansion(prefs)` | Read or write the per-pane set of expanded directory `relPath`s (`knowledge`, `resources`, `skills` for the conception scope, `skillsUser` for the Skills pane's user scope). Empty values mean every directory is collapsed — the on-purpose first-load state. |
| `getSelectedBranches()` / `setSelectedBranches(list)` | Read or write the Code-pane top-of-pane branch filter selection. Honoured only when `branchFilterStickyAll` is false. |
| `getBranchFilterStickyAll()` / `setBranchFilterStickyAll(value)` | Read or write the "All (sticky)" mode flag for the Code-pane branch filter — when true, every branch is shown and new branches auto-pin. |
| `getSkillsActiveScope()` / `setSkillsActiveScope(scope)` | Read or write the active scope in the Skills pane. `SkillScope` is `'conception'` \| `'user'`; persisted per-machine in `settings.json:skillsActiveScope` and defaults to `'conception'`. |
| `getGlobalSettingsRaw()` | Return the raw JSON text of the global `settings.json` (or `''` if the file does not exist — the Settings modal reads that as "fresh defaults" and creates the file on first save). Seeds the modal's draft and its CAS baseline without going through the Zod schema. Note this `get*` paired with `writeGlobalSettings` breaks the `read*`/`write*` pairing used for other file-backed resources; it is a known, contained inconsistency, and new file-backed channels should use `read*`/`write*`. |
| `writeGlobalSettings(expectedContent, newContent)` | Atomic rewrite of the global `settings.json` with a full-content drift check, mirroring `writeNote`. Returns the bytes actually written (after Zod canonicalisation). |
| `getAppInfo()` | About-modal payload: `{ name, version, electron, chrome, node, platform }`. `platform` is the Node string (`linux`/`darwin`/`win32`). |
| `readHelpDoc(name)` | Read a bundled help doc from the asar. Allowed names: `welcome`, `quick-start`, `shortcuts`, `configuration`, `cli`, `why-markdown`. Anything else rejects. |
| `quitApp()` | Trigger app quit. Renderer is responsible for any user confirmation; main runs `killAll` against live ptys before window close. |
| `onMenuCommand(cb)` | Receive commands from the OS menu (File / View / Help). See [MenuCommand values](#menucommand-values). |
| `onMenuOpenRecent(cb)` | Receive **File → Open Recent → \<path\>** dispatch events. The renderer reacts by calling `openConception(path)`. |
| `onMenuClearRecents(cb)` | Receive **File → Open Recent → Clear** dispatch events. The renderer reacts by calling `clearRecentConceptionPaths()`. |

## Push events

The main process pushes to the renderer over several one-way channels, **all** delivered through the shared `safeSend` guard (`src/main/safe-send.ts`), which drops a payload whose target frame is gone and reports whether it landed. Every channel name lives once, in `EVENT_CHANNELS` (`src/shared/ipc-channels.ts`), because a push channel has no typed anchor tying the `webContents.send` end to the `ipcRenderer.on` end.

The PTY (`onTermData` / `onTermExit` / `onTermSessions`), dashboard (`onDashboardState` / `onDashboardTabSummaries`), auto-sync (`onAutoSyncStatus`, channel `auto-sync-status`), task-run (`onTaskRuns`), and perf (`onPerfState`) channels are documented in their own sections above; the file-watcher and status channels follow. A single chokidar watcher rooted at `<conception>/`, debounced 250 ms, drives `onTreeEvents` and `onRepoEvents`.

That watcher covers `projects/`, `knowledge/`, the resources and skills roots, the three conception-config candidates, and the conception-level `AGENTS.md` / `CLAUDE.md`. It does **not** cover the per-machine `settings.json`, which lives outside the conception — a hand-edit there produces no event.

### `onTreeEvents(cb)`

Per-path tree events for projects + knowledge + resources + skills + logs + configuration. Classification:

- `project` — `projects/<month>/<slug>/README.md` add/change/unlink. Renderer patches the project list in place via `getProject`.
- `knowledge` — any `.md` under `knowledge/`. Coarse — renderer bumps `refreshKey`.
- `resources` — any file under `<conception>/resources/`. Coarse.
- `skills` — any file under `<conception>/.agents/skills/`, the [agedum](skill.md#the-harness-launcher-agedum) source tree the Skills pane reads. Coarse.
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
- **No auth layer.** condash is local-only, with no accounts or identity — collaboration goes through git.
- **No `step set`-style verbs.** Step markers cycle only through `toggleStep`; there is no "set marker to X" verb. Use the cycle.

## See also

- [`src/shared/api.ts`](https://github.com/vcoeur/condash/blob/main/src/shared/api.ts) — the IPC contract, source of truth.
- [`src/main/mutate.ts`](https://github.com/vcoeur/condash/blob/main/src/main/mutate.ts) — re-export barrel over the split mutation modules: `mutate-steps.ts` (checklist edits), `mutate-status.ts` (status + timeline), `write-config.ts` (note/config writes), `mutate-shared.ts` (EOL detection + per-file queue).
- [`src/main/terminals.ts`](https://github.com/vcoeur/condash/blob/main/src/main/terminals.ts) — pty lifecycle + the kill pipeline.
- [`src/main/git-status-cache.ts`](https://github.com/vcoeur/condash/blob/main/src/main/git-status-cache.ts) — the TTL cache.
- [`src/main/git-concurrency.ts`](https://github.com/vcoeur/condash/blob/main/src/main/git-concurrency.ts) — the read-only git-lookup cap.
- [`src/main/watcher.ts`](https://github.com/vcoeur/condash/blob/main/src/main/watcher.ts) — chokidar wiring + event classification.
- [`src/main/repo-watchers.ts`](https://github.com/vcoeur/condash/blob/main/src/main/repo-watchers.ts) — per-repo watcher set + `onRepoEvents` plumbing.
