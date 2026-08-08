---
title: Internals · condash explanation
description: How the Electron build is wired — the three processes, the IPC contract, the watcher, the write pipeline, the kill chain. Aimed at contributors and operators rather than users.
---

# Internals

> **Audience.** People who already know what condash does and want to know *how*. If you're trying to use the dashboard, [Get started](../get-started/index.md) is the right entry point.

## What condash is

A thin layer above the conception convention. It reads the live `<conception>/projects/`, `knowledge/`, `resources/`, `.agents/skills/`, and `.condash/settings.json` tree and presents it through one app shell:

- An **activity rail** down the left edge (`src/renderer/activity-rail.tsx`), nine items in two groups.
- A **left view** — one of `projects`, `tasks`, `deliverables`, `perf` (`LEFT_VIEWS` in `src/shared/types/layout.ts`).
- A **working surface** on the right edge — one of Code / Knowledge / Resources / Skills / Logs, mutually exclusive.
- A **bottom band** shared by the Terminal and the Dashboard (`Ctrl+Shift+D`), which never coexist.

Search is a global modal (`Ctrl+Shift+F` / `Ctrl+K`), not a pane. The user can *navigate* and *edit Markdown in place*; code is not edited inside condash, and running dev servers are supervised through embedded ptys (with optional disk capture under `.condash/logs/`).

condash reads **[agedum](../reference/skill.md#the-harness-launcher-agedum) sources only** — `<conception>/.agents/skills/` and `~/.config/agents/skills/`. It never reads the compiled harness views (`~/.claude/`, `<conception>/.claude/`, …), and the Skills pane is read-only in both scopes.

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
- `setStatus(path, newStatus)` — only updates the status line in the metadata block, refuses if the line is missing. The single primitive handles both header shapes: `status:` inside a `---`-delimited YAML frontmatter block, or the legacy `**Status**:` bold-prose line.
- `writeNote(path, expectedContent, newContent)` — full-file drift check; renderer surfaces a "reload before saving" toast on mismatch.

The reason: the user is *also* editing these files in their IDE. condash never assumes it's the only writer. See [Mutation model](../reference/mutations.md) for the user-facing contract.

### 2. Per-file write queue + atomic rename

The mutation modules (`mutate-steps.ts`, `mutate-status.ts`, `write-config.ts`) serialise writes per path through `withFileQueue` (`mutate-shared.ts`); the index regenerator and the header migration join the same per-path queue for their writes. Concurrent toggles on the same file never interleave; failures don't poison the queue.

Every rewrite of an existing file is `tmp` → `fsync` → `rename` (`atomic-write.ts`). A crash mid-write never produces a half-written file.

**Create-path exemption**: brand-new files — a project README (`create-project.ts`), a project note (`note.ts`), an empty tree file (`tree-mutations.ts`) — are written with the `wx` (write-exclusive) flag instead. Exclusivity is the point: `wx` fails with `EEXIST` rather than clobbering a concurrent winner, which `tmp` → `rename` cannot express. The trade-off is acceptable because the target didn't exist before the write — a crash can leave a partial *new* file, never corrupt an existing one.

### 3. TTL git-status cache

`git-status-cache.ts` caches per-working-tree dirty counts for `STATUS_TTL_MS` — **12 s**, raised from 3 s in #475. The Refresh button calls `invalidateAll()` before re-reading, so an explicit user request always sees fresh data. Ambient re-renders (pane switch, tree-events) hit the cache.

The window is not what keeps a dirty count honest: a real edit invalidates the entry outright, through Refresh or the per-worktree chokidar watchers in `repo-watchers.ts` (`invalidateForPath`). It only bounds how long an *unwatched* change stays invisible. The 3 s original was short enough that a burst of filesystem activity re-triggered the whole fan-out repeatedly instead of coalescing onto one scan — the reason it was widened.

**Bounded git fan-out (#475).** Every read-only git lookup on this path — `git worktree list`, `git status`, `rev-parse`, `rev-list` — runs through `withGitSlot` (`src/main/git-concurrency.ts`), which caps them at `GIT_SLOT_LIMIT` (6) in flight. `listRepos` issues its git calls from several *nested* fan-outs (`resolveParentWorktrees`, then a `buildEntry` per registry entry, then a per-worktree lookup inside each), so a pool at any one `Promise.all` bounds chains rather than spawns; the cap belongs at the spawn. On a 29-entry registry the unbounded version reached ~90 back-to-back `git` spawns and blocked the main event loop for ~4 s in one stretch — the cost is the fork of a ~450 MB Electron main process, not git's runtime (an individual `git status` there measures 6-23 ms), so it scales with the app's own RSS.

The cap is deliberately **not** applied to `exec` itself, which also carries `git fetch` / `git push` (sync), `gh` (pr-lookup), and the per-repo `install:` command of worktree setup — one slow network call holding a slot would starve the pane the cap exists to unblock.

Two spawns per parent repo were removed outright alongside it: `buildEntry` reuses the worktree list `resolveParentWorktrees` already computed instead of re-running `git worktree list`, and `isGitRepo` answers a repo root from a `.git` stat, falling back to `git rev-parse --git-dir` only for an entry pointing *inside* a repo (a submodule subdirectory).

**Boot prewarm (review finding S1).** The two cold scans that gate the default panes are warmed at `whenReady`, in parallel with `createWindow` and never blocking it (`src/main/prewarm.ts`): the project-README parse memo (via the same `findProjectReadmes` + `parseReadmeCached` path `listProjects` uses) and the repo git-status fan-out (`listRepos`). A naive prewarm alone wouldn't do: the warmed entries are governed by the git-status TTL, so they could expire before the renderer's first `listRepos` (after the window loads and the renderer mounts) and re-run the whole fan-out. So the boot scan's promise is stashed and the first `listRepos` awaits *that same promise* (`listReposReusingBoot` in `repos.ts`), reused one-shot regardless of the underlying cache's TTL. The parse memo needs no such trick — it is mtime-keyed, not time-bounded. Both prewarms are fire-and-forget and swallow their own errors.

### 4. PTY kill pipeline { #pty-kill-pipeline }

`terminals.ts:stopSession` runs the same sequence for every session terminate, including `killAll` on window close:

1. SIGTERM the pty's process group (negative pid). node-pty allocates a session leader (setsid), so the signal reaches `make dev` → `vite` → child workers.
2. If the entry has a `force_stop:` configured, run it (shell). Failures are swallowed — the SIGKILL fallback covers them.
3. Wait 500 ms.
4. If the leader is still alive, SIGKILL the process group.

`killAll` bounds aggregate runtime to ~1 s for the kill sweep, then awaits each session logger's final flush + close (bounded ~1.5 s) so quit can't drop the transcript tail or the exit footer; the quit handler `preventDefault`s and awaits it before letting Electron exit.

The headless task scheduler (`task-scheduler.ts`) has its own kill path for timed-out or user-killed scheduled runs: straight SIGKILL, with a `137` exit footer stamped on the run log before the logger closes. The orphan-seal sweep (run at boot and on every conception pick) covers `.condash/logs/` and the task-run trees (`.condash/scheduled/`, `.condash/manual/`) alike; it skips any log whose header `sid` is still tracked in the live session map, so a quiet live tab is never stamped with a bogus recovery footer.

### 5. One run per repo (code side)

When a Run button fires for a repo on the code side, any prior code-side session for the *same* repo is stopped first via the full pipeline. This prevents accidental duplicate dev servers and frees the dev port before the new run binds.

### 6. Chokidar watcher contract

A single watcher rooted at `<conception>/`, debounced 250 ms. The classifier is pure and lives in `src/main/watch-classify.ts` (split out of `watcher.ts` so it unit-tests under the node env — `watcher.ts` itself pulls in electron + chokidar). Its guiding rule: an ordinary in-tree edit must reload as little as possible; only a genuinely unrecognised path falls to `unknown`. Events are classified into:

- `project` — `projects/<month>/<slug>/README.md` add/change/unlink. Renderer patches the project list in place via `getProject` (timeline-stripped to match the list projection — see §7).
- `project` (scoped, from an in-project file) — **any other file** under `projects/<month>/<slug>/` (a `notes/` file, a `local/` asset, a nested README) maps to a `change` on that slug's README, so the renderer patches **just that one card** (a `getProject` parse-cache hit + a no-op reconcile) instead of the whole-dashboard fan-out. Never a removal — the README still exists.
- `projects-reload` — a project **directory** add/remove (a create/delete, a `notes/` dir appearing, a bulk git checkout). Reloads only the project list, none of the other panes.
- `ignore` — a `projects/**/index.md` regen (or any file above the slug level): store-irrelevant, touches nothing. The search index is still kept fresh independently upstream.
- `knowledge` — any `.md` under `knowledge/`. Coarse — the renderer just bumps `refreshKey`.
- `config` — the canonical `.condash/settings.json` (that single file — the rest of `.condash/` is never watched), or a legacy `condash.json` / `configuration.json` at the conception root. Same coarse handling; a `config` event also triggers a watcher rebuild in case `skills_path` changed.
- `unknown` — any classification failure. Forces the full whole-dashboard re-render (projects + knowledge + resources + skills + config + repos). This is now the true last resort: before this narrowing, ordinary note edits, `index.md` regens, and dir events all fell here, so routine in-tree activity re-paid the whole reload (review finding R1).

A burst of `unknown` events collapses to a single `unknown` event before the renderer is notified. The single-global-chokidar-rooted-at-`<conception>` watcher is unchanged — this is a **classification** narrowing, not a watcher-architecture change.

### 6a. Code-panel refresh: scalar vs. set membership

The Code panel's data has two refresh axes; conflating them caused the v2.7-era F5-disruption regression and the v2.10.0 stale-worktree regression. They live in `src/main/repo-watchers.ts` (push) and `src/renderer/repo-events.ts` + `src/renderer/repos-store.ts` (apply):

- **Scalar push** — `dirty` count and `upstream` status changes flow as `repo-dirty` / `repo-upstream` events. Per-repo chokidar watches the worktree root + most `.git/*` paths; debounce 500 ms; renderer applies path-shaped `setRepos` writes that touch one cell each. Open dropdowns and popovers stay alive. The worktree-root watcher ignores **everything git ignores**: its `ignored` option is a per-root function built from the repo's gitignore rules (`src/main/gitignore-matcher.ts`). The rule sources are concatenated in **ascending git precedence** — the user's `core.excludesFile`, then `.git/info/exclude`, then the root `.gitignore` — because the `ignore` npm package (pure JS, backs the matching) is last-match-wins, so the highest-precedence source must get the final word. Concatenating the other way inverts negations: a global `*.log` that the repo re-includes with `!server.log` must stay watched (git tracks it), which only holds when `.gitignore` is last. Over the gitignore rules sits a hardcoded floor: `.git`, `.condash`, `node_modules` are always ignored (file or dir), while the build-output floor — `dist`/`build` (word-matched: `dist-electron`/`build-out` yes, but `distribution`/`builder.ts` no) and `target` — is ignored **only for directory segments**, so an ordinary FILE named `dist`, `build.rs`, or `target` stays watched (the old `dist[^/]*`/`build[^/]*` prefix regexes wrongly suppressed those files and the whole `src/distribution/` tree). An event on a gitignored path can never change `git status --porcelain`, so ignoring them kills two waste sources: condash's own `.condash/` state dir (session logs flushing every few seconds → a perpetual self-triggered recompute loop) and descent into gitignored trees (`.venv/`, `__pycache__/`, measured ~11–12k inotify dirs machine-wide). Because `ignored` is a *function*, chokidar also refuses to descend into ignored directories — that is what shrinks the watch set, and it relies on `entry.stats.isDirectory()` to match dir-only patterns (`foo/`) and the build-output floor. A `.gitignore` edit both recomputes (it can change git status) and rebuilds that root's matcher; nested `<subdir>/.gitignore` files and live `.git/info/exclude` edits are not tracked (rare; the floor bounds the damage). A chokidar `error` (inotify exhaustion — EMFILE/ENOSPC) is surfaced to the renderer as an actionable toast (`src/main/watcher-status.ts`) and triggers one guarded re-arm of the watcher set, rather than leaving coverage silently partial on stderr.
- **Set membership** — worktree add/remove and primary checkout branch switch flow as `repo-worktrees-changed { repoPath }`. A second per-primary watcher on `.git/HEAD` + `.git/worktrees/` fires this; debounce 250 ms; renderer responds with `listReposForPrimary` (per-primary partial reload) merged via `reconcile({ key: 'path' })`. Open popovers still survive thanks to the `path`-keyed reconcile contract. `git worktree remove` of the *last* worktree unlinks `.git/worktrees/` itself, killing the inotify watch beneath chokidar; the structural handler detects `unlinkDir` on that path and immediately rebuilds the watcher (close + `mkdirSync` + fresh `chokidar.watch`) so the next add isn't silently missed.

F5 / View → Refresh fans out across **every working surface** (`reloadAll` in `src/renderer/hooks/use-conception.ts`): it drops the git-status TTL cache, then reloads projects (which also refreshes the derived Deliverables view), knowledge, resources, all four skill tabs, agents (the spawn-dropdown list), tasks, and logs, and calls the full `reloadRepos()` so any out-of-app worktree mutation is visible immediately. The agents list and the tasks pane own their own `createResource` and logs pushes a refresh through a deferred signal, so those three are kicked synchronously rather than awaited alongside the store reloads.

### 7. IPC contract

`CondashApi` in `src/shared/api.ts` is the *whole* IPC surface. The preload (`src/preload/index.ts`) implements every verb as a one-line `ipcRenderer.invoke`; the main process registers one handler per verb. `src/main/index.ts:registerIpc` is a thin dispatcher that calls each per-domain module under `src/main/ipc/` — all twelve, in registration order: `bootstrap.ts`, `projects.ts`, `agents.ts`, `tasks.ts`, `trees.ts`, `repos.ts`, `terminal.ts`, `logs.ts`, `dashboard.ts`, `auto-sync.ts`, `settings.ts`, `system.ts`. No string-mux'd actions, no implicit channels. Every main → renderer *push* (the tree + repo watchers, `termData`/`termExit`/`termSessions`, the dashboard snapshots, the `watcher-status` toast, and the menu) funnels through the shared `safeSend` helper (`src/main/safe-send.ts`), which delivers only to a live frame and returns whether the payload landed.

**`listProjects` projection.** `listProjects` returns the same `Project[]` shape as `getProject`, but with the potentially large `timeline[]` **emptied** on every row (`toListProjection` in `ipc/projects.ts`) — the array grows with a project's age, and multiplied across hundreds of resident projects + every reload's structured-clone it was a real long-session cost (review G1). The single timeline datum the card needs — the most recent entry's date — is precomputed at parse time as `Project.lastActivity` (kept on the row). The **preview** is the only surface that renders the full `timeline[]`, and it lazy-fetches the full project via `getProject` (a parse-cache hit, so effectively free) when it opens. The tree-events single-card patch strips the timeline the same way so the resident list stays uniformly timeline-free.

Subscriptions (`onTreeEvents`, `onTermData`, `onTermExit`, `onTermSessions`) return an unsubscribe function; the renderer holds it and calls it from `onCleanup`.

### 8. In-window drag uses pointer events, not HTML5 drag-and-drop

On Wayland sessions condash forces the native Wayland Ozone backend for crisp fractional-scaling text (`src/main/index.ts`). Chromium's HTML5 drag-and-drop (`draggable` + `dragstart` / `dataTransfer`) is broken under that backend — drags silently no-op ([electron#49907](https://github.com/electron/electron/issues/49907), [electron#42252](https://github.com/electron/electron/issues/42252)) — so any in-window drag must be built on **pointer events** (`pointerdown` / `pointermove` / `pointerup` + `setPointerCapture`), never HTML5 DnD. The pattern: capture the pointer on the source element once movement crosses a small threshold, never reparent the captured element mid-gesture, follow the cursor with a `pointer-events: none` clone, and commit on `pointerup` (hit-test the drop target with `elementFromPoint`). The Projects-pane status drag (`src/renderer/panes/projects-parts/cards.tsx`) follows this. **A clone of an animated element must have its animation and transition cancelled inline** (`ghost.style.animation = 'none'`, `.transition = 'none'`): CSS animations sit **above** the style attribute in the cascade, so a clone of `.row` — which carries `animation: fade-up … both` — kept the final keyframe's `translateY(0)` / `opacity: 1` for the whole gesture, ignoring every `transform` the drag wrote and pinning the ghost opaque at the viewport origin while the drop itself still worked (shipped broken until 2026-07-25; the regression guard is the ghost-tracking assertion in `tests/status-drag.spec.ts`). The `transition` matters too — `.row` transitions `transform`, so an un-cancelled one leaves the ghost easing 140 ms behind the cursor. **Still on HTML5 DnD and therefore broken on Wayland:** terminal-pane tab reorder (`src/renderer/terminal-pane/drag-drop.ts`) and settings-modal repo/section reorder (`repo-row.tsx`, `section-row.tsx`) — convert them the same way when next touched.

### 9. Renderer CSP allows `'wasm-unsafe-eval'` for the terminal image addon

The terminal pane loads `@xterm/addon-image` (`src/renderer/xterm-mount.ts`) to render inline-image escapes (Sixel + iTerm). Its Sixel path is a **WebAssembly** decoder compiled lazily on the first image payload. Chromium refuses to compile any WASM module under a bare `script-src 'self'`, and that refusal throws *inside xterm's synchronous write loop* (`_innerWrite`) — so a single inline-image escape blanks the whole terminal rather than just dropping the image. CLIs that emit Sixel on startup (notably the **opencode** TUI) trip this; claude/kimi don't, which is why only opencode terminals went blank.

The renderer CSP (`src/renderer/index.html`) therefore carries `'wasm-unsafe-eval'` in `script-src`. That CSP3 keyword permits WebAssembly compilation **only** — it does not re-enable JS `eval` / `new Function`, so it is strictly narrower than `'unsafe-eval'`. Keep it; a CSP audit that strips it re-breaks every inline-image-emitting CLI.

### 10. Modal shell + sizing tiers + the terminal-aware backdrop

Every simple centered modal renders through one `<Modal>` shell (`src/renderer/modal.tsx`). The shell owns the backdrop, the centered panel, the `.modal-head` bar (title / path / `headExtra` action slot / close button), the dialog ARIA wiring, and — installed once, for free — the two behaviours that were previously opt-in per file: Esc-to-close (`useModalEscHandler`) and drag-out-safe backdrop dismissal (`createBackdropClose`, which ignores a `click` synthesised by a drag that began inside the panel). A modal passes its width-tier as `class`, optional `headExtra` action buttons, or a `headLeading` slot for a non-title lead (the search input, the logs mono title). Confirmations all go through the single `ConfirmModal` (the quit prompt included — there is no per-case confirm component). Three surfaces keep their own backdrop/Esc handling because their Esc contract is non-trivial and would break under the shell's unconditional Esc: the **note** modal (dirty-guard + in-modal back-stack, `modal-router.ts`), the **settings** modal (unsaved-edits Esc gate), and the **project-preview** popover (lets inline edit/add inputs swallow Esc). On the state side, the mutually-exclusive menu/keyboard overlays (search, settings, new-project, about, quit-confirm, shortcuts, help) are one `activeModal` discriminated-union signal in `hooks/use-modals.ts` — the "only one open at a time" invariant lives there, exposed as the same per-modal boolean accessors so call sites are unchanged; the payload-carrying, router-coupled surfaces (note `modal`, `previewPath`, the pdf/html/image viewers) keep their own signals.

Every modal shares the `.modal` / `.modal-backdrop` chrome in `src/renderer/modal-base.css` and maps its width onto one of three tokens — `--modal-w-sm` (dialogs), `--modal-w-md` (forms/tools), `--modal-w-lg` (content viewers) — declared once in that file. Two cascade rules make this work:

- The base size **defaults** live in `:where(.modal) { width; max-height }`, **not** `.modal { … }`. Each per-modal stylesheet (`note-modal.css`, `tasks-pane.css`, …) is imported by its own component, so it is bundled *before* `modal-base.css`; a plain `.modal { width }` at equal specificity would win by source order and pin every popup to one width. `:where()` has zero specificity, so each `.<name>-modal { width: var(--modal-w-*) }` (one class) always wins regardless of bundle order. Set per-modal sizes with a single-class selector and never add `width` back to bare `.modal`.
- The backdrop stops at the top of the terminal pane instead of covering the whole window: `.modal-backdrop` uses `bottom: var(--terminal-pane-height, 0px)`, and `TerminalPane` (`src/renderer/terminal-pane.tsx`) publishes its own rendered height to that custom property from a `ResizeObserver` (covering open/close, resize-drag, split, window-resize uniformly). The terminal stays visible and usable while any popup — Settings included — is open.

### 11. CSS design system: type scale, tokens, primitives { #css-design-system }

The renderer is plain CSS files + CSS custom properties (no preprocessor; Vite targets `chrome130`, so native nesting and `color-mix()` are fair game). The token layer lives in `src/renderer/styles.css`; shared shape primitives live in `src/renderer/primitives.css`. The modal width-tier set (invariant 10) is the template the rest of the system follows: a small named-tier set declared once in a shared file, with per-component opt-outs only where deliberate.

- **One type scale, in px.** Every text `font-size` reaches for a `--text-*` token (`--text-3xs` 10px … `--text-3xl` 24px); there is **no** rem ladder and **no** half-pixel size. The full ladder + role guide is the comment on the token block in `styles.css`. The only exemption is a genuine icon glyph sized in px (a caret/arrow/`+`), which is not text — those keep a raw px value and carry a one-line "icon glyph, not text" comment so the intent is explicit. Adding a new text size means picking the nearest existing step, not inventing a literal; add a step to `styles.css` only when no step is close.
- **No spacing scale.** A `--space-1..8` / `--pad` ladder used to be documented but had zero consuming call-sites, so it was removed. Spacing (padding / gap / margin) is intentionally raw px. The tokenised scales are **type** (`--text-*`), **radius** (`--radius-*`, incl. `--radius-pill`) and the **modal width tiers**. If a spacing scale is reintroduced, migrate the existing literals onto it in the same change so it can never drift back to documentation-only.
- **Each theme is one scoped block; dark/light is one attribute.** Themes are declared in the registry at `src/shared/themes.ts` (`id`, `label`, `kind`, swatch) and painted by a matching `[data-theme='<id>']` token block in `styles.css`. `use-theme.ts` resolves the stored choice — including `system`, against the OS preference — in JS and stamps **two** attributes on `<html>`: `data-theme` (the preset id, which selects the palette) and `data-theme-kind` (`dark` or `light`). Rules that only care whether the surface is dark — highlight.js in `code-theme.css`, the app pills, the settings modal, the dashboard pane — key on `data-theme-kind`, so a new dark preset needs no new selectors and nothing is kept in lock-step by hand. The `warm-gallery` (`dark`) preset keeps its colours in the private `--dark-*` set on `:root` and remaps onto them; a new preset declares its final tokens directly. The single `@media (prefers-color-scheme: dark) :root:not([data-theme])` arm is a **pre-hydration fallback only** — it paints the first frame before the bootstrap IPC lands and never matches afterwards. Never re-type a theme's hex literals outside its own block.
- **Semantic + preview tokens are defined, never faked via fallbacks.** `--danger` (→ `--warn`) and `--text-dim` (→ `--text-faint`) are real aliases onto the palette, and the Settings terminal-preview sample palette is a defined `--preview-*` set (a fixed Tokyo-Night sample, deliberately theme-independent). Reference tokens directly; do **not** write `var(--made-up-token, #literal)` — an undefined token with a hardcoded fallback silently diverges from the palette.
- **Shared shape primitives.** `primitives.css` holds `.section-header` (the uppercase label · count · rule bar) and `.pill` (the rounded-chip geometry shared by `app-pill`, `repo-status-badge`, `tree-special-badge`, `search-source-pill`, …). The pill base is applied via a grouped selector so existing badges inherit the geometry with no markup change; a new badge should add the `pill` class and keep only its colour/padding/font on its own class. Restyle "all pills" or "all section headers" from the one base, not per-pane.
- **Action framework.** Buttons are a single vocabulary in `actions.css`, rendered by the `<Button>` / `<IconButton>` / `<ActionBar>` wrappers in `actions.tsx` so call-sites name the **role**, not the chrome. Roles: `.btn--primary` (the one committing action — filled accent, adaptive `--bg-elevated` text), `.btn--default` (neutral / cancel), `.btn--ghost` (chromeless text action), `.btn--danger` (quiet destructive), with `.btn--sm` / `.btn--icon` (`--btn-size` / `--btn-icon`) modifiers and `.btn--active` for a pressed toggle. A `data-tone` attribute keys colour off the **verb** — `open`/`add` → accent, `work`/`run` → `--col-running`, `stop`/`danger` → `--warn` — so a verb reads the same in every pane (on an icon it colours the hover; on a primary it recolours the fill for a destructive commit). `.action-bar` is the footer commit/cancel row (cancel left, primary right; `--split` pushes a lone destructive far-left). `.seg` / `.seg-item` (`--sm`) is the segmented toggle. A new action picks a role + tone; it does not mint a per-pane button class. The 32 px modal-head icon button (`.modal-button`, modal-base.css) is the head-bar sibling of `.btn--icon`: its own layout idiom, but it carries the same `data-tone` hover cues, so an "open external" in a modal head reads accent like the same verb in a pane row. **Icon vocabulary:** one close glyph (`IconClose` in `icons.tsx`) backs every modal close — shell, settings, note, preview — and one disclosure caret (`<Caret expanded>` + `ChevronIcon`, rotated by `.caret-icon` in primitives.css) backs every collapsible header / row / tree folder. Don't hand-render a `×` or a `▸`/`▾`; reach for these. The dropdown-trigger caret (`ChevronDownIcon`) is deliberately distinct from the disclosure caret — a menu trigger is not a twisty.

### 12. Component split threshold + the `*-parts/` layout { #component-parts }

A renderer pane or modal `.tsx` that grows past **~400 LOC**, or that holds more than one sub-component, is split into a sibling `<name>-parts/` directory rather than left as a monolith. The keep-file (`<name>.tsx`) keeps the public component and the orchestration — the signals, the IPC calls, the create/edit/save/delete flow — and imports the rest from `<name>-parts/`. The threshold is a smell, not a hard gate: a single-responsibility file that is long because the problem is inherently detailed (the index-tree parser is the canonical case) stays whole; the trigger is *multiple concerns in one file*, which length usually signals.

The sub-file vocabulary is fixed so a reader can predict the layout:

- **`data.ts`** — pure logic + types + constants, dependency-free (no Solid, no `window.condash`), so it unit-tests directly. It carries a sibling **`data.test.ts`** (vitest, picked up by `src/**/*.test.ts`). Extracting the pure helpers into `data.ts` is what makes the decomposition testable — the monolith's logic was reachable only by driving the whole component in Playwright.
- **`icons.tsx`** — pane-specific SVG glyphs (only genuinely local ones; shared glyphs live in `src/renderer/icons.tsx`).
- **One presentational `.tsx` per sub-component**, named for what it renders (`task-editor.tsx`, `task-fill.tsx`, `task-running.tsx`, `badges.tsx`).

Existing `-parts/` dirs: `panes/projects-parts/`, `panes/code-parts/`, `panes/tasks-parts/`, `panes/logs-parts/`, `settings-modal-parts/`, `note-modal-parts/`, `project-preview-parts/`. A sub-component that *is* a modal renders through the shared `<Modal>` shell (invariant 10) — it does not hand-roll a backdrop/header. `settings-modal.tsx` is the one pane still over the threshold with a richer split owed (its Esc/save contract keeps it off the shared shell); decompose it further when next substantially touched.

### 13. Terminal WebGL contexts are pooled { #webgl-pool }

xterm's `WebglAddon` holds one GPU context per terminal, and condash eagerly mounts every open "my terms" tab (`terminal-pane/controller.ts` mounts each session, hidden ones included). Each open tab therefore used to hold its own live WebGL context; past the browser's ~16-context ceiling the GPU force-loses contexts and the addon's context-loss retry churns — the "slow with many terminals open" cliff. A shared LRU pool (`src/renderer/webgl-pool.ts`) now caps the number of live contexts (default 8): `mountXterm` registers each terminal's context as a pool slot, the terminal pane calls `MountedTerm.setVisible()` from `focusActive()` so the currently-shown tab(s) are protected and long-hidden tabs release their context (falling back to xterm's DOM renderer — no data loss), and re-showing a tab re-attaches a fresh context. The pool module is `@xterm/*`-free so it unit-tests under the node vitest env (`webgl-pool.test.ts`), mirroring the `prompt-decorations.ts` split. The addon's own `onContextLoss` rebuild still runs for genuine GPU resets, but only if the pool still wants that terminal live — recovery can't smuggle a terminal past the cap.

### 14. Hidden terminal tabs parse off the main thread { #terminal-worker }

Even with the WebGL pool, every open "my terms" tab used to run xterm's ANSI parser and scrollback bookkeeping on the renderer main thread whenever the pty produced output, including tabs that were not visible. With many long-running agent tabs this main-thread work bled into the rest of the UI (tab switching, Projects/Code panes). `terminal-pane/controller.ts` now keeps only the active tab(s) as real DOM Terminals; every other tab's output is fed to a headless `@xterm/headless` Terminal running in a dedicated Web Worker (`src/renderer/terminal-worker.ts`). When a hidden tab becomes active, the worker serializes its buffer (`@xterm/addon-serialize`) and the controller hydrates a fresh DOM Terminal from that snapshot. When an active tab becomes hidden, the DOM Terminal is serialized, its state is seeded into a new worker Terminal, and the DOM Terminal is disposed. Logging and auto-close-on-exit are unaffected because they live in the main process or in the controller's own bookkeeping.

**Hydrate at the pty's geometry, not at xterm's default.** A hidden tab used to be rebuilt as `new Terminal()` with no `cols`/`rows` — xterm's **80×24** constructor default — and the snapshot was written into that grid *before* any fit. For a **live full-screen TUI** (Claude Code, opencode, any Ink or ncurses app) that is fatal by construction: the snapshot holds an alternate-screen frame drawn for the pty's real width, writing it at 80 columns wraps every row, and the alternate buffer **never reflows on resize** — `Buffer._isReflowEnabled` returns `_hasScrollback`, which `BufferSet` sets to `false` for the alt buffer — so the later fit stretches the grid without ever un-wrapping the frame. No fit could repair it; only a fresh repaint from the program could. This was long recorded as an *inherent* `SerializeAddon` limitation, which sent five rounds of work into tuning the repaint nudge; the serialization was never the problem, the **replay geometry** was. So the promote path now reads the pty's own winsize from main (`termGeometry` → `terminalGeometry` in `src/main/terminals.ts`; main owns the pty and is the only holder of this — the renderer writes geometry via `termResize` and is never told it) and constructs the replacement Terminal at that size before replaying. Resolving it from main rather than from the demote-time size also covers the gap that **nothing resizes a hidden tab**: the worker protocol has no resize message, and the renderer only refits the ≤ 2 visible terminals, so a window or pane resize while a tab is hidden leaves both the worker Terminal and the pty on the old geometry. The same geometry is passed on the reload/restore path (`reconcile` → `termAttach`), where the raw pty tail has exactly the same problem and no repaint nudge ever fires (there is no previous active id to switch away from), and on the **Code pane's inline runner** (`code-runs.tsx`), which replays the same raw tail into its own Terminal and offers no Refresh affordance at all — an alternate-screen `run:` command (bacon, cargo-watch, an agent) is affected there exactly as a "my terms" tab is.

The invariant this protects is asserted directly in `tests/terminal-hydrate-geometry.spec.ts`, once per path: a full-screen TUI paints one frame, **freezes** (`tests/fixtures/static-frame-tui.mjs` stops repainting on request), the tab is either switched away from and back **or** rebuilt by a renderer reload, and the rendered grid must still equal the frame the pty last painted. Both cases are needed — `geometry` is an optional trailing parameter, so dropping it at the `reconcile` call site alone leaves the typecheck clean and the switch-path test green while the restore path silently reverts to 80×24. Freezing is the point — a cooperating program repaints on the nudge and would repair a mangled hydrate after the fact, making a correct hydrate and a broken one indistinguishable. Every earlier test in this area pinned a *mechanism* (`__condashRefreshLog` fired, `cols > 80`) and stayed green across the whole history of this bug class; assert the property, not the machinery.

**Freezing that TUI has to wait for the pane to stop resizing it, and no geometry poll can tell it when that is.** A fresh spawn's pty starts at 80×24 (`spawnTerminal` defaults it; nothing passes the pane's grid), the mount-fit then resizes it to the pane's real grid, and that resize drops the tab's `exactHydrates` record — so the first-activation repaint finds a frame it cannot prove exact and *nudges* it, holding the grid at `rows - 1` for `REPAINT_NUDGE_MS`. For the length of that hold the terminal, the pty and the frame the program painted all agree on the dipped size: a mid-nudge grid is perfectly self-consistent and reads exactly like a settled one. Freezing there captured a frame painted for `rows - 1` and compared it against the restored `rows` — a one-row mismatch that passed locally and failed all three attempts on a slower CI runner, where the poll intervals land inside the dip. The controller therefore keeps `__condashRepaints` (`{ started, settled }`, gated on the same `data-test-xterm-registry` opt-in as the other seams, counted on every exit path including the nudge's timers), and the spec waits for `settled` to catch `started` before it reads a geometry or freezes anything. `__condashRefreshLog` cannot serve: it records the *start* of a nudge and says nothing about its restore. Waiting on a duration is what this replaces — the sequence is bounded (160 ms hold, then a fit, then a 150 ms backstop fit) but its *start* is not, so any fixed wait is a guess about scheduler load.

Hydration still is not pixel-perfect for every program — a TUI that tracks state xterm's buffer does not model can still come back stale — so the **Refresh** action remains (`refreshSession` in `terminal-pane/controller.ts`, exposed as the tab-strip **Refresh** button and a tab context-menu item): it nudges the pty one row shorter and back (`term.resize` → `termResize` → two SIGWINCHes), which makes the running program redraw its whole screen. Scrollback is kept, and plain shells ignore the resize.

**The automatic nudge stands down on a provably exact frame**, because the nudge is not free. Shrinking the grid a row and growing it back is serviced, on the non-reflowing alternate buffer, by popping the bottom line and pushing a fresh blank one (`Buffer.resize`) — so for a program that does not repaint on SIGWINCH it *shears the bottom row off a frame that was correct*. While hydration landed at 80×24 that was a good trade, since the frame was wrong anyway; now that it can be provably right, nudging it can only do damage. The controller therefore records a hydrate as exact only when the snapshot's own geometry (kept in `workerGeometry` at demote), the pty's geometry and the grid the Terminal was built at all agree, drops that record the moment anything resizes the grid, and passes the result to `decideRefreshAction` as `frameIsExact`. The restore path records one too, for the same reason: the raw pty tail is replayed into a grid built at the pty's own winsize. Only an **automatic** repaint sets `allowExactSkip` (it is derived from `refreshSession`'s `auto` flag, so every automatic caller gets it) — manual **Refresh** stays unconditional, because the user pressing it is itself the signal that the screen is wrong, whatever the geometry bookkeeping says.

Two things make the nudge actually land, both learned from opencode never repainting no matter how often Refresh was pressed:

- **The hold must outlast the program's own resize debounce.** opencode (Bubbletea) coalesces resizes for ~100 ms, so it only ever samples the *current* pty size when its debounce fires. `REPAINT_NUDGE_MS` (160 ms) holds the intermediate `rows-1` size long enough that the program samples it and repaints, then samples the restored size and repaints again — two genuine deltas. At the old 80 ms the smaller size was gone before opencode looked, so the resize collapsed to a no-op and nothing was emitted.
- **A competing `fit()` must not restore the size early.** Every `syncVisibility` ends in `focusActiveDom`, which refits the active terminal; chained after the nudge it would snap the pty back to full height within a frame and collapse the dip regardless of the hold. The controller tracks mid-nudge sessions in a `nudging` claim-check (`createNudgeRegistry`) and `focusActiveDom` skips refitting them; the nudge's own timeout does the restoring fit when it's done. `refreshSession` also skips re-asserting an already-active id, since that re-assert was itself a source of the competing fit. The claim is keyed by **session id *and* handle**: a switch destroys and rebuilds a session's DOM Terminal, so an id-only claim let a stale timer both block the replacement handle's fit (the new terminal was then never fitted by its promote) and clear a live nudge's guard. A claim only ever affects the handle that made it, and a second refresh arriving while a handle is already held is a no-op rather than a second dip.

Refresh runs automatically on switch by default. A `createEffect` diffs each column's active id against its previous value and, on any change to a different tab, calls `refreshSession(id, { onlyIfAltBuffer: !refreshAll, auto: true })`, where `refreshAll` is true unless `terminal.autoRefreshOnTabSwitch` is explicitly `false`. `refreshSession` checks the tab's buffer type *after* it hydrates; when `refreshAll` is false it nudges only tabs on the alternate screen buffer (live full-screen TUIs), the class whose hydrated frame is hardest to reproduce. It captures every switch path — tab click, keyboard move, focus-promote, cross-column drag, and the active tab being closed — because they all funnel through the same active-id signal. A **first** activation (previous id null) nudges too: a tab restored on boot, the first spawn into a column, and the tab promoted after a close all hydrate from a snapshot exactly like a switched-to tab. Three shapes make that reliable:

- The close path writes the new active id in **one** signal write (`activeIdsAfterDrop`) rather than nulling the column and then writing the fallback, so no observer sees a phantom "no active tab" step.
- A **bulk** activation does not mean a burst of repaints. `reconcile`'s insert loop activates each restored tab in turn, so a restore of N tabs would queue N nudges — each holding a pty one row short for 160 ms, with the next insert's promote demoting the previous tab *inside* that hold, serializing a mid-repaint frame into a worker Terminal one row short. The loop suppresses the per-insert nudge (`bulkActivations`) and repaints once per touched column at the end, on the tab the user lands on. Belt to that brace: a demote settles an in-flight nudge first (`settleNudge`), so no worker Terminal is ever seeded at the nudged height.
- The dashboard→terminal flip and the pane reopen change no active id, so they ask for the repaint explicitly — for **both** columns, since a split shows two. That ask is gated on a real hidden→visible transition, not on the effect running: `props.open` is `layout().terminal` and `layout` is a memo over an object `updateLayout` reallocates on every patch, so the effect re-runs on a sidebar toggle or a splitter commit, and repainting there would put a SIGWINCH round-trip through a live agent TUI on unrelated UI events.

**`auto` is the one flag behind every stand-down.** A repaint condash asked for may skip a frame already proven exact (`allowExactSkip`) and may skip a nudge already in flight for the same terminal; a *manual* Refresh does neither — it is unconditional, and one that arrives mid-hold is queued behind it, never dropped, because the whole bug class is "I had to press Refresh" and swallowing a press is the one thing this path must not do. Deriving `allowExactSkip` from `auto` rather than setting it per call site is what keeps the two automatic callers above (the end-of-restore repaint and the band flip) from shearing a frame that is already the pty's screen: **first activations now get a repaint, and the restore path records its hydrate as exact** (the raw pty tail replayed into a grid built at the pty's own winsize, nothing resized since), so the two fixes compose instead of cancelling — without that record the new repaint would shear the bottom row off exactly the frame hydrating-at-geometry had just got right. `terminal.autoRefreshOnTabSwitch` (Settings → Terminal → "Auto-refresh on tab switch") lets users opt back into the alt-buffer-only behaviour, and applies to every automatic repaint, not just the switch path. The repaint is deferred to a microtask so the effect never writes the active-id signal re-entrantly.

The nudge restores its row **explicitly** before re-fitting. Leaving the restore to the fit alone meant a host that never resolved a usable box (the fit gives up) left the terminal — and the pty — permanently one row shorter than before the repaint: the nudge became the damage.

Fitting a hydrated terminal to its host is made resilient three ways, because `FitAddon.proposeDimensions()` sizes the grid purely from the host's laid-out width/height. First, the visibility-transition fits (`focusActiveDom`, the dashboard→terminal view flip, the nudge's restore) go through `fitWhenReady` instead of a bare `fit()`: if `proposeDimensions()` can't resolve yet — a freshly-shown tab whose flex box hasn't settled, a host still 0-sized from a transition — it retries on `requestAnimationFrame` (bounded by `MAX_FIT_ATTEMPTS`) rather than no-opping and stranding the grid at the 80×24 default. The retry-vs-fit decision is the pure `fit-when-ready.ts` (`decideFit`), unit-tested like `nudge-machine` / `visibility-plan`, and it skips a `nudging` session so it never collapses the repaint dip. Second, **readiness is never inferred from `proposeDimensions()` alone**, because it *clamps* instead of failing (`Math.max(2, …)` / `Math.max(1, …)`): a `display:none` host yields NaN, but a host that is rendered and zero-height yields a perfectly finite `{cols: 2, rows: 1}`. Committing that resized the pty to 2×1 and then tripped `decideRefreshAction`'s `rows <= 1` skip — the degenerate geometry passed the guard *and* suppressed the repaint that would have repaired it. `decideFit` therefore takes the host's own measured box and treats both a zero axis and the clamp floor as "not laid out yet". Every terminal-pane fit routes through it — `focusActiveDom`, the cross-column move, the nudge's restore, and the splitter/window-resize refit (`ResizeDeps.refitAll`) — as does the Code pane's run-row terminal, which owns its own xterm and its own pty. The two checks are not redundant and neither subsumes the other: the box is read as `clientHeight` (content **+ padding**) while `proposeDimensions()` measures the computed content height, and `.xterm-host` carries `padding: 4px 8px`, so a host 1–8 px tall passes the box check and is caught only by the grid floor — which is exactly the wrapped-tab-strip-over-a-short-pane band. When neither resolves within the budget the fit **gives up**: the grid stays at whatever it was (80×24 for a fresh mount), which is a pty describing a screen the user cannot see. That is better than committing the 2×1 floor, but it is not a fitted terminal — the give-up is logged rather than silent, because a silent one is why five rounds of fixes had nothing to look at. Third, a `ResizeObserver` on each column host refits that column's active terminal on any host size change — the continuous backstop for a host that grows after the one-shot fits have run (a layout reflow, the top band collapsing, a maximize the `window 'resize'` listener sampled mid-animation), which `resize.ts` (window-resize + splitter drag) alone did not cover. Without it a terminal fitted to an earlier, smaller host stays stranded narrow in a wider pane.

Output that arrives while a tab is mid-transition — its worker Terminal serialized away, its DOM Terminal not built yet — is parked in `transition-buffers.ts` and flushed to whichever side wins. A buffer is dropped **only when its bytes had somewhere to go**: the flush hands them to a sink that reports whether it took them, so a flush that finds no DOM Terminal (the mount bailed on its race guard, or its dynamic import threw) leaves them parked for the next one. A promote that consumed a replay and then failed to mount puts it **back at the front** (`restore`), ahead of anything parked since. Deleting first and writing through an optional chain silently lost pty output, and main keeps only a 64 KB tail — no amount of Refresh can bring those bytes back. Retention is bounded: a session whose mount never lands has nothing scheduled to flush it again, so each buffer is capped (oldest chunks evicted first) rather than growing for the app's lifetime. Because parked bytes now outlive their transition, the steady-state `onTermData` branches consult the buffer before writing directly — otherwise a fresh chunk jumps ahead of older parked ones.

## Environment hygiene { #environment-hygiene }

condash spawns subprocesses (terminals, runners, `force_stop` commands, open-with launchers). Every one of them starts from a **copy** of `process.env` — `process.env` itself is never mutated. How much is done to that copy depends on whether the child is a pty; either way the code is all in `src/main/shell-env.ts`:

1. **`PATH` is replaced** with the login-shell PATH — the one edit **every** child gets. A Wayland session, the macOS Dock, or a `.desktop` entry never sources `~/.profile` / `~/.zprofile`, so the inherited `process.env.PATH` lacks user-installed CLIs (`opencode`, `~/bin` wrappers). `spawnEnv()` resolves the real one once at boot (`$SHELL -lic`, memoised, 5 s timeout) the way VS Code's integrated terminal does. On Windows, and on any probe failure, it falls back to the inherited PATH.
2. **`TERM` is forced to `xterm-256color`** on pty spawns (`spawnPtyEnv`).
3. **`npm_config_prefix` / `npm_config_globalconfig` / `npm_config_userconfig` are deleted** — also `spawnPtyEnv`, so also pty-only. Electron inherits them from whatever shell launched it, and a global `npm_config_prefix` breaks nvm loading in every child shell.

Edits 2 and 3 are therefore **pty-only**. Open-with launchers (`src/main/launchers.ts`) and `force_stop` (`src/main/terminals.ts`) call `spawnEnv()` directly and get the PATH replacement alone — an IDE opened from a slot still carries whatever `npm_config_prefix` Electron was launched with. Per-child breakdown: [Environment — what a spawned subprocess inherits](../reference/env.md#what-a-spawned-subprocess-inherits).

**That is the whole scrub.** Interpreter-specific variables an AppImage runtime can leak — `PYTHONHOME`, `PYTHONPATH`, `PERLLIB`, `PERL5LIB`, `QT_PLUGIN_PATH`, `GSETTINGS_SCHEMA_DIR` — are **not** unset anywhere in the codebase. Two source comments still claim otherwise — `src/main/shell-env.ts`, which cites this very anchor, and `src/shared/shell-quote.ts`, where the choice of `-c` over `-lc` is justified as protecting a scrub that was never written. Where they and this page disagree, the grep wins. If a spawned `python3` inside the AppImage build ever reports `No module named 'encodings'`, that is a real open gap, not a defence already in place: the fix would be an extra scrub in `spawnPtyEnv`. Treat this paragraph as the known state, not as a to-do that has been done.

The AppImage build *is* patched, but for an unrelated reason: `.github/workflows/_build.yml` rewrites the `exec "$BIN" …` lines in the repacked AppImage's `AppRun` to inject `--no-sandbox`, and verifies the patch landed by re-extracting the image. It touches no environment variable. See [Install — Linux AppImage](../get-started/index.md#linux-appimage).

## The search index { #search-index }

The four Markdown sources (projects incl. notes, knowledge, resources, skills) are held in an **in-memory index** in the main process (`src/main/search/index-cache.ts`): each file's content, lowercased content, region map, and title are precomputed once at conception-open, so a query runs only the per-term `indexOf` + scoring over RAM strings — no per-keystroke re-walk / re-read / re-lowercase. The index is built fire-and-forget (never blocks boot; queries fall back to an on-disk scan until it resolves) and kept incrementally fresh by the chokidar watcher (`src/main/watcher.ts` → `applyIndexFsEvent`): an add/change re-prepares one file, an unlink drops it, and an `unlinkDir` drops every indexed entry under the removed directory by prefix. Events that arrive while a build is still in flight are buffered and replayed in arrival order once the build completes (dropped if a newer build supersedes), and concurrent events for the same file apply in arrival order via a per-path chain — so neither the boot/rebuild window nor a rapid edit burst can leave the index stale. ~16 MB resident at conception scale (each prepared file retains raw + lowercased content, so the figure scales with corpus bytes).

**Logs are deliberately *not* indexed.** They're ~9/10 of the corpus bytes (tens of MB) and rarely searched, so caching them would cost ~100 MB+ for little gain. They stay on-disk-scanned, and only when `logs` is in scope. The renderer's default **All** filter forwards the four indexed Markdown scopes (`ALL_SCOPES` in `src/renderer/search-modal.tsx`), **not** "everything" — so a default query, like any scoped Markdown query, is served entirely from RAM in single-digit-to-tens of milliseconds; the log disk-scan runs only when the user picks the **Logs** filter. (History: search re-walked the *whole* tree on every query through v4.31.0; at a few hundred Markdown files that was a handful of ms, but a conception with thousands of files + large logs pushed per-query cost past 1 s — the index landed in v4.32.0. Through v4.32.0 the default All query still paid the ~1 s log disk-scan because it forwarded *no* scope; narrowing the default to the indexed sources closed that gap.)

## Terminal performance recording { #terminal-performance-recording }

`terminal.perf` is the user-facing toggle — **off by default**, flipped from **Settings → Terminal → Performance recording** or the **Performance** pane's Record button; the key row, the retention caps, and the "records are safe to delete" contract live in [Config files → Terminal perf](../reference/config.md#terminal-perf). This section is the deep dive: what each record carries, how the counters are meant to be read, and the `scripts/perf-load.mjs` harness for reproducing load deliberately.

### What a record carries

When enabled, condash appends one JSON record per sampling window (2.5 s — the same tick that drives
the per-tab memory meter; recording adds no timer of its own). Each record carries event-loop delay
percentiles for the main process and, per session, bytes and chunks read off the pty, time spent in
the OSC transcript scan, time spent in the disk logger's ANSI parse, grid-render time, the disk
log's flush cost with its compose / encode breakdown, coalesced IPC batches, backpressure pauses, and
the un-acked in-flight high-water mark.

**Cost and elapsed are different fields, and only one of them is a cost.** `syncFlushMs` is the time
a flush actually held the main thread — its synchronous stretches, summed — and is the field to weigh
against `loop.max`. It contains `gridRenderMs` (which still covers `GridBodyRenderer.render()` and
nothing else), `composeMs` (the file-text join) and `encodeMs` (the bookkeeping's second UTF-8
encode of the same text). `flushMs` and `writeMs` are **elapsed** across the xterm drain and five
libuv round trips, so they absorb whatever else the event loop is doing: the same 1 MB write measures
2 ms on an idle loop and 209 ms behind an unrelated 26 ms-per-turn block, which is roughly the
production median grid render. Use them for "how far behind the buffer did the log fall", never as
main-thread cost, and never subtract them from `loop.max` — a session's flush elapsed can be
dominated by a *different* session's work.

Two blocks beyond the terminal byte path ride the same record:

- **`main`** — spans for work outside the byte path (`dashRecentText`, `dashProvenance`,
  `transcriptRead`, `repoRecompute`, `gitStatus`, `gitUpstream`, `gitDetails`), `ipcMain.handle`
  dispatch time bucketed by channel, and GC pauses. **Only `transcriptRead` and `dashRecentText` are
  synchronous end to end**; every other span is elapsed wall time, mostly subprocess or network wait
  during which main is free, so read them as "this was in flight", not as delay to subtract. The
  spans also **nest** — `repoRecompute` contains `gitStatus` and `gitUpstream`, `dashRecentText`
  contains `transcriptRead` — and concurrent same-name spans overlap, so summing them double-counts.
  `ipc.*.ms` is elapsed too, attributed to the window the handler *finished* in, and may exceed
  `windowMs` (an LLM-backed handler is seconds long); the instrument's own `perfRendererReport`
  channel is deliberately not timed. GC is reported as `{n, ms, maxMs}` **whenever the runtime can
  observe it** — an absent `gc` block means unobservable, `n: 0` means no collection.
- **`renderer`** — the renderer's own event-loop delay (computed by the same shared function main
  uses, so the two are comparable), animation-frame counts including long frames, spans for the
  visible tab's `term.write`, the tab-switch replay burst, the demote `serialize()`, the worker RPC
  round trip and the mount, counters for demotes / promotes / RPC failures / writes into a collapsed
  Code-pane row, and peaks (`maxima`) such as the transition buffer's depth. The write spans close on
  xterm's completion callback, since `term.write` only queues the parse — they are elapsed until
  processed, an upper bound on block time. The renderer drains on its own 2.5 s timer and sends **one
  message per drain, and nothing at all for an empty window** — never per frame. `reports` says how
  many drains merged into the window; counters sum, peaks take the max, and the loop percentiles are
  the worst of them, never an average.

**Renderer loop delay excludes hidden time.** Chromium throttles renderer timers to about 1 Hz while
the window is occluded or minimised (`backgroundThrottling` is on), which would otherwise fill the
file with ~990 ms "stalls" that never happened for as long as you look at another window. Samples
taken while the page is hidden are discarded; `renderer.hiddenMs` says how much of the window was
unmeasured for that reason, and `renderer.samples` says how many probe samples the percentiles rest
on (~250 for a fully visible window). A window with a large `hiddenMs` is partly unmeasured, not
quiet.

**Which windows are recorded.** Every window with anything to report: a session that moved bytes, a
timed span, an IPC dispatch, an observed GC, a renderer report carrying real activity, or an
event-loop delay of 5 ms or more. Only a window idle on all of those is dropped, which is what keeps
an idle app from writing a record every 2.5 s forever — the same 5 ms threshold governs the
renderer's decision to send at all, because if it reported unconditionally the main-side gate could
never fire. Until schema 3 the rule was "some session moved bytes", which discarded every stall that
had no terminal work in it — 20 % of the ≥ 100 ms stalls in the 2026-07 baseline. **Records from
before that change are not comparable**: a percentile taken over a schema-2 file is conditioned on a
tab having been busy. The `schema` field discriminates, and `scripts/perf-load.mjs` refuses to
aggregate across it.

The event-loop delay is the most directly useful figure: main is a single thread shared by every
terminal tab as well as git status, file watching, and all IPC, so its delay under load is the
clearest measure of UI stalls. It is reported as delay **in excess of the sampler's own 10 ms
interval**: `monitorEventLoopDelay` records the gap between its own timer firings rather than the
excess over the expected gap, so a raw reading has a floor equal to its resolution — an idle process
measures p99 ≈ 10.3 ms. Reporting that raw put a fixed ~10 ms on the headline figure for an idle app,
which is both the symptom under investigation and a plausible magnitude for it. Subtracting the
resolution is what makes an idle app read ~0. Delays genuinely below 10 ms are not resolvable and
read as 0.

### Reproducing load deliberately

To reproduce load deliberately rather than waiting for it, `scripts/perf-load.mjs` drives N tabs at a
controlled byte rate and reports the counters back — including an A/B of disk logging on versus off,
which isolates the cost of the logger's duplicate ANSI parse on the main thread.

`--profile` selects the **shape** of that load, which matters more than the rate. The disk logger
renders its grid body out of a headless xterm holding at most **5050 rows** and flushes every **5 s**,
reusing the previous flush's frozen prefix — so the figure that decides what a run can measure is
*new rows per flush against 5050*:

| `--profile` | Default rate | Rows per 5 s flush | Regime |
|---|---|---|---|
| `flood` (default) | `512k` | ~17 600 | **3.5× full buffer turnover** — worst-case saturation |
| `realistic` | `16k` | ~806 | **16 % of the buffer**, 84 % retained and reusable |

`flood` is unchanged and stays the right tool for stressing the byte path, but it emits one
10 924-character line per chunk, which wraps at 200 columns to 55 rows. At 64 chunks/s that replaces
the whole buffer three and a half times per flush, so nothing is ever retained — which makes any
optimisation that depends on retained rows invisible to it *by construction*. Measured 2026-07-23,
the v4.97.1 incremental grid render scores exactly zero improvement under `flood` and 1.4–1.6× under
`realistic`.

`realistic` emits 80–119-character lines (one grid row each) in bursts separated by idle gaps, from a
fixed seed so both arms of an `--ab` run see byte-identical input. Its default rate is deliberately
**not** the flood's: short lines at 512k would land ~25 795 rows per flush — 5.1× turnover, deeper
into saturation than the flood itself. It also forks about 100× less — the lines are literals and
`printf` is a shell builtin, so only the per-burst `sleep` forks, against the flood's ~2000 process
creations/second — which is why absolute constants read off `flood` are upper bounds rather than
measurements of the byte path alone.

Every rows-per-flush figure above is keyed to the rate you **request**, which is what the harness
computes and prints. The flood's post-base64 output is about a third higher (699 200 B/s at `512k`),
and the same arithmetic against *that* gives 34 401 rows and 6.8× — a different quantity, and one
the reference page quoted in place of the other until 2026-07-23.

#### Reading the ms-per-render figure

A grid render costs O(retained buffer size), so a render taken while the buffer is still filling is
not the same measurement as one taken after it is full. The profiles fill at very different speeds —
about 1.4 s for `flood`, about 31 s for `realistic` at 16k — so averaging across that boundary is a
systematic bias, and it runs in favour of whichever profile saturates first.

The harness therefore drops every pre-saturation window and reports **`gridRenderMsPerRenderSteady`**
as the headline, alongside the sample count it rests on. Below three post-saturation windows or four
renders it refuses to report one at all and says so loudly, rather than publishing a mean of two
samples. The unfiltered whole-run mean is kept beside it as `gridRenderMsPerRenderAllWindows`, named
for what it is. A `realistic` run therefore needs to outlast ~31 s by several flushes: 60 s is the
practical minimum, 120 s gives a comfortable series.

Measured 2026-07-23 on one tab, matched pairs at 60 s and 120 s:

| Profile | Steady ms/render | Whole-run ms/render | Delivered vs nominal |
|---|---|---|---|
| `flood` @ `512k` | 53.5 / 54.0 | 49.1 / 51.7 | 84 % |
| `realistic` @ `16k` | 11.7 / 10.8 | 8.7 / 9.6 | 99 % / 100 % |

That is **4.6–5.0× at steady state**, where the unfiltered means would have read 5.7× and 5.4×.

**The ratio is not decomposed here, and should not be.** The two profiles differ in at least four
ways at once — rate (32×), rows per line (55×), fork rate (114×), and steady versus bursty output —
and a control run cannot vary them independently, because `floodCommand` derives its chunk size from
the rate, tying line width to turnover. The observed ratio is the combined effect of all of them.

#### What `realistic` does and does not represent

It is a **floor** on the grid renderer's cost for a **non-cooperating** tab, not a portrait of a
typical one:

- Neither profile emits anything but printable ASCII and newlines — no alternate screen, no `RIS`,
  no `\r` progress bars, no `CSI L`. So `GridBodyRenderer.invalidate()` and the marker-anomaly path
  are never exercised and the frozen prefix is never dropped mid-run. Real tabs run TUIs and spinners
  that do exactly that, and pay more than this.
- `SessionLogger.flushNow` writes the **transcript** body whenever the session has one, and falls
  back to the grid only otherwise. Cooperating agent tabs emit their transcript in-band over OSC and
  so never reach `GridBodyRenderer` at all. The grid path serves non-cooperating tabs, and that is
  the population these figures describe.

The per-tab byte rate the harness prints is a **nominal ceiling** — after base64 expansion for the
flood, before delivery — not a measurement of what reached the app. Emitting output takes wall-clock
the fixed `sleep` never subtracts, so the loop always runs slower than its own arithmetic: a flood
run printing 682.8 KB/s delivered 566 KB/s, which is the documented fork overhead. The summary
reports what actually arrived as a percentage of that ceiling and warns outside 70–105 %, so a
one-liner that silently failed to run cannot exit 0 behind a plausible-looking summary.

The harness runs against a **throwaway user-data dir and conception** under `/tmp`, and asserts that
isolation in the main process before applying any load — so it never touches your real
`settings.json`, never floods your conception's log store, and never shares a perf JSONL with a
running instance. It also refuses to start a run larger than 12 tabs, or one whose estimated working
set exceeds available memory, unless `--force` is given — per-tab caps are per tab, and the
documented field failure is whole-machine pressure, which they do not prevent.

Every other precondition is asserted at runtime too, and none of the assertions is ceremony. A
harness that measures other software turns an unverified assumption into plausible **false data**
rather than a crash, so each one has already caught a real defect: the isolation check caught
`--user-data-dir` being silently overridden by the dev-mode `userData` redirect; the renderer check
caught the app booting against a Vite dev server nobody had started, which left a dead renderer and a
run that exited 0 with numbers off by up to 9×; and the GC-record count caught `--trace-gc` output
going to **stdout** while only stderr was captured, so `gc.log` had never held a single GC record.
Requires a current `npm run build` — both the main bundle and the renderer bundle.

### Renderer CPU profile { #renderer-cpu-profile }

Every counter above lives in the **main** process. `--renderer-profile` adds the one measurement the
line never had — a CPU trace of the **renderer main thread** under the flood — by attaching a CDP
`Profiler` to the renderer page (`page.context().newCDPSession(page)`, then `Profiler.enable` /
`setSamplingInterval` / `start` … `stop`) around the flood window and writing a `.cpuprofile` beside
`perf.jsonl`. It is a flag, not a sibling script, on purpose: the one property the harness exists to
guarantee is isolation, so the renderer trace reuses the same sandbox, launch env, runtime assertions,
memory guard and tab ceiling literally in place rather than re-deriving them. Opt-in and incompatible
with `--ab` (a profile is a single trace); `--profiler-interval` sets the sampling interval in
microseconds (default 250, finer than V8's 1000 so the OSC/clone/parse split resolves).

The trace is **asserted real** before it is trusted — a profile with no samples, or one whose samples
are all synthetic `(idle)`/`(program)`, means the profiler never attached to a busy renderer, and the
run fails loudly rather than reporting a clean-looking empty trace (the exact hole `--trace-gc` hid).
It also asserts the hidden-tab path is actually engaged: in the sandbox the terminal pane opens on the
terminal view, so spawning N tabs leaves **one** visible DOM Terminal and demotes the other N-1 into
the shared worker — and a demote **removes** the tab's DOM element, so `.xterm` collapsing to 1 is the
runtime proof that the F7/F8 double-copy path is live. Rank a written profile with
`node scripts/analyze-cpuprofile.mjs <file.cpuprofile>`, which aggregates self-time by function.

What it reaches: **F7/F8** (the hidden-tab worker feed and the F8 IPC-deserialize-then-postMessage
double copy, both on the renderer main thread). What it does not: **F6**, whose Code-pane run rows need
a code-side session from a repo's Run button that the all-`my`-side flood cannot stage — scoped out
rather than faked. The Profiler sees the page main thread only; the worker thread's own parse of the
hidden tabs is a separate context, which is fine, because F8's claim is about the **main-thread** copy
cost specifically. Measured 2026-07-23 under an 8-tab flood at machine load ~7.5 (a sampling profile is
proportional, so self-time **shares** stay interpretable even though absolute ms are inflated by OS
descheduling): among named renderer JS work, xterm ANSI parse/render of the single visible tab is
~5.7 s and the F8 structured-clone/postMessage path is ~0.2 s — a ~28× gap. **F8 is real in the code
but negligible in cost** (a data-transfer bound puts the two copies of 160 MB at tens of ms of memcpy),
so it is refuted as a bottleneck; the worker offload the architecture pays for is precisely what keeps
the main thread parsing one tab instead of eight.

## Why Electron, not Tauri

The Tauri lineage (now at [vcoeur/condash-tauri](https://github.com/vcoeur/condash-tauri)) used the OS's native webview — smaller binaries, no bundled Chromium update cycle. Electron costs ~80 MB more per platform. Why we switched:

- **Renderer parity.** Tauri shipped three webviews (WebKitGTK on Linux, WKWebView on macOS, WebView2 on Windows), each with subtly different CSS and JS quirks. Electron ships one Chromium everywhere — every per-OS branch in the renderer disappeared overnight.
- **node-pty.** The terminal pane uses `node-pty`. In Tauri we re-implemented the lifecycle in Rust; in Electron we use the same library the rest of the Node ecosystem already battle-tests.
- **electron-builder.** Single tool for all four installer formats (.AppImage, .deb, .dmg, .exe), plus `latest*.yml` channel files for `electron-updater`. Tauri's bundler pipeline was three different paths — `linuxdeploy`, `hdiutil`, WiX.
- **Maintenance.** A single-developer project pays a high cost for cross-language complexity. Keeping the entire stack in TypeScript halves the surface to keep current.

The trade-off — install size + manual chrome-sandbox handling on AppImage — is documented in [Install](../get-started/index.md#install).

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

esbuild bundles main + preload into single CJS files. Native modules (`electron`, `node-pty`) are kept external — they have to load from `node_modules` so `electron-rebuild` can reach them. Pure-JS deps, including ESM-only libraries (chokidar 4 and friends), are inlined.

`tsc` no longer emits — esbuild owns emission, tsc owns type-checking. `make typecheck` runs `tsc --noEmit` against `tsconfig.main.json` and `tsconfig.renderer.json`.

The renderer bundle ships in the asar at `dist/`. The dev server (`vite`) listens on `localhost:5600` and the dev Electron loads from there, with HMR; production loads from disk via `file://` URLs.

## What's deliberately *not* an invariant

- **Log search index.** The Markdown sources are indexed in RAM ([above](#search-index)), but logs stay scanned on disk — and only when the **Logs** filter is selected (the default All query is index-only) — because they're the bulk of the bytes and rarely searched.
- **Worker isolation.** Mutations and parses run on the main-process event loop. The largest file is a project README (kilobytes); the parse is microseconds.
- **Authentication / authorisation.** condash is single-user, local-only. There is no user model.
- **Cross-process diagnostic logging.** Main and renderer write to their own console streams; there is no aggregator and no *diagnostic* log file. condash does write other files under `.condash/` — terminal-session transcripts (`terminal-logger.ts`, opt-in under `terminal.logging.enabled`) and perf counters (`perf-log.ts` → `.condash/perf/YYYY-MM-DD.jsonl`, opt-in under `terminal.perf.enabled`) — but those record the *child processes*, not condash's own diagnostics. A main-process stack trace still only exists on stderr.

## See also

- [`src/shared/api.ts`](https://github.com/vcoeur/condash/blob/main/src/shared/api.ts) — the IPC contract, source of truth.
- [`src/main/mutate.ts`](https://github.com/vcoeur/condash/blob/main/src/main/mutate.ts) — re-export barrel over the split mutation modules: `mutate-steps.ts` (checklist edits), `mutate-status.ts` (status + timeline), `write-config.ts` (note/config writes), `mutate-shared.ts` (EOL detection + per-file queue).
- [`src/main/terminals.ts`](https://github.com/vcoeur/condash/blob/main/src/main/terminals.ts) — pty lifecycle + the kill pipeline.
- [`src/main/git-status-cache.ts`](https://github.com/vcoeur/condash/blob/main/src/main/git-status-cache.ts) — the TTL cache.
- [`src/main/git-concurrency.ts`](https://github.com/vcoeur/condash/blob/main/src/main/git-concurrency.ts) — the read-only git-lookup cap.
- [`src/main/watcher.ts`](https://github.com/vcoeur/condash/blob/main/src/main/watcher.ts) — chokidar wiring + event classification.
- [Non-goals](non-goals.md) — what condash deliberately doesn't do.
