# CLAUDE.md — condash-electron

Electron rewrite of `condash`. The Tauri build at `vcoeur/condash-tauri` (snapshot of `condash` v1.8.1) remains canonical until parity is reached.

Project tracking + per-feature specs live in `vcoeur/conception/projects/2026-04/2026-04-26-condash-electron-port/`.

## Stack

- **Main**: Node, TypeScript (CommonJS), `tsc` to `dist-electron/`.
- **Preload**: contextBridge surface, exposes `window.condash` typed as `CondashApi` (see `src/shared/api.ts`).
- **Renderer**: Solid + Solid signals, Vite (with `vite-plugin-solid`), plain CSS files + CSS variables, `src/renderer/main.tsx`.
- **Shared types**: `src/shared/types.ts` — plain serialisable objects, ISO strings, no methods.
- **Packaging**: electron-builder, single `BrowserWindow`, all modals/panes are in-renderer overlays.
- **Watcher (post-MVP-0)**: single global chokidar rooted at `<conception>/`, debounced 250 ms.

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

- **Per-machine**: `${XDG_CONFIG_HOME:-~/.config}/condash-electron/settings.json`. Owned by Electron's `app.getPath('userData')`. JSON only — no YAML.
- **Tree-level (post-MVP-0)**: `<conception>/configuration.json`. New file, JSON. Coexists with the Tauri build's `<conception>/configuration.yml` until Tauri is deprecated.
- `CONDASH_CONCEPTION_PATH` env var override: not yet wired. Add when needed.

## Linux first-run fix

After every `npm install` on Linux, Chromium's sandbox helper needs `setuid root`:

```bash
sudo chown root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

If you skip it, Electron aborts on launch with `The SUID sandbox helper binary was found, but is not configured correctly`. macOS and Windows are unaffected.

## Conventions

- Run `make format` after every code change.
- All UI must work without per-OS CSS branches (Electron + Chromium = same renderer everywhere).
- File-path conventions stay POSIX-shaped in main-process code; convert at the boundary with `path.join`.
- IPC contract is the single typed `CondashApi` interface in `src/shared/api.ts`. Functions, not URLs. Promises for request/response; events only for chokidar push (when wired).
- Hard interaction-to-paint budget: **≤ 16 ms** for any user-initiated action. Optimistic UI is the default; rollback on IPC failure.

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
