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
2. If the dep is **native** (has a `binding.gyp` or ships prebuilt `.node` files — e.g. `node-pty`), add it to the `EXTERNAL` array in `scripts/build-electron.mjs` so esbuild leaves it alone, and wire `electron-rebuild` if needed.
3. Pure-JS deps need no further work.

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
| `make typecheck` | tsc on both projects, no emit |
| `make format` | prettier on `src/` |
| `make kill` | free port 5600 |
| `make clean` | remove `dist/`, `dist-electron/`, `release/` |

## Configuration

- **Per-machine**: `${XDG_CONFIG_HOME:-~/.config}/condash/settings.json`. Owned by Electron's `app.getPath('userData')`, derived from `package.json`'s `name` field. JSON only. Sole owner of `lastConceptionPath` + `recentConceptionPaths` (cap 5); also carries global defaults for every workspace key.
- **Per-conception**: `<conception>/.condash/settings.json` (canonical). The whole `.condash/` directory is fully gitignored by default — settings included — so it carries per-host state with no commit-leak risk. Two legacy paths still read as fallbacks: `<conception>/condash.json` (old canonical) and `<conception>/configuration.json` (legacy²). Writes always target `.condash/settings.json`. The auto-migrator (`src/main/condash-dir-migrate.ts`) copies legacy content on first open, tombstones the source file, and appends `.condash/` to `.gitignore` when the conception is a git repo. `condash config migrate` exposes the same operation explicitly.
- **Per-conception logs**: `<conception>/.condash/logs/YYYY/MM/DD/HHMMSS-<sid>.txt` + sidecar `HHMMSS-<sid>.meta.json`. One pair per pty spawn; gitignored alongside `settings.json`. The writer (`src/main/terminal-logger.ts`) pipes pty bytes into a headless xterm (`@xterm/headless`) and atomically rewrites the `.txt` with the serialised buffer every 5 s; the `.meta.json` carries `{sid, side, repo?, cwd, cmd, argv, started, exitCode?, finished?}`. `in` keystrokes are *not* captured separately — the pty echoes them back through `out`, so the buffer already shows what was typed; a separate `in` stream would double-echo and leak raw keystrokes. Session size is bounded by xterm scrollback (`terminal.logging.scrollback`, default 10000 lines); no per-file rotation. Janitor (`src/main/terminal-logger-janitor.ts`) evicts day-directories past `terminal.logging.retentionDays` (default 14) and oldest-first while over `terminal.logging.maxDirMb` (default 500); runs at startup + every 24 h. The Logs working surface (`Cmd+Shift+L`) browses the tree, reading `.txt` and rendering it via `ansi_up`. The renderer (`src/renderer/panes/logs-render.ts` → `logs.tsx`) first expands `CSI <N> C` (cursor-forward) to N literal spaces — `@xterm/addon-serialize` uses CUF to encode runs of empty cells, and `ansi_up` is SGR-only, so without the expansion every "empty cell" gap collapses and words mash together. SGR escapes are rendered to styled HTML; other non-SGR CSI escapes (mode set, cursor up/down/back) are still dropped by `ansi_up`, which is the right behaviour for a static text rendering. Legacy `.jsonl` files from condash ≤ 2.22 are ignored by the viewer — the janitor evicts them by age.
- `CONDASH_CONCEPTION_PATH` env var override: wired in both Electron (`src/main/settings.ts`) and CLI (`src/cli/conception.ts`). See [`docs/guides/configure-conception-path.md`](docs/guides/configure-conception-path.md) for the resolution chain. The conception-detector accepts any of the three recognised config files when validating a candidate path.
- The merge resolver lives in `src/main/effective-config.ts`. Every reader (`repos.ts`, `worktree-ops.ts`, `launchers.ts`, `audit.ts`, `terminals.ts`, `conception-paths.ts`, the CLI's `config` verbs) goes through it.
- **Merge rule**: top-level replace for every key, with **one exception**: `terminal` merges one level deep so a conception customising `terminal.logging` keeps the per-machine `terminal.launcher_command` / `screenshot_dir` / shortcuts. The exception is documented in `docs/reference/config.md` and tested in `effective-config.test.ts`.

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
- File-path conventions: every path crossing the IPC boundary is normalised to forward-slash form via `toPosix(p)` from `src/shared/path.ts`. Internal `fs` calls keep the native separator (use `path.join`); the renderer can then split on `/` without per-OS branches. Cross-OS shell wrapping (`bash -lc` / `cmd.exe /d /s /c` / `pwsh -Command`) lives in `src/main/terminals.ts`'s `wrapForShell`.
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
