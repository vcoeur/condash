# condash-electron

Electron rewrite of [condash](https://github.com/vcoeur/condash). Markdown project dashboard for the conception convention — every project, incident, and document lives as a plain `.md` file under `projects/YYYY-MM/YYYY-MM-DD-<slug>/README.md`, and condash renders the live dashboard view.

The Tauri implementation lives at [`vcoeur/condash-tauri`](https://github.com/vcoeur/condash-tauri) (snapshot of `vcoeur/condash` at v1.8.1) and remains the canonical build until this rewrite reaches feature parity.

**Status**: pre-alpha. MVP-0 only lists projects.

## Why a rewrite

Documented in the conception project [`2026-04-26-condash-electron-port`](https://github.com/vcoeur/conception/tree/main/projects/2026-04/2026-04-26-condash-electron-port). Short version: cross-OS rendering parity from a Linux-only desk + native fit for the rich-content libraries (xterm.js, PDFium, Monaco/CodeMirror, markdown-it, Mermaid) condash already leans on. The Tauri-era workarounds (axum loopback, htmx morph, fingerprint poll, vendored libs) are dropped — they only existed because of Tauri.

## Quick start

```bash
make install      # first time
make dev          # main + renderer + electron in watch mode
```

`make dev` runs three processes concurrently: `tsc --watch` for main + preload, Vite for the renderer (port 5600), and Electron pointed at the dev URL. Hot-reload works for the renderer; main/preload changes restart on the next launch.

Build installers:

```bash
make build && make package
# output → release/
```

### Linux first-run fix

On Linux, Electron's Chromium sandbox helper needs to be `setuid root`. If the first launch aborts with `chrome-sandbox is not configured correctly`, run once after every `npm install`:

```bash
sudo chown root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

This is a Chromium / Linux requirement — not a condash-electron decision. macOS and Windows don't need it.

## Architecture (MVP-0)

```
src/
├── main/         # app lifecycle, IPC handlers, fs walk, README parse
├── preload/      # contextBridge — exposes window.condash typed as CondashApi
├── renderer/     # Solid + plain CSS, single-window UI
└── shared/       # types + api interface, imported by all three layers
```

No HTTP server, no SSE, no fingerprint poll, no Rust. Renderer talks to main via the typed `CondashApi` interface in `src/shared/api.ts`.

## License

MIT.
