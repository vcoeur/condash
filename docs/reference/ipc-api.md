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
| `search(query)` | `SearchResults` | Full-text search across every project + knowledge file. Re-walks the tree each call (no index — see [Internals](../explanation/internals.md#why-no-search-index)). |

## Mutations

Every mutation carries the **expected** state of the region it's about to change. The main process refuses to write if disk has drifted from the expectation. The renderer surfaces a "reload before saving" toast on conflict.

| Verb | Drift check |
|---|---|
| `toggleStep(path, lineIndex, expectedMarker, newMarker)` | Compare line's existing marker (`[ ]`, `[~]`, `[x]`, `[-]`) to `expectedMarker`. |
| `editStepText(path, lineIndex, expectedText, newText)` | Compare line's existing text to `expectedText`. |
| `addStep(path, text)` | Append-only — no drift check. |
| `setStatus(path, newStatus, opts?)` | Verify the metadata block contains a `**Status**:` line. On done-edges (close: prev → done, reopen: done → prev) also append a `Closed.` / `Reopened.` line to `## Timeline`. Returns `TransitionResult` with `timelineAppended` non-null exactly when a timeline line was written. |
| `createProject(input)` | Allocate `projects/<YYYY-MM>/<YYYY-MM-DD>-<slug>/` from the canonical kind template. Returns `{ slug, readmePath }`. |
| `createProjectNote(projectPath, slug)` | Create `<projectPath>/notes/NN-<slug>.md`. Scans `notes/` for the highest existing `NN-` prefix, increments by one, sanitises the slug, writes an empty file, returns the absolute path. |
| `writeNote(path, expectedContent, newContent)` | Full-file content compare. For `configuration.json`, the main process canonicalises the JSON through the Zod schema before writing — the bytes that hit disk can differ from `newContent`. Returns the bytes actually written so the caller can keep its CAS baseline aligned with disk. |
| `readNote(path)` | Read a single file's contents. Path must resolve under the conception. |

Step markers are `[ ]` (open), `[~]` (in-progress), `[x]` (done), `[-]` (abandoned). The dashboard cycle order is `open → progress → done → abandoned → open` (see [`src/renderer/panes/projects.tsx`](https://github.com/vcoeur/condash/blob/main/src/renderer/panes/projects.tsx)).

All writes are `tmp` → `fsync` → `rename`. The per-file write queue (`mutate.ts:withFileQueue`) serialises concurrent writes to the same path.

## Repos + runners

| Verb | What it does |
|---|---|
| `listRepos()` | Read `configuration.json` repositories, scan each for a `.git/`, attach cached dirty count and worktrees. |
| `listReposForPrimary(name)` | Per-primary partial reload — returns the primary's `RepoEntry` plus its submodule children freshly re-read. Driven by the structural FS-watcher event `repo-worktrees-changed`. |
| `invalidateGitStatus()` | Drop the 3 s TTL git-status cache (used by the Refresh button). |
| `getDirtyDetails(path, opts?)` | Detailed `git status -s` + `git diff --stat HEAD` for a worktree path. Powers the click-to-inspect popover on the per-branch `N dirty` badge. Returns `null` when the path is missing or not a git repo. |
| `forceStopRepo(repoName)` | Run the repo's `force_stop:` shell command — escape hatch for a port held by a non-condash process. |
| `listOpenWith()` | Return `open_with` slots from `<conception>/configuration.json`. (Slots are tree-wide; settings.json is not consulted.) |
| `launchOpenWith(slot, path)` | Spawn the configured editor against `path`. |
| `openInEditor(path)` | Resolve the user's preferred editor and open the file. |
| `openConceptionDirectory()` | Reveal the conception root in the OS file manager. |
| `openExternal(target)` | Open `target` with the OS default handler. Accepted schemes: `http:`, `https:`, `mailto:`. Other schemes (including `file:`) reject — call `openPath` for filesystem paths. |
| `openPath(target)` | Open a local filesystem path with the OS default handler. Used by the Settings modal's "Open externally" buttons for `configuration.json` and `settings.json`. Caller passes an absolute path. |
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

## Conception path + first launch

| Verb | What it does |
|---|---|
| `pickConceptionPath()` | Open a native folder picker, write the choice to `settings.json:conceptionPath`. Returns the picked path or `null` on cancel. |
| `getConceptionPath()` | Return the saved path (`null` if unset). |
| `detectConceptionState(path)` | Probe a candidate folder — does it already have `projects/` and `configuration.json`? Used by the first-launch flow before deciding whether to offer initialisation. |
| `initConception(path)` | Lay the bundled `conception-template/` tree into `path`. Existing files are preserved. Returns `{ created: string[] }`. |
| `getSettingsPath()` | Absolute path to `~/.config/condash/settings.json` (or platform equivalent), for the Settings modal's "Open externally" button. |

## UI plumbing

| Verb | What it does |
|---|---|
| `getTheme()` / `setTheme(theme)` | Persist `'light' \| 'dark' \| 'system'` in `settings.json`. |
| `getLayout()` / `setLayout(layout)` | Read or write the composite-layout snapshot (`projects: bool`, `working: 'code' \| 'knowledge' \| null`, `terminal: bool`, `projectsWidth: int`). See [Config — LayoutState](config.md#layoutstate). |
| `getWelcomeDismissed()` / `setWelcomeDismissed(value)` | Persistent first-launch welcome-screen flag (`welcome.dismissed` in `settings.json`). |
| `getAppInfo()` | About-modal payload: `{ name, version, electron, chrome, node, platform }`. `platform` is the Node string (`linux`/`darwin`/`win32`). |
| `helpReadDoc(name)` | Read a bundled help doc from the asar. Allowed names: `welcome`, `quick-start`, `shortcuts`, `configuration`, `cli`, `why-markdown`. Anything else rejects. |
| `quitApp()` | Trigger app quit. Renderer is responsible for any user confirmation; main runs `killAll` against live ptys before window close. |
| `onMenuCommand(cb)` | Receive commands from the OS menu (File / View / Help). See [MenuCommand values](#menucommand-values). |

## Push events

A single chokidar watcher rooted at `<conception>/`, debounced 250 ms, pushes events through three channels.

### `onTreeEvents(cb)`

Per-path tree events for projects + knowledge + configuration. Classification:

- `project` — `projects/<month>/<slug>/README.md` add/change/unlink. Renderer patches the project list in place via `getProject`.
- `knowledge` — any `.md` under `knowledge/`. Coarse — renderer bumps `refreshKey`.
- `config` — `configuration.json` at the conception root. Same coarse handling.
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
request-quit           hide-working           help-configuration
                       refresh                help-cli
                                              help-why-markdown
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
