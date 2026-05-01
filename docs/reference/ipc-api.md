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

## Tree reads

| Verb | Returns | What it does |
|---|---|---|
| `listProjects()` | `ProjectSummary[]` | Walk `projects/<month>/<slug>/README.md`, parse the metadata block. |
| `getProject(path)` | `ProjectDetail` | Re-parse a single README — used to patch the in-memory list after a watcher event. |
| `listProjectFiles(path)` | `string[]` | List files under a project's `notes/` directory. |
| `readKnowledgeTree()` | `KnowledgeTree` | Walk `knowledge/`, return the directory + file structure. |
| `search(query)` | `SearchHit[]` | Full-text search across every project + knowledge file. Re-walks the tree each call (no index — see [Internals](../explanation/internals.md#why-no-search-index)). |

## Mutations

Every mutation carries the **expected** state of the region it's about to change. The main process refuses to write if disk has drifted from the expectation. The renderer surfaces a "reload before saving" toast on conflict.

| Verb | Drift check |
|---|---|
| `toggleStep(path, lineIndex, expectedMarker, newMarker)` | Compare line's existing marker (`[ ]`, `[~]`, `[x]`, `[!]`, `[-]`) to `expectedMarker`. |
| `editStepText(path, lineIndex, expectedText, newText)` | Compare line's existing text to `expectedText`. |
| `addStep(path, text)` | Append-only — no drift check. |
| `setStatus(path, newStatus)` | Verify the metadata block contains a `**Status**:` line. |
| `writeNote(path, expectedContent, newContent)` | Full-file content compare. |

All writes are `tmp` → `fsync` → `rename`. The per-file write queue (`mutate.ts:withFileQueue`) serialises concurrent writes to the same path.

## Repos + runners

| Verb | What it does |
|---|---|
| `listRepos()` | Read `configuration.json` repositories, scan each for a `.git/`, attach cached dirty count. |
| `invalidateGitStatus()` | Drop the 3 s TTL git-status cache (used by the Refresh button). |
| `forceStopRepo(repoName)` | Run the repo's `force_stop:` shell command — escape hatch for a port held by a non-condash process. |
| `listOpenWith()` | Return per-machine `open_with` slots from `settings.json`. |
| `launchOpenWith(slot, path)` | Spawn the configured editor against `path`. |
| `openInEditor(path)` | Resolve the user's preferred editor and open the file. |
| `openConceptionDirectory()` | Reveal the conception root in the OS file manager. |
| `openExternal(target)` | Open `target` (an `https:` or `mailto:` URL) with the OS default handler. Used by the xterm web-links addon and any future external-link UI. Refuses unknown schemes — no shell injection surface. |

## Project notes

| Verb | What it does |
|---|---|
| `createProjectNote(projectPath, slug)` | Create `<projectPath>/notes/NN-<slug>.md`. The handler scans `notes/` for the highest existing `NN-` prefix, increments by one, sanitises the slug, and writes an empty file. Returns the absolute path of the new file so the caller can immediately open it in the note editor. |

## PTY sessions

The terminal pane spawns and drives node-pty sessions. Lifecycle: `term.spawn` → stream `term.data` events → `term.write` for stdin → `term.close` on user exit. Window close calls `killAll`, which fans the SIGTERM → `force_stop` → SIGKILL pipeline across every live session.

| Verb | What it does |
|---|---|
| `term.spawn(request)` | Allocate a pty (setsid → own process group), return session id. |
| `term.write(id, data)` | Forward stdin bytes. |
| `term.resize(id, cols, rows)` | TIOCSWINSZ on the pty. |
| `term.close(id)` | Run the kill pipeline: SIGTERM → optional `force_stop` → 500ms wait → SIGKILL on the process group. |
| `term.list()` | Enumerate live sessions for the panel rebuild on tab switch. |
| `term.attach(id)` | Re-bind a session to the renderer (e.g. after a tab switch). |
| `term.setSide(id, side)` | Move a session between the left / right / detached panes. |
| `term.getPrefs()` | Read `settings.json:terminal` (font, palette). |
| `term.latestScreenshot(dir)` | Find the newest `*.png` under `dir` (used by the screenshot helper). |
| `onTermData(cb)` | Subscribe to stdout/stderr bytes — single channel, multiplexed by session id. |
| `onTermExit(cb)` | Subscribe to session-exit events. |
| `onTermSessions(cb)` | Subscribe to session-list changes. |

## Conception path + first launch

| Verb | What it does |
|---|---|
| `pickConceptionPath()` | Open a native folder picker, write the choice to `settings.json:conception_path`. |
| `getConceptionPath()` | Return the saved path (empty string if unset). |
| `detectConceptionState(path)` | Inspect a candidate folder — does it already look like a conception tree? Used by the first-launch flow. |
| `initConception(path)` | Bootstrap an empty tree (create `projects/`, `knowledge/`, `configuration.json`). |

## UI plumbing

| Verb | What it does |
|---|---|
| `getTheme()` / `setTheme(theme)` | Persist light/dark/auto preference in `settings.json`. |
| `helpReadDoc(name)` | Read a doc file from the asar (powers the in-app Help menu — `name` ∈ `architecture` / `configuration` / `non-goals`). |
| `quitApp()` | Quit the Electron app cleanly (window close runs `killAll` first). |
| `onMenuCommand(cb)` | Receive native-menu shortcuts (`Open`, `Close`, `Reload`, etc.). |

## Push events

A single chokidar watcher rooted at `<conception>/`, debounced 250 ms, pushes events through `tree-events`. Classification:

- `project` — `projects/<month>/<slug>/README.md` add/change/unlink. Renderer patches the project list in place via `getProject`.
- `knowledge` — any `.md` under `knowledge/`. Coarse — renderer bumps `refreshKey`.
- `config` — `configuration.json` at the conception root. Same coarse handling.
- `unknown` — any classification failure. Forces a full re-render.

A burst of `unknown` events collapses to one event before the renderer is notified.

## What is intentionally **not** here

- **No HTTP fallback.** No clipboard endpoint, no asset routes, no embedded server. The renderer reads the system clipboard through the browser's native [`navigator.clipboard`](https://developer.mozilla.org/docs/Web/API/Clipboard_API) API.
- **No vendored CDN bundles.** Electron ships Chromium directly; assets are bundled into the asar at package time.
- **No auth layer.** condash is single-user, local-only.

## See also

- `src/shared/api.ts` — the IPC contract, source of truth.
- `src/main/mutate.ts` — drift checks + atomic write + per-file queue, all in one file.
- `src/main/terminals.ts` — pty lifecycle + the kill pipeline.
- `src/main/git-status-cache.ts` — the TTL cache.
- `src/main/watcher.ts` — chokidar wiring + event classification.
