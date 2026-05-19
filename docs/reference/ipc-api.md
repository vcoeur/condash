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

## Tree reads

| Verb | Returns | What it does |
|---|---|---|
| `listProjects()` | `Project[]` | Walk `projects/<month>/<slug>/README.md`, parse the metadata block, return the full project list. |
| `getProject(path)` | `Project \| null` | Re-parse a single README — used to patch the in-memory list after a watcher event. |
| `listProjectFiles(path)` | `ProjectFileEntry[]` | List files under a project directory (notes plus any other subdirectories). |
| `readKnowledgeTree()` | `KnowledgeNode \| null` | Walk `knowledge/`, return the directory + file structure (or `null` if no `knowledge/` exists). |
| `readResourcesTree()` | `ResourceNode \| null` | Walk the configured `resources_path` (default `resources/`), return the file tree with per-file MIME / category metadata. `null` if the directory doesn't exist. |
| `readSkillsTree()` | `SkillNode \| null` | Walk the configured `skills_path` (default `.claude/skills/`), return markdown files only with title / summary parsed from the head, plus optional `shipped` / `diverged` chips driven by `.condash-skills.json`. `null` if the directory doesn't exist. |
| `search(query)` | `SearchResults` | Full-text search across every project + knowledge file. Re-walks the tree each call (no index — see [Internals](../explanation/internals.md#why-no-search-index)). |

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
| `listOpenWith()` | Return `open_with` slots from `<conception>/.condash/settings.json` (with legacy `condash.json` / `configuration.json` as read fallbacks). Slots resolve through the conception ⊕ global precedence; the global `settings.json` provides defaults. |
| `launchOpenWith(slot, path)` | Spawn the configured editor against `path`. |
| `openInEditor(path)` | Resolve the user's preferred editor and open the file. |
| `openConceptionDirectory()` | Reveal the conception root in the OS file manager. |
| `openExternal(target)` | Open `target` with the OS default handler. Accepted schemes: `http:`, `https:`, `mailto:`. Other schemes (including `file:`) reject — call `openPath` for filesystem paths. |
| `openPath(target)` | Open a local filesystem path with the OS default handler. Used by the Settings modal's "Open externally" buttons for `.condash/settings.json` and the global `settings.json`. Caller passes an absolute path. |
| `pdfToFileUrl(path)` | Build a `file://` URL for a local PDF (handles Windows drive letters and percent-encoding). Returns the URL plus the basename so the renderer can render it without doing its own POSIX-only path split. |

## PTY sessions

The terminal pane spawns and drives node-pty sessions. Lifecycle: `termSpawn` → stream `onTermData` events → `termWrite` for stdin → `termClose` on user exit. Window close runs the kill pipeline against every live session.

| Verb | What it does |
|---|---|
| `termSpawn(request)` | Allocate a pty (setsid → own process group), return session id and resolved cwd. |
| `termWrite(id, data)` | Forward stdin bytes. |
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

## Terminal log surfaces

Per-session terminal capture (when `terminal.logging.enabled` is true) lands at `<conception>/.condash/logs/YYYY/MM/DD/HHMMSS-<sid>.txt`. The Logs working surface reads the directory tree through this set of verbs; deletions go through the same paths the in-app janitor uses, with `requirePathUnder` bounding every input against the conception's logs root.

| Verb | What it does |
|---|---|
| `logsListDays()` | List day directories under `.condash/logs/` newest first. Returns `Array<{ day: 'YYYY-MM-DD', sessionCount: number, totalBytes: number }>`. |
| `logsListSessions(day)` | List session files within a given day. Returns `TermLogSessionMeta[]` — see [`src/shared/types.ts:TermLogSessionMeta`](https://github.com/vcoeur/condash/blob/main/src/shared/types.ts). Parses the `# condash: {...}` header (+ footer when present) on each file. |
| `logsReadSession(filePath)` | Read one session file. Returns `TermLogSessionRead` — `{ text, meta }` with metadata header / footer stripped from the body. |
| `logsDeleteDay(day)` | Delete an entire day directory. Returns the number of session files removed. |
| `logsDeleteSession(filePath)` | Delete one session file. Refuses paths outside `.condash/logs/`. |

## Tree mutations (Knowledge / Resources / Skills panes)

The three tree panes (Knowledge / Resources / Skills) expose create-file / create-dir / import-file verbs so the user can add content without leaving the dashboard. Each verb names the target tree explicitly so the main process can bound the write against the correct root (knowledge is hardcoded to `knowledge/`; resources and skills resolve from the conception's config).

| Verb | What it does |
|---|---|
| `createProjectNote(projectPath, slug)` | Create `<projectPath>/notes/NN-<slug>.md`. Scans `notes/` for the highest existing `NN-` prefix, increments by one, sanitises the slug, writes an empty file, returns the absolute path. Used by the "+ Note" button on every project card. |
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
| `getTheme()` / `setTheme(theme)` | Persist `'light' \| 'dark' \| 'system'` in `settings.json`. |
| `getLayout()` / `setLayout(layout)` | Read or write the composite-layout snapshot (`projects: bool`, `working: 'code' \| 'knowledge' \| 'resources' \| 'skills' \| 'logs' \| null`, `terminal: bool`, `projectsWidth: int`). See [Config — LayoutState](config.md#layoutstate). |
| `getWelcomeDismissed()` / `setWelcomeDismissed(value)` | Persistent first-launch welcome-screen flag (`welcome.dismissed` in `settings.json`). |
| `getCardMinWidth()` / `setCardMinWidth(prefs)` | Read or write the per-pane card-grid min-width block (`projects`, `code`, `knowledge`, `resources`, `skills`). See [Config — CardMinWidth](config.md#cardminwidth). |
| `getTreeExpansion()` / `setTreeExpansion(prefs)` | Read or write the per-pane set of expanded directory `relPath`s (Knowledge / Resources / Skills tabs). Empty values mean every directory is collapsed — the on-purpose first-load state. |
| `getSelectedBranches()` / `setSelectedBranches(list)` | Read or write the Code-pane top-of-pane branch filter selection. Honoured only when `branchFilterStickyAll` is false. |
| `getBranchFilterStickyAll()` / `setBranchFilterStickyAll(value)` | Read or write the "All (sticky)" mode flag for the Code-pane branch filter — when true, every branch is shown and new branches auto-pin. |
| `getSkillsActiveTab()` / `setSkillsActiveTab(tab)` | Read or write the active tab in the Skills pane (`generic` / `claude` / `kimi`). Persisted per-machine. |
| `getGlobalSettingsRaw()` | Return the raw JSON text of the global `settings.json` (or `''` if the file does not exist). Used by the Settings modal to seed its in-memory editor without parsing through the Zod schema. |
| `writeGlobalSettings(expectedContent, newContent)` | Atomic rewrite of the global `settings.json` with a full-content drift check, mirroring `writeNote`. Returns the bytes actually written (after Zod canonicalisation). |
| `getAppInfo()` | About-modal payload: `{ name, version, electron, chrome, node, platform }`. `platform` is the Node string (`linux`/`darwin`/`win32`). |
| `readHelpDoc(name)` | Read a bundled help doc from the asar. Allowed names: `welcome`, `quick-start`, `shortcuts`, `configuration`, `cli`, `why-markdown`. Anything else rejects. |
| `quitApp()` | Trigger app quit. Renderer is responsible for any user confirmation; main runs `killAll` against live ptys before window close. |
| `onMenuCommand(cb)` | Receive commands from the OS menu (File / View / Help). See [MenuCommand values](#menucommand-values). |
| `onMenuOpenRecent(cb)` | Receive **File → Open Recent → \<path\>** dispatch events. The renderer reacts by calling `openConception(path)`. |
| `onMenuClearRecents(cb)` | Receive **File → Open Recent → Clear** dispatch events. The renderer reacts by calling `clearRecentConceptionPaths()`. |

## Push events

A single chokidar watcher rooted at `<conception>/`, debounced 250 ms, pushes events through three channels.

### `onTreeEvents(cb)`

Per-path tree events for projects + knowledge + resources + skills + logs + configuration. Classification:

- `project` — `projects/<month>/<slug>/README.md` add/change/unlink. Renderer patches the project list in place via `getProject`.
- `knowledge` — any `.md` under `knowledge/`. Coarse — renderer bumps `refreshKey`.
- `resources` — any file under the configured `resources_path`. Coarse.
- `skills` — any file under the configured `skills_path` (or the sibling `.agents/skills/` and `.kimi/skills/` roots backing the Generic / Kimi tabs). Coarse.
- `logs` — any session file under `.condash/logs/`. Drives the Logs pane's live refresh.
- `config` — `.condash/settings.json` (canonical), `condash.json` (legacy), or `configuration.json` (legacy²) at the conception root. Same coarse handling.
- `unknown` — any classification failure. Forces a full re-render.

A burst of `unknown` events collapses to one event before the renderer is notified.

### `onRepoEvents(cb)`

Per-repo events emitted when a repo's working tree or `.git/{index,HEAD,refs/heads}` changes. The renderer uses these to patch a single `RepoEntry.dirty` (or a worktree's dirty count) in place — no list refetch, no Suspense remount, dropdowns stay open. Event kinds:

- `repo-dirty` — working tree changed; new dirty count attached.
- `repo-upstream` — remote-tracking branch changed.
- `repo-worktrees-changed` — `.git/worktrees/` directory changed; renderer pulls a fresh `RepoEntry` via `listReposForPrimary`.

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
                       hide-working
                       refresh
```

Every entry maps one-to-one to a menu item — see [Keyboard shortcuts — Application menu](shortcuts.md#application-menu) for the user-facing list.

## What is intentionally **not** here

- **No HTTP fallback.** No clipboard endpoint, no asset routes, no embedded server. The renderer reads the system clipboard through the browser's native [`navigator.clipboard`](https://developer.mozilla.org/docs/Web/API/Clipboard_API) API.
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
