---
title: Internals · condash explanation
description: How the Electron build is wired — the three processes, the IPC contract, the watcher, the write pipeline, the kill chain. Aimed at contributors and operators rather than users.
---

# Internals

> **Audience.** People who already know what condash does and want to know *how*. If you're trying to use the dashboard, [Get started](../get-started/index.md) is the right entry point.

## What condash is

A thin layer above the conception convention. It reads the live `<conception>/projects/`, `knowledge/`, and `configuration.json` tree, presents it (Projects / Code / Knowledge / History tabs), and lets the user *navigate* and *edit Markdown in place*. Code is not edited inside condash; running dev servers are supervised through embedded ptys.

There is no backend, no database, and no message bus. Every feature is a filesystem walk + a Markdown parse, with chokidar pushing change notifications.

## Process layout

Three processes, three TS configs:

- **Main** (`src/main/`) — Node + Electron API. esbuild bundles to a single CJS file (`dist-electron/main/index.js`). Native modules (`electron`, `node-pty`) stay external and load from `node_modules`.
- **Preload** (`src/preload/`) — context-isolated bridge. CJS, sandbox-compatible. One line per IPC verb (`preload/index.ts`).
- **Renderer** (`src/renderer/`) — Solid + Solid signals + Vite. Single SPA; the Help and PDF modals are in-renderer overlays, not separate `BrowserWindow`s.

Communication is the typed `CondashApi` interface in `src/shared/api.ts`. One handler per verb, no string-mux'd payloads. See [IPC API](../reference/ipc-api.md) for the full surface.

```
┌──────────────────┐    contextBridge        ┌──────────────────┐
│   Renderer       │  ───── invoke() ───►    │   Preload        │
│   (Solid SPA)    │                         │   (CJS bridge)   │
│                  │  ◄──── on() ──────────  │                  │
└──────────────────┘                         └──────────────────┘
                                                      │ ipcRenderer
                                                      ▼
                                             ┌──────────────────┐
                                             │   Main           │
                                             │   (Node)         │
                                             │                  │
                                             │  • mutate.ts     │
                                             │  • watcher.ts    │
                                             │  • terminals.ts  │
                                             │  • git-status…   │
                                             └──────────────────┘
                                                      │ fs / pty
                                                      ▼
                                             ┌──────────────────┐
                                             │   Conception     │
                                             │   tree (Markdown)│
                                             └──────────────────┘
```

## Invariants

These are the bits a contributor would otherwise have to reconstruct from line-by-line reading. They describe *what stays true*, not *how it's implemented*; the source files are authoritative for the latter.

### 1. Drift-checked mutations

Every write call carries the *expected* state of the file region it's about to change:

- `toggleStep(path, lineIndex, expectedMarker, newMarker)` — the renderer passes the marker it currently sees; the main process refuses to write if the file on disk shows something else.
- `editStepText(path, lineIndex, expectedText, newText)` — same idea for step text edits.
- `setStatus(path, newStatus)` — only updates the **Status**: line in the metadata block, refuses if the line is missing.
- `writeNote(path, expectedContent, newContent)` — full-file drift check; renderer surfaces a "reload before saving" toast on mismatch.

The reason: the user is *also* editing these files in their IDE. condash never assumes it's the only writer. See [Mutation model](../reference/mutations.md) for the user-facing contract.

### 2. Per-file write queue + atomic rename

`mutate.ts` serialises writes per path through `withFileQueue`. Concurrent toggles on the same file never interleave; failures don't poison the queue.

Every write is `tmp` → `fsync` → `rename`. A crash mid-write never produces a half-written file.

### 3. TTL git-status cache

`git-status-cache.ts` caches per-working-tree dirty counts for 3 s. The Refresh button calls `invalidateAll()` before re-reading, so an explicit user request always sees fresh data. Ambient re-renders (tab switch, tree-events) hit the cache.

The 3 s window is short enough that staleness is invisible to a human; the cache only matters when chokidar fires a burst of events or the user mashes Refresh.

### 4. PTY kill pipeline { #pty-kill-pipeline }

`terminals.ts:stopSession` runs the same sequence for every session terminate, including `killAll` on window close:

1. SIGTERM the pty's process group (negative pid). node-pty allocates a session leader (setsid), so the signal reaches `make dev` → `vite` → child workers.
2. If the entry has a `force_stop:` configured, run it (shell). Failures are swallowed — the SIGKILL fallback covers them.
3. Wait 500 ms.
4. If the leader is still alive, SIGKILL the process group.

`killAll` bounds aggregate runtime to ~1 s so the window can actually close even if a `force_stop` hangs.

### 5. One run per repo (code side)

When a Run button fires for a repo on the code side, any prior code-side session for the *same* repo is stopped first via the full pipeline. This prevents accidental duplicate dev servers and frees the dev port before the new run binds.

### 6. Chokidar watcher contract

A single watcher rooted at `<conception>/`, debounced 250 ms. Events are classified into:

- `project` — `projects/<month>/<slug>/README.md` add/change/unlink. Renderer patches the project list in place via `getProject`.
- `knowledge` — any `.md` under `knowledge/`. Coarse — the renderer just bumps `refreshKey`.
- `config` — `configuration.json` at the conception root. Same coarse handling.
- `unknown` — any classification failure. Forces a full re-render.

A burst of `unknown` events collapses to a single `unknown` event before the renderer is notified.

### 6a. Code-panel refresh: scalar vs. set membership

The Code panel's data has two refresh axes; conflating them caused the v2.7-era F5-disruption regression and the v2.10.0 stale-worktree regression. They live in `src/main/repo-watchers.ts` (push) and `src/renderer/repo-events.ts` + `src/renderer/main.tsx` (apply):

- **Scalar push** — `dirty` count and `upstream` status changes flow as `repo-dirty` / `repo-upstream` events. Per-repo chokidar watches the worktree root + most `.git/*` paths; debounce 500 ms; renderer applies path-shaped `setRepos` writes that touch one cell each. Open dropdowns and popovers stay alive.
- **Set membership** — worktree add/remove and primary checkout branch switch flow as `repo-worktrees-changed { repoPath }`. A second per-primary watcher on `.git/HEAD` + `.git/worktrees/` fires this; debounce 250 ms; renderer responds with `listReposForPrimary` (per-primary partial reload) merged via `reconcile({ key: 'path' })`. Open popovers still survive thanks to the `path`-keyed reconcile contract.

F5 / View → Refresh covers both: it drops the git-status TTL cache, recomputes scalar fields for every watched path, bumps the renderer's `refreshKey` for projects/knowledge/openWith/terminalPrefs, and calls the full `reloadRepos()` so any out-of-app worktree mutation is visible immediately.

### 7. IPC contract

`CondashApi` in `src/shared/api.ts` is the *whole* IPC surface. The preload (`src/preload/index.ts`) implements every verb as a one-line `ipcRenderer.invoke`; the main process (`src/main/index.ts:registerIpc`) registers one handler per verb. No string-mux'd actions, no implicit channels.

Subscriptions (`onTreeEvents`, `onTermData`, `onTermExit`, `onTermSessions`) return an unsubscribe function; the renderer holds it and calls it from `onCleanup`.

## Environment hygiene { #environment-hygiene }

condash spawns subprocesses (terminals, runners, `force_stop` commands, open-with launchers). The main process scrubs the environment before each spawn to avoid leaking interpreter-specific vars into unrelated child programs:

- `PYTHONHOME` / `PYTHONPATH` — leak from AppImage's stock `AppRun.wrapped`. A spawned `python3` would otherwise hit "No module named 'encodings'" because the leaked vars point into the AppImage mount.
- `PERLLIB` / `PERL5LIB` — same root cause; spawned `perl` scripts can't find their libs.
- `QT_PLUGIN_PATH`, `GSETTINGS_SCHEMA_DIR` — leak similarly; spawned GUI apps pick up the AppImage's bundled plugins instead of their own.

This is defence in depth. The AppImage build also patches `AppRun` itself (see [Install — Linux AppImage](../get-started/install.md#linux-appimage)) so the leak doesn't reach launchers spawned *outside* of condash either.

## Why no search index { #why-no-search-index }

`search.ts` re-walks the tree on every query. At conception scale (a few hundred files), full-text search takes a handful of milliseconds — well under the 16 ms interaction-to-paint budget — and an index would be more state to keep coherent under concurrent edits. Revisit if it ever bites.

## Why Electron, not Tauri

The Tauri lineage (now at [vcoeur/condash-tauri](https://github.com/vcoeur/condash-tauri)) used the OS's native webview — smaller binaries, no bundled Chromium update cycle. Electron costs ~80 MB more per platform. Why we switched:

- **Renderer parity.** Tauri shipped three webviews (WebKitGTK on Linux, WKWebView on macOS, WebView2 on Windows), each with subtly different CSS and JS quirks. Electron ships one Chromium everywhere — every per-OS branch in the renderer disappeared overnight.
- **node-pty.** The terminal pane uses `node-pty`. In Tauri we re-implemented the lifecycle in Rust; in Electron we use the same library the rest of the Node ecosystem already battle-tests.
- **electron-builder.** Single tool for all four installer formats (.AppImage, .deb, .dmg, .exe), plus `latest*.yml` channel files for `electron-updater`. Tauri's bundler pipeline was three different paths — `linuxdeploy`, `hdiutil`, WiX.
- **Maintenance.** A single-developer project pays a high cost for cross-language complexity. Keeping the entire stack in TypeScript halves the surface to keep current.

The trade-off — install size + manual chrome-sandbox handling on AppImage — is documented in [Install](../get-started/install.md).

## Build pipeline

```
src/main/        ──esbuild──► dist-electron/main/index.js
src/preload/     ──esbuild──► dist-electron/preload/index.js
src/renderer/    ──vite─────► dist/
                                │
                                ▼
                        electron-builder
                                │
                                ▼
  release/{*.AppImage, *.deb, *.dmg, *.exe, latest*.yml}
```

esbuild bundles main + preload into single CJS files. Native modules (`electron`, `node-pty`, future `better-sqlite3`) are kept external — they have to load from `node_modules` so `electron-rebuild` can reach them. Pure-JS deps, including ESM-only libraries (chokidar 4 and friends), are inlined.

`tsc` no longer emits — esbuild owns emission, tsc owns type-checking. `make typecheck` runs `tsc --noEmit` against `tsconfig.main.json` and `tsconfig.renderer.json`.

The renderer bundle ships in the asar at `dist/`. The dev server (`vite`) listens on `localhost:5600` and the dev Electron loads from there, with HMR; production loads from disk via `file://` URLs.

## What's deliberately *not* an invariant

- **Search index.** Re-walks the tree per query — see above.
- **Worker isolation.** Mutations and parses run on the main-process event loop. The largest file is a project README (kilobytes); the parse is microseconds.
- **Authentication / authorisation.** condash is single-user, local-only. There is no user model.
- **Cross-process logging.** Main and renderer write to their own console streams. There is no aggregator and no log file.

## See also

- [`src/shared/api.ts`](https://github.com/vcoeur/condash/blob/main/src/shared/api.ts) — the IPC contract, source of truth.
- [`src/main/mutate.ts`](https://github.com/vcoeur/condash/blob/main/src/main/mutate.ts) — drift checks + atomic write + per-file queue, all in one file.
- [`src/main/terminals.ts`](https://github.com/vcoeur/condash/blob/main/src/main/terminals.ts) — pty lifecycle + the kill pipeline.
- [`src/main/git-status-cache.ts`](https://github.com/vcoeur/condash/blob/main/src/main/git-status-cache.ts) — the TTL cache.
- [`src/main/watcher.ts`](https://github.com/vcoeur/condash/blob/main/src/main/watcher.ts) — chokidar wiring + event classification.
- [Non-goals](non-goals.md) — what condash deliberately doesn't do.
