# CLAUDE.md — condash

Standalone desktop dashboard for markdown-based conception items. Every item — project, incident, or document — lives at `projects/YYYY-MM/YYYY-MM-DD-slug/README.md` and carries a `**Kind**` field in its header. Condash renders a live view of that tree, tracks `## Steps` checklists, toggles item status, reorders steps, and opens files in your IDE — all from one native window backed by the same Markdown files the user edits by hand.

The name is a contraction of *conception dashboard*.

## Project type

- **Not deployed.** Per-laptop tool — Tauri-bundled desktop binary plus a headless `condash-serve` HTTP binary for development + Playwright e2e.
- **Single-user, single-window.** One process per user, launched on demand. No daemon, no multi-tenant state.
- **No database.** The source of truth is the Markdown tree at `conception_path`. Condash parses it on demand (memoized via `WorkspaceCache`) and mutates files in place.

## Stack

- Rust + Tauri 2 (native window, embedded webview, IPC for clipboard).
- HTTP layer: axum on tokio. The Tauri webview talks to it locally; `condash-serve` exposes the same router for browser + Playwright access.
- Templating: `minijinja` (Jinja2-compatible) for HTML rendering.
- Asset embedding: `rust-embed` bakes `frontend/` into the binary; `CONDASH_ASSET_DIR` overrides for live-edit during development.
- Frontend: hand-written ES modules under `frontend/src/js/` bundled to `frontend/dist/bundle.{js,css}` via esbuild. Driven by htmx (htmx-ext-sse for the live SSE stream); editor uses CodeMirror 6, terminal uses xterm.js, PDFs render via PDF.js. All vendored under `frontend/vendor/` so the bundle is `npm install`-free.
- File watching: tokio-based debouncer in `src-tauri/src/events.rs` → SSE `tab` events that htmx panes refetch on.
- PTY: `src-tauri/src/pty.rs` for the embedded multi-tab terminal and the `run:` dev-runner sessions.

## Architecture

```
condash/
  Cargo.toml                 <- workspace; binaries live in src-tauri/
  src-tauri/
    src/
      main.rs                <- Tauri entry point (GUI binary)
      lib.rs                 <- shared library: bootstrap + conception-path resolution
      bin/condash_serve.rs   <- headless HTTP binary (no Tauri deps)
      assets.rs              <- rust-embed of frontend/ + dev override via CONDASH_ASSET_DIR
      config.rs              <- <conception>/configuration.yml loader (build_ctx)
      user_config.rs         <- ~/.config/condash/settings.yaml loader
      paths.rs               <- traversal-safe path validators
      events.rs              <- filesystem watcher → SSE event bus
      pty.rs                 <- PTY lifecycle (terminal + dev-runner)
      runner_registry.rs     <- per-repo runner sessions (start/stop/force-stop)
      env_hygiene.rs         <- strip sandbox-leaked env vars before spawn
      launcher.rs            <- "open with" command-chain executor
      server/                <- axum routers, one file per concern
        mod.rs                  - register_all + Router builder
        shell.rs                - `/`, `/fragment/{history,knowledge,code,projects}` + per-item `/fragment/{projects,history}/:slug`, `/fragment/knowledge/one?path=…`, `/fragment/code/:repo`, static assets
        steps.rs                - `/toggle`, `/add-step`, `/edit-step`, `/remove-step`, `/set-priority`, `/reorder-all`
        notes.rs                - `/note*` mutations + uploads
        items.rs                - `/create-item`
        events.rs               - `GET /events` SSE stream
        terminal.rs             - `GET /ws/term` embedded terminal WebSocket
        runners.rs              - `/api/runner/{start,stop,force-stop}` + `GET /ws/runner/{key}`
        config_surface.rs       - `/configuration` r/w + `/config` summary
        openers.rs              - `/open`, `/open-folder`, `/open-external`, `/open-doc`, `/recent-screenshot`
        rescan.rs               - `/rescan` hard refresh
  crates/
    condash-parser/          <- README + knowledge tree parsing, regexes, deliverables, note-kind
    condash-state/           <- RenderCtx + WorkspaceCache + git/scan + search
    condash-render/          <- minijinja templates + render functions for cards / notes / git strip / page / history search
    condash-mutations/       <- file-mutation helpers: steps, notes, files, create_item
  frontend/
    dashboard.html           <- single-file SPA, served verbatim at `/`
    src/                     <- source ES modules + CSS (bundled by `make frontend`)
      js/dashboard-main.js     - bundle entry point; imports section modules + registers actions
      js/sections/*.js         - one module per UI subsystem (terminal-*, note-*, sse, steps, …)
      css/                     - source CSS, bundled with esbuild
    dist/                    <- built bundle (bundle.js, bundle.css) — embedded by rust-embed
    vendor/                  <- htmx, codemirror, mermaid, pdfjs, xterm (all vendored flat)
    favicon.{svg,ico}
  tests/                     <- cargo workspace tests
  tests/e2e/                 <- Playwright smoke against `condash-serve`
  docs/                      <- mkdocs source for the docs site
```

`AppState` (built in `src-tauri/src/server/mod.rs`) holds the live `Arc<RenderCtx>` (swapped on `/configuration` POST), the `WorkspaceCache`, the SSE event bus, the runner registry, and the PTY registry. Every router takes `State<AppState>` and reads the current ctx via `state.ctx()`.

## Config

Two YAML files, two layers:

- **Per-user**: `${XDG_CONFIG_HOME:-~/.config}/condash/settings.yaml`. Tells condash which conception tree to render, plus per-machine preferences (`terminal`, `pdf_viewer`, `open_with`). Loader: `src-tauri/src/user_config.rs`.
- **Per-tree**: `<conception_path>/configuration.yml`. Tree-wide defaults: `workspace_path`, `worktrees_path`, `repositories.{primary,secondary}` (with optional `run:` / `force_stop:` per repo), and the same `terminal` / `pdf_viewer` / `open_with` keys for project-wide overrides. Loader: `src-tauri/src/config.rs::build_ctx`.

When the same key appears in both files, **`settings.yaml` wins**, merged field by field. Detail: `docs/reference/config.md`.

Precedence when resolving the conception tree (`src-tauri/src/lib.rs::resolve_conception_path`): `CONDASH_CONCEPTION_PATH` env var → `settings.yaml` → (GUI only) native folder picker → hard error.

- **First-run flow** (GUI): if neither env nor settings.yaml supply a path, a native folder picker opens via `rfd`. Loose validation (directory exists + contains `configuration.yml` or `projects/`). On accept, the choice is persisted to `settings.yaml`. On cancel, the app exits cleanly.
- **Headless** (`condash-serve`): env var → settings.yaml → hard error. No prompt.
- **In-app editor**: the gear icon opens a plain-text YAML editor of `configuration.yml` (`GET/POST /configuration`). On valid POST the file is atomically replaced and `RenderCtx` is hot-rebuilt — the open dashboard repaints without a restart.
- **`[open_with.*]` slots**: vendor-neutral launcher keys (`main_ide`, `secondary_ide`, `terminal`, …) each with a `label` and a `commands` fallback chain. `{path}` is substituted with the absolute path of the repo / worktree being opened. Commands are tried in order until one starts.
- **Per-repo `run:` + `force_stop:`**: `run:` is a dev-runner template spawned via the tri-state Start/Stop/Switch button on each branch row — one session per repo, scoped to the checkout that started it. `force_stop:` drives the repo-level nuclear-stop button in the card header — runs unconditionally (even when condash has no session for the repo), so it can free a port held by a server started from another terminal. Both routed through `sh -c`.

## Sandbox rules for "open in IDE"

`paths::validate_open_path(ctx, path_str)` accepts a path only if it resolves inside `ctx.workspace` or `ctx.worktrees`. This is the single defence against condash being tricked into launching an arbitrary binary via a crafted URL parameter. When editing any "open with external tool" code path, preserve the sandbox check — never trust an absolute path that came in over HTTP.

## Dashboard HTML

`frontend/dashboard.html` is served verbatim at `/`. It is a single-file SPA driven by htmx + a small set of hand-written ES modules under `frontend/src/js/`. The bundle (`frontend/dist/bundle.{js,css}`) is rebuilt by `make frontend` and embedded into the binary via rust-embed. Per-pane refreshes go through `hx-trigger="sse:<tab>"` + `/fragment/<tab>` for structural changes; per-item refreshes go through `hx-trigger="sse:<tab>-<id>"` + `/fragment/<tab>/<id>` on each card root, so a single step toggle / file edit / git ref change re-fetches one ~few-KB fragment instead of the whole pane (see `src-tauri/src/events.rs::classify` for path → `(pane, id)` resolution). Do not refactor `dashboard.html` into a JS framework — the single-file contract is deliberate (one `<script>` tag, zero npm install at runtime).

## PDF preview

PDFs in project notes render inside the modal via a custom viewer built on `pdfjs-dist` (library, not the prebuilt stock `web/viewer.html`). The library is vendored under `frontend/vendor/pdfjs/` and served at `/vendor/pdfjs/{rel_path}`. The render layer emits `<div class="note-pdf-host" data-pdf-src="/file/…" data-pdf-filename="…">` for `.pdf` files; the ES module at the bottom of `dashboard.html` imports `/vendor/pdfjs/build/pdf.mjs`, exposes `window.__pdfjs`, and mounts toolbar + lazy-rendered canvases on each host. Bump via `make update-pdfjs`.

We deliberately do **not** use `<iframe src="*.pdf">` with the embedded webview's built-in PDF viewer — Tauri's webview does not consistently expose one across platforms.

## Commands

```bash
make setup                      # install cargo-tauri into the rustup toolchain (one-shot)
make frontend                   # bundle frontend/src/ into frontend/dist/ via esbuild
make run                        # `cargo tauri dev` — open the native window
make serve                      # run `condash-serve` headless (CONCEPTION= overrides path)
make build                      # bundle Tauri release artefacts
make check                      # cargo check + inline-handler lint guard
make test                       # cargo test across the workspace
make smoke                      # Playwright e2e against condash-serve
make format                     # cargo fmt across the workspace
make docs / docs-serve          # build / preview the mkdocs site
```

The CLI honours `CONDASH_LOG_LEVEL` (default `INFO`) for logging; set to `DEBUG` to surface the clipboard fallback chain and similar low-noise events. `CONDASH_PORT` pins `condash-serve`'s port for stable Playwright fixtures.

## Workflow

1. After any code change: `make format && make check && make test`.
2. Bundle the frontend (`make frontend`) before `make run` / `make serve` / `make smoke` — the binaries serve the embedded `dist/`, not the source.
3. `make smoke` boots `condash-serve` against a fixture conception tree and drives the dashboard via Playwright — run it before merging anything that touches routes, SSE, or the bundled JS.
4. When adding a new route in `server/`: add the matching fetch call in `frontend/src/js/` and consider extending the smoke suite if it's reachable from the SPA.
5. Every helper that needs config takes `ctx: &RenderCtx` (or pulls one from `state.ctx()`). Pure helpers (regex gates, HTML escaping, parsers of in-memory data) stay ctx-free.

## Key code locations

- GUI entrypoint: `src-tauri/src/main.rs` → `lib.rs::run` (Tauri builder, plugins, conception-path resolution + first-run picker).
- Headless entrypoint: `src-tauri/src/bin/condash_serve.rs`.
- Router wiring: `src-tauri/src/server/mod.rs::build_router`. Each concern is a sibling file exposing route handlers.
- Runtime state: `src-tauri/src/server/mod.rs::AppState` — single per-process instance — and `crates/condash-state/src/ctx.rs::RenderCtx` + `build_ctx`. `RenderCtx` is frozen (`Arc`-shared); rebuilt on every `/configuration` POST.
- Path validators: `src-tauri/src/paths.rs` — the shared traversal guard.
- Parsers + renderers: `crates/condash-parser/` (README + knowledge tree), `crates/condash-render/` (minijinja templates + Rust render functions for cards / notes / knowledge / git strip / page).
- History search: `crates/condash-state/src/search.rs::search_items`. Exposed as `GET /fragment/history?q=…`; the History tab's input drives it via htmx.
- File mutations: `crates/condash-mutations/` — toggle / add / edit / remove step, set-priority, rename / create note, create-item, file uploads.
- Git scan: `crates/condash-state/src/git/scan.rs` — workspace scan, per-repo status, worktree listing, fingerprint cache for the `/check-updates` long-poll.
- Runner registry: `src-tauri/src/runner_registry.rs` — per-repo PTY-backed dev-runner sessions; surfaces `fingerprint_token` for the Code-tab fingerprint layer.
- Embedded terminal: `src-tauri/src/pty.rs` (PTY lifecycle) + `src-tauri/src/server/terminal.rs` (WebSocket handler).
- External launchers: `src-tauri/src/launcher.rs` + `src-tauri/src/server/openers.rs`.
- Asset embedding: `src-tauri/src/assets.rs` (rust-embed of `frontend/`) + `frontend/vendor/` (vendored libraries shipped in the binary).
- Frontend bundle entry: `frontend/src/js/dashboard-main.js`. Section modules under `frontend/src/js/sections/` — one per UI concern.
- Inline-handler lint guard: `tools/check-inline-handlers.sh` — keeps every event handler declared as `data-action` + delegated listener rather than inline `on*=`.
