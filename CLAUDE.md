# CLAUDE.md — condash (Electron)

Electron build of condash. As of 2026-04-27 this **is** the canonical condash — it lives at `vcoeur/condash` after the swap that moved the Tauri lineage to `vcoeur/condash-tauri`. The Tauri build remains buildable at that repo for as long as bug fixes are warranted.

## Stack

- **Main**: Node, TypeScript, **bundled with esbuild** (`scripts/build-electron.mjs`) to a single CJS file at `dist-electron/main/index.js`. Imports are inlined; ESM-only deps (chokidar 4, future libs) bundle to CJS transparently. Native modules (electron, node-pty, fsevents) stay external — they have to load from `node_modules` so `electron-rebuild` can reach them.
- **Preload**: same bundler, output at `dist-electron/preload/index.js`. Stays CJS because `webPreferences.sandbox: true` + ESM preload don't mix on Electron.
- **Typecheck**: `tsc -p tsconfig.main.json --noEmit` (and the renderer twin). `tsc` no longer emits — esbuild owns emission, tsc owns type-checking.
- **Renderer**: Solid + Solid signals, Vite (with `vite-plugin-solid`), plain CSS files + CSS variables, `src/renderer/main.tsx`.
- **Shared types**: `src/shared/types.ts` — plain serialisable objects, ISO strings, no methods.
- **Packaging**: electron-builder, single `BrowserWindow`, all modals/panes are in-renderer overlays.
- **Watcher**: single global chokidar rooted at `<conception>/`, debounced 250 ms.

### Adding a new main-process dep

1. `npm install <pkg>`. ESM-only is fine — esbuild bundles it as CJS.
2. If the dep is **native** (has a `binding.gyp` or ships prebuilt `.node` files — e.g. `node-pty`), add it to `scripts/shared/externals.mjs` (`SHARED_EXTERNALS`) so esbuild leaves it alone for both the Electron and CLI builds, and wire `electron-rebuild` if needed. Per-target externals (Electron-only or CLI-only) go in the per-script `EXTERNAL` array instead.
3. Pure-JS deps need no further work.

### Dependencies

#### `@xterm/*` beta pinning

The xterm v6 line only ships as `beta.NNN` prereleases on npm — there is no stable v6 yet. Every `@xterm/*` package therefore carries an **exact** pin (no caret), and all packages in the family must stay on the **same** `beta.NNN` minor so their internal peer ranges resolve. When bumping xterm:

- Pick the latest `beta.NNN` of `@xterm/xterm` and align every other `@xterm/*` package to the same `beta.NNN` in one commit.
- One known exception: `@xterm/addon-webgl@0.20.0-beta.NNN` declares a peer of `@xterm/xterm@^6.1.0-beta.(NNN+1)`, so the addon ends up one tag *behind* the rest of the family. This is upstream metadata, not a bug — accept the off-by-one until upstream tags catch up.
- `@xterm/addon-fit` and `@xterm/headless` still publish stable releases (`^0.11.0`, `^6.0.0`) and are excluded from the beta-pin sweep.

## Locked decisions

The load-bearing design choices — UI framework (Solid + Solid signals), styling (plain CSS files + CSS variables), IPC contract shape (single typed `CondashApi` in `src/shared/api.ts`), window architecture (single `BrowserWindow`, in-renderer overlays), data shape (plain serialisable objects in `src/shared/types.ts`), file-watching protocol (single global chokidar rooted at `<conception>/`, 250 ms debounce), config format (JSON: per-machine `settings.json` + per-conception `.condash/settings.json`, gitignored by default), and build tool (esbuild for main/preload, Vite for renderer) — are captured in this file and in [`docs/explanation/internals.md`](docs/explanation/internals.md). Treat them as locked: changing any of them is a PR with a dated rationale in the commit message, not a silent in-flight edit.

## Dev ports

- **5600** — Vite dev server.
- **5601** — Vite preview.
- Both `strictPort: true`. Defined in `vite.config.ts`. The numbers are picked from a 56xx block to stay clear of common defaults (3000, 5173, 5432, 8000, 8080) and of sibling vcoeur apps that bind their own host ports during dev.

When changing the dev port, update **every** file:

- `vite.config.ts` — `server.port`, `preview.port`.
- `Makefile` — `DEV_PORT`, `PREVIEW_PORT`.
- `src/main/index.ts` — `DEV_URL`.
- `src/renderer/index.html` — CSP `connect-src` (HMR websocket).
- `package.json` — `dev:electron` `wait-on tcp:<port>`.
- This file.

## Commands

| Command | What it does |
|---|---|
| `make install` / `npm install` | first-time install |
| `make dev` / `npm run dev` | watch mode: tsc + vite + electron |
| `make build` / `npm run build` | compile main + renderer |
| `make package` / `npm run package` | electron-builder installers (Linux/macOS/Windows) |
| `make test` | build, then the Playwright suite (headless via `xvfb-run` when present) |
| `make test-headless` | build, then Playwright under `xvfb-run` (no window; errors if `xvfb-run` absent) |
| `make test-visible` | build, then Playwright with the window visible (watch the run) |
| `make test-unit` / `npm run test:unit` | vitest unit suite |
| `make typecheck` | tsc on both projects, no emit |
| `make format` | prettier on `src/` |
| `make kill` | free port 5600 |
| `make clean` | remove `dist/`, `dist-electron/`, `release/` |

## Configuration

- **Per-machine**: `${XDG_CONFIG_HOME:-~/.config}/condash/settings.json`. Owned by Electron's `app.getPath('userData')`, derived from `package.json`'s `name` field. JSON only. Sole owner of `lastConceptionPath` + `recentConceptionPaths` (cap 5); also carries global defaults for every workspace key.
- **Per-conception**: `<conception>/.condash/settings.json` (canonical). The whole `.condash/` directory is fully gitignored by default — settings included — so it carries per-host state with no commit-leak risk. Two legacy paths still read as fallbacks: `<conception>/condash.json` (old canonical) and `<conception>/configuration.json` (legacy²). Writes always target `.condash/settings.json`. The auto-migrator (`src/main/condash-dir-migrate.ts`) copies legacy content on first open, tombstones the source file, and appends `.condash/` to `.gitignore` when the conception is a git repo. `condash config migrate` exposes the same operation explicitly.
- **Per-conception logs**: `<conception>/.condash/logs/YYYY/MM/DD/HHMMSS-<sid>.txt`. **One single plain-text file per pty spawn** since v2.27.0 — no sidecar, no compression. Metadata travels inside the `.txt` as two `# condash: {...}` JSON lines: a header line at the top (always present, carries `{sid, side, repo?, cwd, cmd, argv, started}`) and a footer line at the bottom (only after `exit()`, carries `{finished, exitCode}`). `cat foo.txt` shows the metadata too. Gitignored alongside `settings.json`. **Opt-in** since 2.25.0 — `terminal.logging.enabled` defaults to `false`; flip it in `Settings → Terminal → Logging` to start recording. The pref is read once at session-start (writer construction). The writer (`src/main/terminal-logger.ts`) pipes pty bytes into a headless xterm (`@xterm/headless`), every 5 s renders the buffer row-by-row via `IBufferLine.translateToString(true)` (plain text — no SGR, no CSI, no cursor-forward), composes header + body (+ footer if exited), and atomically rewrites the `.txt`. Flushes are serialised through `flushChain` so `close()` can await every pending write before disposing the xterm. `in` keystrokes are *not* captured — the pty echoes them back through `out`. Session size is bounded by xterm scrollback (`terminal.logging.scrollback`, default 10000 lines); no rotation. Janitor (`src/main/terminal-logger-janitor.ts`) (1) evicts day-directories past `terminal.logging.retentionDays` (default 14), (2) evicts oldest-first while over `terminal.logging.maxDirMb` (default 500); runs at startup + every 24 h. The Logs working surface (`Cmd+Shift+L`) is now a **collapsible card grid grouped by date** (`src/renderer/panes/logs.tsx`) — each session is a card showing time · repo · cmd · exit · size in a responsive grid sized by `cardMinWidth.logs`. Grouping: the last 7 days each get a collapsible `<details>` day group (today is rendered as a static, always-expanded block — no toggle); older days fold into collapsible per-month `<details>` groups, each with a light day sub-header. Collapse state is native `<details>` (not persisted), so today is always expanded on open. Partition is pure-render off the `logsListDays` list (string day-compare against a 7-day cutoff); no IPC change. Clicking a card opens `LogsViewerModal` (`src/renderer/logs-modal.tsx`): a full-overlay viewer with a virtualised plain-text transcript (fixed-row-height windowing over `lines.length * --logs-row-height` via an absolutely-positioned slice), a search box that pre-computes per-line hit indices and scrolls the active hit into view, and `Esc` to close. Long lines horizontal-scroll (no wrap) so the virtualizer's fixed-row-height math holds. Logs are also a source in the global search modal — `src/main/search/walk.ts:collectLogFiles` walks `<root>/YYYY/MM/DD/*.txt`; `src/main/search/match.ts` strips the `# condash:` header / footer lines via `splitContent` (exported from `src/main/logs-format.ts` — the pure-parsing module shared between the renderer-side `ipc/logs.ts`, the writer in `terminal-logger.ts`, and the CLI's search command; carved out so the CLI bundle's import graph doesn't touch `electron` or `@xterm/headless`) before substring matching, so snippets don't quote the JSON. Activating a log hit posts a `LogsOpenRequest` that opens the modal directly. Legacy `.jsonl` files from condash ≤ 2.22 and `.txt.gz` from 2.23–2.26 are ignored by the viewer — the janitor evicts them by age.
- `CONDASH_CONCEPTION_PATH` env var override: wired in both Electron (`src/main/settings.ts`) and CLI (`src/cli/conception.ts`). See [`docs/guides/configure-conception-path.md`](docs/guides/configure-conception-path.md) for the resolution chain. The conception-detector accepts any of the three recognised config files when validating a candidate path.
- The merge resolver lives in `src/main/effective-config.ts`. Every reader (`repos.ts`, `worktree-ops.ts`, `launchers.ts`, `audit.ts`, `terminals.ts`, `conception-paths.ts`, the CLI's `config` verbs) goes through it.
- **App identity = the `@handle`.** Every app has one canonical handle: an explicit `handle` on a `repositories[]` entry, else `appHandle(name)` (the directory name, `@`-stripped + lowercased). `src/shared/app-color.ts` owns the single `appHandle()` normaliser — it replaced three divergent rules (colour, search slug, code-card title); both card pills now render `@handle` coloured by handle (`RepoEntry.handle`, set in `repos.ts` from `RepoLookup.handle` in `config-walk.ts`). A repo entry may omit `name` when it gives a `path` (dir name = `basename(path)`), and may carry `aliases` (legacy spellings). Defunct handles live in the top-level `retired_apps` list — validated against, never rendered. `src/main/applications.ts` backs the `condash applications` CLI (`list`/`add`/`set`/`rename`/`sync-docs`/`validate`); `sync-docs` regenerates the Apps table in the conception's `AGENTS.md` between `<!-- condash:apps:start|end -->` sentinels (CLAUDE.md and the other agent-specific files are virtual agedum renders of AGENTS.md — never written to disk, never hand-edited), `validate` checks every project README `apps:` resolves to a known handle or an existing path.
- **Merge rule**: top-level replace for every key, with **one exception**: `terminal` merges one level deep so a conception customising `terminal.logging` keeps the per-machine `terminal.screenshot_dir` / shortcuts. The exception is documented in `docs/reference/config.md` and tested in `effective-config.test.ts`.
- **Agents** are a flat `{ id, label, command }` list under the top-level `agents` key of the effective config (`agentSchema` in `src/main/config-schema.ts`, part of `sharedSchemaFields` so a conception's `.condash/settings.json` overrides the per-machine `settings.json` defaults). Each is a terminal launcher: picking it opens a new tab running `command`. There is **no** per-file store, no harness model, and no secret store — a launched command inherits the terminal's ambient environment, so provider/model wiring lives in the command (often a `~/bin` wrapper script). `src/main/agents.ts` is a thin reader: `listAgents(conceptionPath)` returns the config's `agents`, skipping rows with a blank `id` or `command` (half-filled Settings-editor placeholders); IPC is the single `listAgents` verb (`src/main/ipc/agents.ts`). The shared type is `Agent` in `src/shared/types.ts`. Agents are edited via the **Agents** section of the Settings modal (`src/renderer/settings-modal-parts/sections-agents.tsx`) — an inheritable dual-tab section (Global + Conception, like Appearance/Terminal), a vertical list of `{label, command, id}` cards with add / remove / move-up-down (no DnD — Wayland-Ozone HTML5 DnD is broken). There is no dedicated Agents pane or working surface. Blank-row survival mirrors repositories: `agentSchema` fields all accept `''`, and `buildSavePayload`'s `compactAgents` bypass keeps a `{id:'',label:'',command:''}` row clear of `pruneEmpty`. The tab-strip spawn dropdown (`terminal-pane/column.tsx`) lists `New shell` + each agent by `label`; selecting one spawns via `TermSpawnRequest.command = agent.command` (the existing command path in `terminals.ts` — no agent resolution). Migration: `migrateRawSettings()` still drops legacy `terminal.launchers` / `launcher_command` and renames an action-template `launcher` → `agent` (now an agent `id`). (History: a richer per-file harness subsystem — `<conception>/agents/<slug>.json` + `agents/.env` + claude/kimi/opencode/agentsconf spawn builders + an Agents pane — was removed in favour of this `{id,label,command}` model.)
- **Tasks** are reusable, parameterized agent prompts. A task references an agent (by `id`) + a markdown prompt with fillable `{markers}`, stored as one directory each at `<conception>/tasks/<slug>/`: `task.json` (`name` / `agent` (the agent's `id`) / `submit`) + a hand-editable `prompt.md` (prose stays in markdown, config in JSON — the conception "never mix shapes" rule). Loaded by `src/main/tasks.ts` (ENOENT-tolerant `listTasks` — `agentPresent` checks the `id` against the `agents` settings list — slug-validated writes via `isValidSlugTail`, idempotent `deleteTask`, `writeTask` rejects a rename onto an existing slug); IPC `listTasks` / `readTask` / `writeTask` / `deleteTask` (`src/main/ipc/tasks.ts`). The Tasks pane (`src/renderer/panes/tasks.tsx`) is a **left-band view** (`LeftView` adds `'tasks'`, ordered Projects · Tasks · Deliverables) — a responsive card grid sized by `cardMinWidth.tasks` (each card is click-to-edit and carries a single **Run…** button that `stopPropagation`s) + a **run popup** (pickers + prefilled fields + live preview → Run) + an **editor popup** with Save/Cancel + a `ConfirmModal`-confirmed Delete. Marker grammar + the `{APP_*}` / `{PROJECT_*}` reserved-token context builders live in `src/shared/tasks.ts` (`extractMarkers`, `appContext`, `projectTokenContext`); `substitute` (`src/shared/action-template.ts`) honours `{KEY:default}` as a fallback. Run reuses the agent-spawn-and-type path: `terminal-bridge.ts`'s `runTask(agentId, text, submit)` spawns a fresh tab running the agent's command (cwd = conception root), then types the substituted prompt and submits when `submit` is true (an agent is an opaque command, so the prompt is always typed via the pty after a settle delay). The editor's agent select stores the agent `id` and shows its `label`; a dangling `agent` id (removed from settings) is flagged on the card (`agentPresent`) and disables Run.

## Sandbox: dev vs. production

- **Dev** (`make dev`) — `dev:electron` passes `--no-sandbox`. Avoids the per-worktree `sudo chown root chrome-sandbox` ritual. The dev window only loads `http://localhost:5600` and local `file://` URLs, so the threat surface is local-only.
- **Production** (`make package`) — `electron-builder` SUIDs the helper at install time on `.deb` and AppImage; the sandbox is on for end users.

If you want the sandbox on during dev anyway: drop `--no-sandbox` from `dev:electron` in `package.json` and run once per worktree:

```bash
sudo chown root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

macOS and Windows are unaffected.

## Conventions

- Run `make format` after every code change.
- All UI must work without per-OS CSS branches (Electron + Chromium = same renderer everywhere).
- In-window drag must use pointer events (`pointerdown` / `pointermove` / `pointerup` + `setPointerCapture`), never HTML5 drag-and-drop — Chromium's Wayland Ozone backend (forced for crisp text on Wayland sessions) silently breaks HTML5 DnD. The Projects-pane status drag follows this; terminal-tab and settings-row reorder are still HTML5 DnD (broken on Wayland) until converted. See [internals invariant 8](docs/explanation/internals.md#8-in-window-drag-uses-pointer-events-not-html5-drag-and-drop).
- File-path conventions: every path crossing the IPC boundary is normalised to forward-slash form via `toPosix(p)` from `src/shared/path.ts`. Internal `fs` calls keep the native separator (use `path.join`); the renderer can then split on `/` without per-OS branches. Cross-OS shell wrapping (`bash -lc` / `cmd.exe /d /s /c` / `pwsh -Command`) lives in `src/main/terminals.ts`'s `wrapForShell`.
- Spawned-process PATH: every pty / child process condash spawns takes its PATH from `spawnEnv()` in `src/main/shell-env.ts`, which resolves the user's **login-shell PATH** once at boot (`$SHELL -lic`, cached, 5 s timeout) so GUI-launched condash (Wayland / macOS — no `~/.profile` sourcing) still finds user-installed CLIs (`opencode`, `~/bin` wrappers). PATH only; other vars keep inherited values so the env-hygiene scrub stays intact. Wired into `terminals.ts` (pty + `force_stop`) and `launchers.ts`; warmed in `index.ts` at `whenReady`.
- Renderer CSP carries `'wasm-unsafe-eval'` in `script-src` (`src/renderer/index.html`) for `@xterm/addon-image` — its Sixel decoder is WebAssembly, which Chromium refuses to compile under a bare `'self'`. The refusal throws inside xterm's synchronous write loop, blanking any terminal that receives an inline-image escape (e.g. the opencode TUI). `'wasm-unsafe-eval'` permits WASM compilation only, **not** JS `eval` / `new Function` — keep it; do not widen to `'unsafe-eval'`.
- IPC contract is the single typed `CondashApi` interface in `src/shared/api.ts`. Functions, not URLs. Promises for request/response; events only for chokidar push.
- Hard interaction-to-paint budget: **≤ 16 ms** for any user-initiated action. Optimistic UI is the default; rollback on IPC failure.

## Pointers

- **Public site**: [`condash.vcoeur.com`](https://condash.vcoeur.com) — built from `docs/` + `mkdocs.yml` by `.github/workflows/docs.yml` on every published release. Includes a signed apt repo at `condash.vcoeur.com/apt/`, indexed against the **most-recent `APT_HISTORY` releases** (5 by default; tune in `docs.yml` env). Older `.deb` assets stay reachable from each release's GitHub page; only the apt index is windowed.
- [`docs/index.md`](docs/index.md) — landing page of both the in-app Help menu and the public mkdocs site.
- [`docs/explanation/internals.md`](docs/explanation/internals.md) — invariants: drift checks, atomic writes, write queue, TTL cache, pty kill pipeline, IPC contract.
- [`docs/reference/config.md`](docs/reference/config.md) — `condash.json` + `settings.json` schema + per-key reference, including the override model.
- [`docs/explanation/non-goals.md`](docs/explanation/non-goals.md) — explicit non-goals; **read before adding "while we're at it" features**.

The in-app Help menu reads files out of the asar via the allowlist in `src/main/help.ts`. The allowlist carries six short names — `welcome`, `quick-start`, `shortcuts`, `configuration`, `cli`, `why-markdown` — each mapping to `docs/help/<name>.md`. Separate menu items link out to `condash.vcoeur.com` and the issue tracker via `shell.openExternal`. There is no separate copy at the repo root — the migration shipped in `v2.0.6`.

The first-launch **welcome screen** lives in `src/renderer/welcome-screen.tsx` and renders inside `workspace-center` when the conception path is set, the projects list is empty, and the knowledge tree is empty (and the user hasn't dismissed it). Dismiss state persists at `welcome.dismissed` in `settings.json` via the `getWelcomeDismissed` / `setWelcomeDismissed` IPC verbs.

The Code pane's **branch filter** (top-of-pane popover) shows every worktree by default; ticking branches narrows each card to "primary + ticked branches". Unticking everything returns to the default "show all" view. The primary worktree row (the checkout under `workspace_path`) is always rendered with a subtly tinted background. Hydration + persistence go through `createBranchFilterStore` in `src/renderer/branch-filter-store.ts` and the `getSelectedBranches` / `setSelectedBranches` IPC verbs (settings.json field: `selectedBranches`). Filter logic is the pure `filterWorktrees` in `src/renderer/panes/code-parts/data.ts`.

When changing app behaviour, update the matching `docs/` file in the same commit. The schema in `src/main/config-schema.ts` and the public reference (`docs/reference/config.md`) must agree on every release.
