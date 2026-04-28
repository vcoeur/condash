# condash architecture

This document captures the load-bearing invariants of the condash codebase — the bits a contributor would otherwise have to reconstruct from line-by-line reading. It describes *what stays true*, not *how it's implemented*; the source files are authoritative for the latter.

## What condash is

A thin layer above the conception convention. It reads the live `<conception>/projects/`, `knowledge/`, and `configuration.json` tree, presents it (Projects / Code / Knowledge / Search tabs), and lets the user *navigate* and *edit markdown in place*. Code is not edited inside condash; running dev apps are supervised through an embedded pty.

There is no backend, no database, and no message bus. Every feature is a filesystem walk + a markdown parse, with chokidar pushing change notifications.

## Process layout

Three processes, three TS configs:

- **Main** (`src/main/`) — Node + Electron API. esbuild bundles to a single CJS file (`dist-electron/main/index.js`). Native modules (electron, node-pty) stay external.
- **Preload** (`src/preload/`) — context-isolated bridge. CJS, sandbox-compatible. One line per IPC verb (`preload/index.ts`).
- **Renderer** (`src/renderer/`) — Solid + Vite. Single SPA; the Help and PDF modals are in-renderer overlays, not separate `BrowserWindow`s.

Communication is `CondashApi` (`src/shared/api.ts`). One typed interface, one handler per verb, no string-mux'd payloads.

## Invariants

### 1. Drift-checked mutations

Every write call carries the *expected* state of the file region it's about to change:

- `toggleStep(path, lineIndex, expectedMarker, newMarker)` — the renderer passes the marker it currently sees; the main process refuses to write if the file on disk shows something else.
- `editStepText(path, lineIndex, expectedText, newText)` — same idea for step text edits.
- `setStatus(path, newStatus)` — only updates the **Status**: line in the metadata block, refuses if the line is missing.
- `writeNote(path, expectedContent, newContent)` — full-file drift check; renderer surfaces a "reload before saving" toast on mismatch.

The reason: the user is *also* editing these files in their IDE. condash never assumes it's the only writer.

### 2. Per-file write queue + atomic rename

`mutate.ts` serialises writes per path through `withFileQueue`. Concurrent toggles on the same file never interleave; failures don't poison the queue.

Every write is `tmp` → `fsync` → `rename`. A crash mid-write never produces a half-written file.

### 3. TTL git-status cache

`git-status-cache.ts` caches per-working-tree dirty counts for 3 s. The Refresh button calls `invalidateAll()` before re-reading, so an explicit user request always sees fresh data. Ambient re-renders (tab switch, tree-events) hit the cache.

The 3 s window is short enough that staleness is invisible to a human; the cache only matters when chokidar fires a burst of events or the user mashes Refresh.

### 4. PTY kill pipeline

`terminals.ts:stopSession` runs the same sequence for every session terminate, including `killAll` on window close:

1. SIGTERM the pty's process group (negative pid). node-pty allocates a session leader (setsid), so the signal reaches `make dev` → `vite` → child workers.
2. If the entry has a `force_stop:` configured, run it (shell). Failures are swallowed — the SIGKILL fallback covers them.
3. Wait 500 ms.
4. If the leader is still alive, SIGKILL the process group.

`killAll` bounds aggregate runtime to ~1 s so the window can actually close even if a force_stop hangs.

### 5. One run per repo (code side)

When a Run button fires for a repo on the code side, any prior code-side session for the *same* repo is stopped first via the full pipeline. This prevents accidental duplicate dev servers and frees the dev port before the new run binds.

### 6. Chokidar watcher contract

A single watcher rooted at `<conception>/`, debounced 250 ms. Events are classified into:

- `project` — `projects/<month>/<slug>/README.md` add/change/unlink. Renderer patches the project list in place via `getProject`.
- `knowledge` — any `.md` under `knowledge/`. Coarse — the renderer just bumps `refreshKey`.
- `config` — `configuration.json` / `configuration.yml` at the conception root. Same coarse handling.
- `unknown` — any classification failure. Forces a full re-render.

A burst of `unknown` events collapses to a single `unknown` event before the renderer is notified.

### 7. IPC contract

`CondashApi` in `src/shared/api.ts` is the *whole* IPC surface. The preload (`src/preload/index.ts`) implements every verb as a one-line `ipcRenderer.invoke`; the main process (`src/main/index.ts:registerIpc`) registers one handler per verb. No string-mux'd actions, no implicit channels.

Subscriptions (`onTreeEvents`, `onTermData`, `onTermExit`, `onTermSessions`) return an unsubscribe function; the renderer holds it and calls it from `onCleanup`.

## What's deliberately *not* an invariant

- **Search index.** `search.ts` re-walks the tree on every query. Fine at conception scale (a few hundred files, comment in `main/search.ts:11`); revisit if it ever bites.
- **Worker isolation.** Mutations and parses run on the main-process event loop. The largest file is a project README (kilobytes); the parse is microseconds.
- **Authentication / authorisation.** condash is single-user, local-only. There is no user model.

## See also

- [`configuration.md`](configuration.md) — `configuration.json` schema and per-key reference.
- [`non-goals.md`](non-goals.md) — explicit non-goals; read before adding scope.
- `src/shared/api.ts` — the IPC contract, source of truth.
- `src/main/mutate.ts` — drift checks + atomic write + per-file queue, all in one file.
- `src/main/terminals.ts` — pty lifecycle + the kill pipeline.
- `src/main/git-status-cache.ts` — the TTL cache.
- `src/main/watcher.ts` — chokidar wiring + event classification.
