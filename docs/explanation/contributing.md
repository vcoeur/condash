---
title: Contributing · condash explanation
description: How to clone, build, run, test, and submit a change to condash. The on-ramp for first-time contributors.
---

# Contributing

> **Audience.** Developer — first-time contributor or returning developer who needs a refresher on the workflow.

condash is a single-developer project, but the codebase is designed to welcome outside contributions. This page is the on-ramp: clone, build, run, test, ship a change.

If you want the design rationale rather than the workflow, read [Values](values.md) and [Non-goals](non-goals.md) first.

## Prerequisites

- **Node.js 20+** — exact minor doesn't matter; CI tests against 20.x.
- **`git`** on `PATH`. condash shells out for status / worktree info; the build also uses it.
- **A C/C++ toolchain** for native modules (currently `node-pty`):
  - Linux — `build-essential python3 libxkbfile-dev libsecret-1-dev`.
  - macOS — Xcode Command Line Tools (`xcode-select --install`).
  - Windows — Visual Studio Build Tools 2019+ with the C++ workload.
- **An editor or IDE** of your choice. The repo is plain TypeScript + CSS; any modern editor works. The codebase has no `.vscode/` settings to import.

That's it. No framework boilerplate, no per-developer config.

## Clone, install, run

```bash
git clone https://github.com/vcoeur/condash.git
cd condash
make install      # one-off — npm install + electron-rebuild
make dev          # watch mode: tsc + vite + electron with --no-sandbox
```

`make dev` runs three processes concurrently:

- `tsc --watch` typechecks `src/main/` and `src/renderer/` continuously. No emit — esbuild handles bundling.
- `vite` serves the renderer at `localhost:5600`. Hot module reload works for the renderer.
- `electron` opens a single `BrowserWindow` against the dev URL. Main / preload changes restart on the next launch (`Ctrl+R` on the dev window).

If port 5600 is in use, `make kill` frees it. Add or change ports? See the dev-port checklist in [`CLAUDE.md`](https://github.com/vcoeur/condash/blob/main/CLAUDE.md).

## Project layout

```
src/
├── main/         # Electron main process. fs, IPC handlers, watchers, mutations.
├── preload/      # contextBridge — exposes window.condash typed as CondashApi.
├── renderer/     # Solid SPA. Components, signals, Markdown rendering, modals.
├── shared/       # Types + IPC contract. Imported by all three layers.
└── cli/          # The condash CLI (since v2.4.0). Same binary, different argv.

scripts/          # Build glue. esbuild entry point, electron-builder helpers.
docs/             # This documentation site.
tests/            # Playwright E2E + Vitest unit tests.
conception-template/  # Skills + sample tree shipped via `condash-cli skills install`.
```

Three TS configs:

- `tsconfig.main.json` — main + preload + cli.
- `tsconfig.renderer.json` — renderer.
- `tsconfig.json` — shared + tooling.

Each config is checked independently. `make typecheck` runs both. esbuild does the actual emission for main + preload + cli; vite handles the renderer.

## How a feature lands

A typical feature touches three layers in sequence:

1. **`src/shared/api.ts`** — add the IPC verb signature to the `CondashApi` interface. Plain serialisable inputs and outputs (no functions, no Date objects, ISO strings).
2. **`src/main/`** — implement the handler. Register it in `src/main/index.ts:registerIpc` as a single-line `ipcMain.handle('verb', impl)`.
3. **`src/preload/index.ts`** — add a one-liner: `verb: (...args) => ipcRenderer.invoke('verb', ...args)`.
4. **`src/renderer/`** — call it through `window.condash.verb(...)`.

Because `CondashApi` is a single typed interface, the compiler will refuse to build until all four layers agree. There is no string-mux'd action layer where a typo silently no-ops.

For renderer-only features (UI states, animations, derived signals), only the renderer changes.

## Testing

```bash
make typecheck    # tsc --noEmit on both projects
make test         # vitest unit tests
make e2e          # Playwright against a real Electron build
```

- **Vitest** — `tests/unit/`. Fast. Pure-function tests (parsers, path helpers, regexes).
- **Playwright** — `tests/e2e/`. Drives the real Electron app. Slower, more authoritative. The Playwright fixture launches Electron with `CONDASH_FORCE_PROD=1` so the renderer loads the real `dist/` build, not the Vite dev server.

For a feature that touches the dashboard's behaviour, prefer Playwright. The e2e suite seeds a temporary conception tree, exercises the feature, and asserts on real DOM + real file writes.

## Style and conventions

- **`make format`** runs Prettier across `src/`. Run it before every commit. CI fails on unformatted code.
- **No comments unless the *why* is non-obvious.** Names already say *what*. See [`CLAUDE.md`](https://github.com/vcoeur/condash/blob/main/CLAUDE.md) for the longer version.
- **Don't add features beyond what the task requires.** Bug fixes don't need surrounding cleanup. Three similar lines beats a premature abstraction.
- **Small commits, descriptive subjects.** Imperative mood, ≤72 characters.
- **One PR per logical change.** A 30-line PR with one review cycle ships faster than a 300-line PR that needs three.

## What the build pipeline produces

```
make build       # → dist-electron/main/index.js, dist-electron/preload/index.js, dist/
make package     # → release/{*.AppImage, *.deb, *.dmg, *.exe, latest*.yml}
```

Native modules (`electron`, `node-pty`) stay external — esbuild leaves them as `require()` calls so they load from `node_modules`. `electron-rebuild` rebuilds them against the bundled Electron's Node ABI; `electron-builder` runs it again at package time.

Two GitHub Actions workflows guard `main`:

- **`.github/workflows/pr.yml`** runs on every `pull_request` to `main`. A `quick-checks` job (Ubuntu) runs `prettier --check` + `npm run typecheck` + `npm run build`; an `installer-smoke` matrix job (Ubuntu + Windows) runs `npx electron-builder --publish never` to compile the full `.deb` / `.AppImage` / NSIS installer. macOS is not in the PR matrix — the DMG build path doesn't depend on platform-specific hooks, so it's only exercised on tag-push. The Windows installer-smoke is the load-bearing job: `build/installer.nsh`'s NSIS hooks only get assembled into the full installer template when `electron-builder` runs, so warnings-as-errors regressions there only surface here (or at release time, which is too late).
- **`.github/workflows/release.yml`** builds all four installers on tag push (`v*`), uploads them to the GitHub Release as draft assets, and rebuilds the apt repository at `condash.vcoeur.com/apt/` from every published `.deb`.

## Documentation changes

This documentation site lives at `docs/` in the same repo. The mkdocs nav is at `mkdocs.yml`. To preview locally:

```bash
pip install mkdocs-material
mkdocs serve     # → http://localhost:8000
```

Conventions:

- Every page declares its **Audience** at the top, immediately under the H1.
- Diátaxis layout: tutorials teach, guides solve, reference looks up, explanation explains.
- Cross-link to neighbouring pages.
- Source-of-truth fields (config keys, IPC verbs, exit codes) are tested against the code in CI: if the docs diverge, the test fails.

Every code change that affects user-visible behaviour ships with a docs update in the same commit.

## Issues, PRs, releases

- **Issues** — file at [`github.com/vcoeur/condash/issues`](https://github.com/vcoeur/condash/issues). For bugs, include the OS, the condash version (footer of the dashboard), and a minimal repro tree if you can.
- **PRs** — branch from `main`, open a PR against `main`. The PR template asks for a Summary, a Changes list, and an optional Impact / Watchpoints section.
- **Releases** — tagged `vMAJOR.MINOR.PATCH`. PATCH for bug fixes and docs; MINOR for new behaviour; MAJOR for breaking config or Markdown changes. Tag pushes trigger the release workflow automatically.

## What to work on

Three good places to start:

1. **Issues tagged `good first issue`** at the issue tracker.
2. **Pages tagged "stub" or "TODO"** in this docs tree — search the source for `TODO` and `<!-- stub -->`.
3. **A feature you want yourself.** condash exists because someone wanted it; the next feature probably will too.

Before starting on anything large, open an issue with the proposed approach and link to the values it serves. A 200-word issue saves a 2000-word PR rewrite.

## See also

- [Values](values.md) — the principles a contribution should serve.
- [Non-goals](non-goals.md) — things contributions should not try to be.
- [Internals](internals.md) — load-bearing invariants worth understanding before touching the main process.
- [`CLAUDE.md`](https://github.com/vcoeur/condash/blob/main/CLAUDE.md) — the developer-instructions file checked into the repo.
