# condash

Markdown project dashboard for the conception convention — every project, incident, and document lives as a plain `.md` file under `projects/YYYY-MM/YYYY-MM-DD-<slug>/README.md`, and condash renders the live dashboard view.

This repo is the **Electron build**, canonical as of 2026-04-27. The Tauri lineage lives on at [`vcoeur/condash-tauri`](https://github.com/vcoeur/condash-tauri) (last release: v1.8.8) and remains buildable as long as bug fixes are warranted.

**Status**: parity reached against Tauri v1.8.1 daily-driver surface; packaging + first published release tracked in [`conception/projects/2026-04/2026-04-27-condash-packaging`](https://github.com/vcoeur/conception/tree/main/projects/2026-04/2026-04-27-condash-packaging).

## Why a rewrite

Documented in the conception project [`2026-04-26-condash-electron-port`](https://github.com/vcoeur/conception/tree/main/projects/2026-04/2026-04-26-condash-electron-port). Short version: cross-OS rendering parity from a Linux-only desk + native fit for the rich-content libraries (xterm.js, PDFium, Monaco/CodeMirror, markdown-it, Mermaid) condash already leans on. The Tauri-era workarounds (axum loopback, htmx morph, fingerprint poll, vendored libs) are dropped — they only existed because of Tauri.

## Quick start

```bash
make install      # first time
make dev          # main + renderer + electron in watch mode
```

### Linux first-run: native deps

`npm install` runs `electron-rebuild` as a postinstall step so any native module
(currently `node-pty`, more later) is built against Electron's Node ABI rather
than the system one. The build needs the standard Node-gyp toolchain and a few
distro packages:

```bash
sudo apt install build-essential python3 libxkbfile-dev libsecret-1-dev
```

`@electron/rebuild` is invoked again automatically by `electron-builder` during
`make package`, so installer output already targets the bundled Electron ABI.

`make dev` runs three processes concurrently: `tsc --watch` for main + preload, Vite for the renderer (port 5600), and Electron pointed at the dev URL. Hot-reload works for the renderer; main/preload changes restart on the next launch.

Build installers:

```bash
make build && make package
# output → release/
```

### Sandbox in dev vs. production

Linux Chromium needs its `chrome-sandbox` helper to be `setuid root` to enable the sandbox. We handle this differently per environment:

- **Dev** (`make dev`) — passes `--no-sandbox` to Electron. Avoids per-worktree `sudo`. The dev window only loads `http://localhost:5600` and local `file://` URLs, so the threat surface is local code already on the machine.
- **Production** (`make package`) — `electron-builder` runs the SUID setup during install on `.deb` and AppImage; users get the sandbox enabled automatically.

If you want the sandbox on during dev anyway: drop `--no-sandbox` from the `dev:electron` script in `package.json` and run, once per worktree:

```bash
sudo chown root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

macOS and Windows don't need any of this.

## Architecture

```
src/
├── main/         # app lifecycle, IPC handlers, fs walk, README parse
├── preload/      # contextBridge — exposes window.condash typed as CondashApi
├── renderer/     # Solid + plain CSS, single-window UI
└── shared/       # types + api interface, imported by all three layers
```

No HTTP server, no SSE, no fingerprint poll, no Rust. Renderer talks to main via the typed `CondashApi` interface in `src/shared/api.ts`.

## Documentation

The full documentation tree is at [`docs/`](docs/) (Diátaxis layout):

- [`docs/index.md`](docs/index.md) — landing page with links into every section.
- [`docs/explanation/internals.md`](docs/explanation/internals.md) — load-bearing invariants (drift-checked mutations, atomic-rename writes, the per-file write queue, the TTL git-status cache, the SIGTERM → force_stop → SIGKILL pty pipeline, the IPC contract).
- [`docs/reference/config.md`](docs/reference/config.md) — `<conception>/configuration.json` reference: every key, with examples and edit paths.
- [`docs/explanation/non-goals.md`](docs/explanation/non-goals.md) — what condash will deliberately not do.

The same docs are available inside the running app via the `?` button in the toolbar (the in-app loader maps `architecture` / `configuration` / `non-goals` to the Diátaxis paths above — see `src/main/help.ts`).

## License

MIT.
