# CLAUDE.md — condash (Electron)

Electron build of condash. As of 2026-04-27 this **is** the canonical condash — it lives at `vcoeur/condash` after the swap that moved the Tauri lineage to `vcoeur/condash-tauri`. The Tauri build remains buildable at that repo for as long as bug fixes are warranted.

Project tracking + per-feature specs live in `vcoeur/conception/projects/2026-04/2026-04-26-condash-electron-port/` (closed) and `vcoeur/conception/projects/2026-04/2026-04-26-condash-electron-parity/` (closed). Active work is under `vcoeur/conception/projects/2026-04/2026-04-27-condash-packaging/`.

## Stack

- **Main**: Node, TypeScript, **bundled with esbuild** (`scripts/build-electron.mjs`) to a single CJS file at `dist-electron/main/index.js`. Imports are inlined; ESM-only deps (chokidar 4, future libs) bundle to CJS transparently. Native modules (electron, node-pty when MVP-15 lands, fsevents, better-sqlite3) stay external — they have to load from `node_modules` so `electron-rebuild` can reach them.
- **Preload**: same bundler, output at `dist-electron/preload/index.js`. Stays CJS because `webPreferences.sandbox: true` + ESM preload don't mix on Electron.
- **Typecheck**: `tsc -p tsconfig.main.json --noEmit` (and the renderer twin). `tsc` no longer emits — esbuild owns emission, tsc owns type-checking.
- **Renderer**: Solid + Solid signals, Vite (with `vite-plugin-solid`), plain CSS files + CSS variables, `src/renderer/main.tsx`.
- **Shared types**: `src/shared/types.ts` — plain serialisable objects, ISO strings, no methods.
- **Packaging**: electron-builder, single `BrowserWindow`, all modals/panes are in-renderer overlays.
- **Watcher (post-MVP-0)**: single global chokidar rooted at `<conception>/`, debounced 250 ms.

### Adding a new main-process dep

1. `npm install <pkg>`. ESM-only is fine — esbuild bundles it as CJS.
2. If the dep is **native** (has a `binding.gyp` or ships prebuilt `.node` files — e.g. `node-pty`, `better-sqlite3`), add it to the `EXTERNAL` array in `scripts/build-electron.mjs` so esbuild leaves it alone, and wire `electron-rebuild` if needed.
3. Pure-JS deps need no further work.

## Locked decisions

The 14 design choices the spec phase treats as fixed live in `conception/projects/2026-04/2026-04-26-condash-electron-port/notes/03-locked-decisions.md`. Re-open by editing that file with a dated reason — never silently in another note.

## Dev ports

- **5600** — Vite dev server.
- **5601** — Vite preview.
- Both `strictPort: true`. Defined in `vite.config.ts`. Cross-app port table: `conception/knowledge/topics/ops/dev-ports.md`.

When changing the dev port, update **every** file:

- `vite.config.ts` — `server.port`, `preview.port`.
- `Makefile` — `DEV_PORT`, `PREVIEW_PORT`.
- `src/main/index.ts` — `DEV_URL`.
- `src/renderer/index.html` — CSP `connect-src` (HMR websocket).
- `package.json` — `dev:electron` `wait-on tcp:<port>`.
- `conception/knowledge/topics/ops/dev-ports.md`.
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

- **Per-machine**: `${XDG_CONFIG_HOME:-~/.config}/condash/settings.json`. Owned by Electron's `app.getPath('userData')`, derived from `package.json`'s `name` field. JSON only — no YAML.
- **Tree-level (post-MVP-0)**: `<conception>/configuration.json`. New file, JSON. Coexists with the Tauri build's `<conception>/configuration.yml` until Tauri is deprecated.
- `CONDASH_CONCEPTION_PATH` env var override: not yet wired. Add when needed.

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
- File-path conventions stay POSIX-shaped in main-process code; convert at the boundary with `path.join`.
- IPC contract is the single typed `CondashApi` interface in `src/shared/api.ts`. Functions, not URLs. Promises for request/response; events only for chokidar push (when wired).
- Hard interaction-to-paint budget: **≤ 16 ms** for any user-initiated action. Optimistic UI is the default; rollback on IPC failure.

## Pointers

- **Public site**: [`condash.vcoeur.com`](https://condash.vcoeur.com) — built from `docs/` + `mkdocs.yml` by `.github/workflows/docs.yml` on every published release. Includes a signed apt repo at `condash.vcoeur.com/apt/` rebuilt from every release's `.deb` assets.
- [`docs/index.md`](docs/index.md) — landing page of both the in-app Help menu and the public mkdocs site.
- [`docs/explanation/internals.md`](docs/explanation/internals.md) — invariants: drift checks, atomic writes, write queue, TTL cache, pty kill pipeline, IPC contract.
- [`docs/reference/config.md`](docs/reference/config.md) — `configuration.json` + `settings.json` schema + per-key reference.
- [`docs/explanation/non-goals.md`](docs/explanation/non-goals.md) — explicit non-goals; **read before adding "while we're at it" features**.

The in-app Help menu reads files out of the asar via the allowlist in `src/main/help.ts`, which maps the legacy short names (`architecture`, `configuration`, `non-goals`) to the Diátaxis paths above. There is no separate copy at the repo root — the migration shipped in `v2.0.6`.

When changing app behaviour, update the matching `docs/` file in the same commit. The schema in `src/main/config-schema.ts` and the public reference (`docs/reference/config.md`) must agree on every release.

## What's deliberately not here (yet)

Until each feature has its own spec under `conception/projects/2026-04/2026-04-26-condash-electron-port/notes/specs/`:

- File watcher (MVP-1).
- Step toggles, status drag, knowledge tab, terminal, notes modal, deliverables, repo strip, inline runner, search, preferences modal.
- Markdown rendering (markdown-it + plugins per L8, lands with the notes modal).
- CodeMirror 6 (lands with the notes editor).
- Auto-update (`electron-updater`, deferred behind a flag).
- `node-pty` (terminal feature only).
- Code-signing.

No spec, no code.
