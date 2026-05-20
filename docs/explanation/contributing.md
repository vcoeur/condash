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
conception-template/  # Skills + sample tree shipped via `condash skills install`.
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

- **Vitest** — `src/**/*.test.ts`. Fast. Pure-function tests (parsers, path helpers, regexes). `environment: 'node'`.
- **Playwright** — `tests/*.spec.ts`. Drives the real Electron app. Slower, more authoritative. The Playwright fixture launches Electron with `CONDASH_FORCE_PROD=1` so the renderer loads the real `dist/` build, not the Vite dev server.

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

CI is split into a fast lane, a heavy lane, and a release pipeline. The two test lanes share three reusable workflows — `_fast.yml`, `_playwright.yml`, `_build.yml` — so the build matrix (and its AppImage AppRun patch) lives in exactly one place.

- **`.github/workflows/pr-fast.yml`** runs on every `pull_request` to `main`, including drafts. One Ubuntu job: `prettier --check` + `npm run typecheck` + `npm run build` + `npx vitest run`. Target ≤ 90 s, so iterating on a PR stays cheap. No Playwright, no installer build.
- **`.github/workflows/pr-heavy.yml`** runs only when a PR is **not** a draft (the `ready_for_review` type plus a `draft == false` guard). It runs the full Playwright suite (Ubuntu + xvfb) and the three-OS installer matrix (`electron-builder --publish never` on Ubuntu / macOS / Windows, including the AppImage AppRun patch). On success a `gate-stamp` job writes a `release-gate=success` commit **status** on the PR's head commit — the same commit you later tag.
- **`.github/workflows/release.yml`** has two disjoint paths. On **push to `main`** a `guard` job diffs the merge commit against the PR head it merged (`HEAD` vs `HEAD^2`); if they're byte-identical the PR already tested this exact tree and heavy CI is skipped, so an up-to-date PR doesn't pay for a redundant re-run on merge. Heavy CI runs on `main` only when the merge combined something the PR didn't test (or a direct push with no second parent). On **push of a `v*` tag**, `validate-tag` checks tag shape + `package.json` version match + tag SHA reachable from `origin/main` + a green `release-gate` status on the tag commit; then `build` produces the installers and `publish` creates the Release. The suite is **not** re-run at tag time — `validate-tag` reads the `release-gate` status that `pr-heavy` recorded, so "ship only if green" is enforced from GitHub's own status without re-testing.

The `release-gate` status is required-green at tag time, so a tag whose commit never passed `pr-heavy` (a mid-PR SHA, a draft PR, a direct push) is refused before any Release is created. The tag stays in git but nothing public ships. The Windows installer leg is the load-bearing build check: `build/installer.nsh`'s NSIS hooks only assemble into the full installer template when `electron-builder` runs, so NSIS warning 6010 (treated as an error) only surfaces in the matrix — which now runs pre-merge on every ready PR, catching it before a tag is ever pushed.

For the tag-time `release-gate` check to mean anything, **branch protection on `main` must require the heavy lane to pass before merge** (configured in repo settings, not in YAML). Without that, a red PR could merge and the heavy lane would never stamp the commit — `validate-tag` would then correctly refuse to publish, but the breakage would only surface at release time.

The checks to require are the two aggregator jobs **`pr-fast-gate`** and **`pr-heavy-gate`** — not the inner `fast` / `playwright` / `build` checks. Each PR workflow filters at the job level (a `changes` job skips the real lanes for docs/assets-only PRs) and ends in an always-running gate job that reports success when its lane succeeded *or* was skipped. Requiring the gate (rather than an inner check that simply doesn't report on a skipped docs-only PR) keeps required checks from wedging trivial PRs in a permanent "Expected" state.

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
- **Releases** — tagged `vMAJOR.MINOR.PATCH`. PATCH for bug fixes and docs; MINOR for new behaviour; MAJOR for breaking config or Markdown changes. Tag pushes trigger `main.yml`'s `publish` job automatically (gated behind the heavy CI matrix).

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
