---
title: Internals · condash explanation
description: How the Electron build is wired — the three processes, the IPC contract, the watcher, the write pipeline, the kill chain. Aimed at contributors and operators rather than users.
---

# Internals

> **Audience.** People who already know what condash does and want to know *how*. If you're trying to use the dashboard, [Get started](../get-started/index.md) is the right entry point.

## What condash is

A thin layer above the conception convention. It reads the live `<conception>/projects/`, `knowledge/`, `resources/`, `.claude/skills/`, and `.condash/settings.json` tree, presents it through three slots — Projects (left edge), one of Code / Knowledge / Resources / Skills / Logs in the working slot (right edge, mutually exclusive), Terminal (bottom). Search is a global modal opened with `Ctrl+Shift+F`, not a pane. The user can *navigate* and *edit Markdown in place*; code is not edited inside condash, and running dev servers are supervised through embedded ptys (with optional disk capture under `.condash/logs/`).

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

`git-status-cache.ts` caches per-working-tree dirty counts for 3 s. The Refresh button calls `invalidateAll()` before re-reading, so an explicit user request always sees fresh data. Ambient re-renders (pane switch, tree-events) hit the cache.

The 3 s window is short enough that staleness is invisible to a human; the cache only matters when chokidar fires a burst of events or the user mashes Refresh.

### 4. PTY kill pipeline { #pty-kill-pipeline }

`terminals.ts:stopSession` runs the same sequence for every session terminate, including `killAll` on window close:

1. SIGTERM the pty's process group (negative pid). node-pty allocates a session leader (setsid), so the signal reaches `make dev` → `vite` → child workers.
2. If the entry has a `force_stop:` configured, run it (shell). Failures are swallowed — the SIGKILL fallback covers them.
3. Wait 500 ms.
4. If the leader is still alive, SIGKILL the process group.

`killAll` bounds aggregate runtime to ~1 s for the kill sweep, then awaits each session logger's final flush + close (bounded ~1.5 s) so quit can't drop the transcript tail or the exit footer; the quit handler `preventDefault`s and awaits it before letting Electron exit.

The headless task scheduler (`task-scheduler.ts`) has its own kill path for timed-out or user-killed scheduled runs: straight SIGKILL, with a `137` exit footer stamped on the run log before the logger closes. The boot-time orphan-seal sweep covers `.condash/logs/` and the task-run trees (`.condash/scheduled/`, `.condash/manual/`) alike.

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

- **Scalar push** — `dirty` count and `upstream` status changes flow as `repo-dirty` / `repo-upstream` events. Per-repo chokidar watches the worktree root + most `.git/*` paths; debounce 500 ms; renderer applies path-shaped `setRepos` writes that touch one cell each. Open dropdowns and popovers stay alive.
- **Set membership** — worktree add/remove and primary checkout branch switch flow as `repo-worktrees-changed { repoPath }`. A second per-primary watcher on `.git/HEAD` + `.git/worktrees/` fires this; debounce 250 ms; renderer responds with `listReposForPrimary` (per-primary partial reload) merged via `reconcile({ key: 'path' })`. Open popovers still survive thanks to the `path`-keyed reconcile contract. `git worktree remove` of the *last* worktree unlinks `.git/worktrees/` itself, killing the inotify watch beneath chokidar; the structural handler detects `unlinkDir` on that path and immediately rebuilds the watcher (close + `mkdirSync` + fresh `chokidar.watch`) so the next add isn't silently missed.

F5 / View → Refresh fans out across **every working surface** (`reloadAll` in `src/renderer/hooks/use-conception.ts`): it drops the git-status TTL cache, then reloads projects (which also refreshes the derived Deliverables view), knowledge, resources, all four skill tabs, agents (the spawn-dropdown list), tasks, and logs, and calls the full `reloadRepos()` so any out-of-app worktree mutation is visible immediately. The agents list and the tasks pane own their own `createResource` and logs pushes a refresh through a deferred signal, so those three are kicked synchronously rather than awaited alongside the store reloads.

### 7. IPC contract

`CondashApi` in `src/shared/api.ts` is the *whole* IPC surface. The preload (`src/preload/index.ts`) implements every verb as a one-line `ipcRenderer.invoke`; the main process registers one handler per verb. `src/main/index.ts:registerIpc` is a thin dispatcher that calls each per-domain module under `src/main/ipc/` (`projects.ts`, `trees.ts`, `repos.ts`, `settings.ts`, `system.ts`, `terminal.ts`). No string-mux'd actions, no implicit channels.

**`listProjects` projection.** `listProjects` returns the same `Project[]` shape as `getProject`, but with the potentially large `timeline[]` **emptied** on every row (`toListProjection` in `ipc/projects.ts`) — the array grows with a project's age, and multiplied across hundreds of resident projects + every reload's structured-clone it was a real long-session cost (review G1). The single timeline datum the card needs — the most recent entry's date — is precomputed at parse time as `Project.lastActivity` (kept on the row). The **preview** is the only surface that renders the full `timeline[]`, and it lazy-fetches the full project via `getProject` (a parse-cache hit, so effectively free) when it opens. The tree-events single-card patch strips the timeline the same way so the resident list stays uniformly timeline-free.

Subscriptions (`onTreeEvents`, `onTermData`, `onTermExit`, `onTermSessions`) return an unsubscribe function; the renderer holds it and calls it from `onCleanup`.

### 8. In-window drag uses pointer events, not HTML5 drag-and-drop

On Wayland sessions condash forces the native Wayland Ozone backend for crisp fractional-scaling text (`src/main/index.ts`). Chromium's HTML5 drag-and-drop (`draggable` + `dragstart` / `dataTransfer`) is broken under that backend — drags silently no-op ([electron#49907](https://github.com/electron/electron/issues/49907), [electron#42252](https://github.com/electron/electron/issues/42252)) — so any in-window drag must be built on **pointer events** (`pointerdown` / `pointermove` / `pointerup` + `setPointerCapture`), never HTML5 DnD. The pattern: capture the pointer on the source element once movement crosses a small threshold, never reparent the captured element mid-gesture, follow the cursor with a `pointer-events: none` clone, and commit on `pointerup` (hit-test the drop target with `elementFromPoint`). The Projects-pane status drag (`src/renderer/panes/projects-parts/cards.tsx`) follows this. **Still on HTML5 DnD and therefore broken on Wayland:** terminal-pane tab reorder (`src/renderer/terminal-pane/drag-drop.ts`) and settings-modal repo/section reorder (`repo-row.tsx`, `section-row.tsx`) — convert them the same way when next touched.

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
- **Dark palette has a single source.** The dark colours are defined once as a private `--dark-*` set on `:root` in `styles.css`. The two activation paths — `@media (prefers-color-scheme: dark) :root:not([data-theme='light'])` for the `system` theme (which removes `[data-theme]`, see `use-theme.ts`) and `[data-theme='dark']` for the explicit toggle — only **remap** the public tokens onto the `--dark-*` values; they carry no hex literals, so there is nothing to keep in lock-step. Edit a dark colour in the `--dark-*` block only.
- **Semantic + preview tokens are defined, never faked via fallbacks.** `--danger` (→ `--warn`) and `--text-dim` (→ `--text-faint`) are real aliases onto the palette, and the Settings terminal-preview sample palette is a defined `--preview-*` set (a fixed Tokyo-Night sample, deliberately theme-independent). Reference tokens directly; do **not** write `var(--made-up-token, #literal)` — an undefined token with a hardcoded fallback silently diverges from the palette.
- **Shared shape primitives.** `primitives.css` holds `.section-header` (the uppercase label · count · rule bar) and `.pill` (the rounded-chip geometry shared by `app-pill`, `repo-status-badge`, `tree-special-badge`, `search-source-pill`, …). The pill base is applied via a grouped selector so existing badges inherit the geometry with no markup change; a new badge should add the `pill` class and keep only its colour/padding/font on its own class. Restyle "all pills" or "all section headers" from the one base, not per-pane.
- **Action framework.** Buttons are a single vocabulary in `actions.css`, rendered by the `<Button>` / `<IconButton>` / `<ActionBar>` wrappers in `actions.tsx` so call-sites name the **role**, not the chrome. Roles: `.btn--primary` (the one committing action — filled accent, adaptive `--bg-elevated` text), `.btn--default` (neutral / cancel), `.btn--ghost` (chromeless text action), `.btn--danger` (quiet destructive), with `.btn--sm` / `.btn--icon` (`--btn-size` / `--btn-icon`) modifiers and `.btn--active` for a pressed toggle. A `data-tone` attribute keys colour off the **verb** — `open`/`add` → accent, `work`/`run` → `--col-running`, `stop`/`danger` → `--warn` — so a verb reads the same in every pane (on an icon it colours the hover; on a primary it recolours the fill for a destructive commit). `.action-bar` is the footer commit/cancel row (cancel left, primary right; `--split` pushes a lone destructive far-left). `.seg` / `.seg-item` (`--sm`) is the segmented toggle. A new action picks a role + tone; it does not mint a per-pane button class. The 32 px modal-head icon button (`.modal-button`, modal-base.css) is the head-bar sibling of `.btn--icon`: its own layout idiom, but it carries the same `data-tone` hover cues, so an "open external" in a modal head reads accent like the same verb in a pane row. **Icon vocabulary:** one close glyph (`IconClose` in `icons.tsx`) backs every modal close — shell, settings, note, preview — and one disclosure caret (`<Caret expanded>` + `ChevronIcon`, rotated by `.caret-icon` in primitives.css) backs every collapsible header / row / tree folder. Don't hand-render a `×` or a `▸`/`▾`; reach for these. The dropdown-trigger caret (`ChevronDownIcon`) is deliberately distinct from the disclosure caret — a menu trigger is not a twisty.

### 12. Component split threshold + the `*-parts/` layout { #component-parts }

A renderer pane or modal `.tsx` that grows past **~400 LOC**, or that holds more than one sub-component, is split into a sibling `<name>-parts/` directory rather than left as a monolith. The keep-file (`<name>.tsx`) keeps the public component and the orchestration — the signals, the IPC calls, the create/edit/save/delete flow — and imports the rest from `<name>-parts/`. The threshold is a smell, not a hard gate: a single-responsibility file that is long because the problem is inherently detailed (the index-tree parser is the canonical case) stays whole; the trigger is *multiple concerns in one file*, which length usually signals.

The sub-file vocabulary is fixed so a reader can predict the layout:

- **`data.ts`** — pure logic + types + constants, dependency-free (no Solid, no `window.condash`), so it unit-tests directly. It carries a sibling **`data.test.ts`** (vitest, picked up by `src/**/*.test.ts`). Extracting the pure helpers into `data.ts` is what makes the decomposition testable — the monolith's logic was reachable only by driving the whole component in Playwright.
- **`icons.tsx`** — pane-specific SVG glyphs (only genuinely local ones; shared glyphs live in `src/renderer/icons.tsx`).
- **One presentational `.tsx` per sub-component**, named for what it renders (`task-editor.tsx`, `task-fill.tsx`, `task-running.tsx`, `badges.tsx`).

Existing `-parts/` dirs: `panes/projects-parts/`, `panes/code-parts/`, `panes/tasks-parts/`, `settings-modal-parts/`, `note-modal-parts/`, `project-preview-parts/`. A sub-component that *is* a modal renders through the shared `<Modal>` shell (invariant 10) — it does not hand-roll a backdrop/header. `settings-modal.tsx` is the one pane still over the threshold with a richer split owed (its Esc/save contract keeps it off the shared shell); decompose it further when next substantially touched.

### 13. Terminal WebGL contexts are pooled { #webgl-pool }

xterm's `WebglAddon` holds one GPU context per terminal, and condash eagerly mounts every open "my terms" tab (`terminal-pane/controller.ts` mounts each session, hidden ones included). Each open tab therefore used to hold its own live WebGL context; past the browser's ~16-context ceiling the GPU force-loses contexts and the addon's context-loss retry churns — the "slow with many terminals open" cliff. A shared LRU pool (`src/renderer/webgl-pool.ts`) now caps the number of live contexts (default 8): `mountXterm` registers each terminal's context as a pool slot, the terminal pane calls `MountedTerm.setVisible()` from `focusActive()` so the currently-shown tab(s) are protected and long-hidden tabs release their context (falling back to xterm's DOM renderer — no data loss), and re-showing a tab re-attaches a fresh context. The pool module is `@xterm/*`-free so it unit-tests under the node vitest env (`webgl-pool.test.ts`), mirroring the `prompt-decorations.ts` split. The addon's own `onContextLoss` rebuild still runs for genuine GPU resets, but only if the pool still wants that terminal live — recovery can't smuggle a terminal past the cap.

### 14. Hidden terminal tabs parse off the main thread { #terminal-worker }

Even with the WebGL pool, every open "my terms" tab used to run xterm's ANSI parser and scrollback bookkeeping on the renderer main thread whenever the pty produced output, including tabs that were not visible. With many long-running agent tabs this main-thread work bled into the rest of the UI (tab switching, Projects/Code panes). `terminal-pane/controller.ts` now keeps only the active tab(s) as real DOM Terminals; every other tab's output is fed to a headless `@xterm/headless` Terminal running in a dedicated Web Worker (`src/renderer/terminal-worker.ts`). When a hidden tab becomes active, the worker serializes its buffer (`@xterm/addon-serialize`) and the controller hydrates a fresh DOM Terminal from that snapshot. When an active tab becomes hidden, the DOM Terminal is serialized, its state is seeded into a new worker Terminal, and the DOM Terminal is disposed. Logging, `sessionData` tailing, and auto-close-on-exit are unaffected because they live in the main process or in the controller's own bookkeeping.

`SerializeAddon` round-trips a normal shell buffer faithfully, but it cannot perfectly reproduce a **live full-screen TUI** (Claude Code, opencode, any Ink or ncurses app) that repaints via relative cursor moves, scroll regions, colour-filled panels, and a bottom status line. Such a tab hydrates on switch-back into a badly garbled frame — for opencode the reconstructed buffer is essentially all wrong (right glyphs, lost background fills → black blocks). The fix is the **Refresh** action (`refreshSession` in `terminal-pane/controller.ts`, exposed as the tab-strip **Refresh** button and a tab context-menu item): it nudges the pty one row shorter and back (`term.resize` → `termResize` → two SIGWINCHes), which makes the running program redraw its whole screen. Scrollback is kept, and plain shells ignore the resize.

Two things make the nudge actually land, both learned from opencode never repainting no matter how often Refresh was pressed:

- **The hold must outlast the program's own resize debounce.** opencode (Bubbletea) coalesces resizes for ~100 ms, so it only ever samples the *current* pty size when its debounce fires. `REPAINT_NUDGE_MS` (160 ms) holds the intermediate `rows-1` size long enough that the program samples it and repaints, then samples the restored size and repaints again — two genuine deltas. At the old 80 ms the smaller size was gone before opencode looked, so the resize collapsed to a no-op and nothing was emitted.
- **A competing `fit()` must not restore the size early.** Every `syncVisibility` ends in `focusActiveDom`, which refits the active terminal; chained after the nudge it would snap the pty back to full height within a frame and collapse the dip regardless of the hold. The controller tracks nudging sessions in a `nudging` set and `focusActiveDom` skips refitting them; the nudge's own timeout does the restoring fit when it's done. `refreshSession` also skips re-asserting an already-active id, since that re-assert was itself a source of the competing fit.

Refresh runs automatically on switch for **live full-screen TUIs** — the only tabs whose hydrated frame is lossy. A `createEffect` diffs each column's active id against its previous value and, on a genuine switch to a different tab, calls `refreshSession(id, { onlyIfAltBuffer: true })`; `refreshSession` checks the tab's buffer type *after* it hydrates and nudges only when it's on the alternate screen buffer. It captures every switch path — tab click, keyboard move, focus-promote, cross-column drag, and the active tab being closed — because they all funnel through the same active-id signal. `terminal.autoRefreshOnTabSwitch` (Settings → Terminal → "Auto-refresh on tab switch") drops the alt-buffer condition so *every* tab, plain shells included, is repainted on switch. The repaint is deferred to a microtask so the effect never writes the active-id signal re-entrantly.

## Environment hygiene { #environment-hygiene }

condash spawns subprocesses (terminals, runners, `force_stop` commands, open-with launchers). The main process scrubs the environment before each spawn to avoid leaking interpreter-specific vars into unrelated child programs:

- `PYTHONHOME` / `PYTHONPATH` — leak from AppImage's stock `AppRun.wrapped`. A spawned `python3` would otherwise hit "No module named 'encodings'" because the leaked vars point into the AppImage mount.
- `PERLLIB` / `PERL5LIB` — same root cause; spawned `perl` scripts can't find their libs.
- `QT_PLUGIN_PATH`, `GSETTINGS_SCHEMA_DIR` — leak similarly; spawned GUI apps pick up the AppImage's bundled plugins instead of their own.

This is defence in depth. The AppImage build also patches `AppRun` itself (see [Install — Linux AppImage](../get-started/index.md#linux-appimage)) so the leak doesn't reach launchers spawned *outside* of condash either.

The inverse problem — a GUI launch *missing* entries the user put in their login dotfiles — is handled by `src/main/shell-env.ts`. A Wayland session, the macOS Dock, or a `.desktop` entry never sources `~/.profile` / `~/.zprofile`, so `process.env.PATH` lacks user-installed CLIs (`opencode`, `~/bin` wrappers). `spawnEnv()` resolves the login-shell PATH once at boot (`$SHELL -lic`, cached, 5 s timeout) the way VS Code's integrated terminal does, and replaces PATH on every spawned env. It rewrites **PATH only**, so the scrub above is untouched; on Windows and on any probe failure it falls back to the inherited PATH.

## The search index { #search-index }

The four Markdown sources (projects incl. notes, knowledge, resources, skills) are held in an **in-memory index** in the main process (`src/main/search/index-cache.ts`): each file's content, lowercased content, region map, and title are precomputed once at conception-open, so a query runs only the per-term `indexOf` + scoring over RAM strings — no per-keystroke re-walk / re-read / re-lowercase. The index is built fire-and-forget (never blocks boot; queries fall back to an on-disk scan until it resolves) and kept incrementally fresh by the chokidar watcher (`src/main/watcher.ts` → `applyIndexFsEvent`): an add/change re-prepares one file, an unlink drops it, and an `unlinkDir` drops every indexed entry under the removed directory by prefix. Events that arrive while a build is still in flight are buffered and replayed in arrival order once the build completes (dropped if a newer build supersedes), and concurrent events for the same file apply in arrival order via a per-path chain — so neither the boot/rebuild window nor a rapid edit burst can leave the index stale. ~16 MB resident at conception scale (each prepared file retains raw + lowercased content, so the figure scales with corpus bytes).

**Logs are deliberately *not* indexed.** They're ~9/10 of the corpus bytes (tens of MB) and rarely searched, so caching them would cost ~100 MB+ for little gain. They stay on-disk-scanned, and only when `logs` is in scope. The renderer's default **All** filter forwards the four indexed Markdown scopes (`ALL_SCOPES` in `src/renderer/search-modal.tsx`), **not** "everything" — so a default query, like any scoped Markdown query, is served entirely from RAM in single-digit-to-tens of milliseconds; the log disk-scan runs only when the user picks the **Logs** filter. (History: search re-walked the *whole* tree on every query through v4.31.0; at a few hundred Markdown files that was a handful of ms, but a conception with thousands of files + large logs pushed per-query cost past 1 s — the index landed in v4.32.0. Through v4.32.0 the default All query still paid the ~1 s log disk-scan because it forwarded *no* scope; narrowing the default to the indexed sources closed that gap.)

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
- **Cross-process logging.** Main and renderer write to their own console streams. There is no aggregator and no log file.

## See also

- [`src/shared/api.ts`](https://github.com/vcoeur/condash/blob/main/src/shared/api.ts) — the IPC contract, source of truth.
- [`src/main/mutate.ts`](https://github.com/vcoeur/condash/blob/main/src/main/mutate.ts) — re-export barrel over the split mutation modules: `mutate-steps.ts` (checklist edits), `mutate-status.ts` (status + timeline), `write-config.ts` (note/config writes), `mutate-shared.ts` (EOL detection + per-file queue).
- [`src/main/terminals.ts`](https://github.com/vcoeur/condash/blob/main/src/main/terminals.ts) — pty lifecycle + the kill pipeline.
- [`src/main/git-status-cache.ts`](https://github.com/vcoeur/condash/blob/main/src/main/git-status-cache.ts) — the TTL cache.
- [`src/main/watcher.ts`](https://github.com/vcoeur/condash/blob/main/src/main/watcher.ts) — chokidar wiring + event classification.
- [Non-goals](non-goals.md) — what condash deliberately doesn't do.
