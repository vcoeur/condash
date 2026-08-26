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
make install      # one-off — npm install; its postinstall runs electron-rebuild
make dev          # watch mode: esbuild + vite + electron with --no-sandbox
```

`make dev` does a one-shot dev build, then runs three processes concurrently:

- **esbuild in watch mode** (`scripts/build-electron.mjs --watch`) rebuilds main + preload on change.
- **`vite`** serves the renderer at `localhost:5600` with hot module reload.
- **`electron`** waits for both, then opens a single `BrowserWindow` against the dev URL. Main / preload changes need a window reload (`Ctrl+Shift+R`) to take effect.

**No typechecker runs in that loop.** esbuild strips types without checking them, so a type error will not stop `make dev` — run `make typecheck` yourself, and note that CI will. See [Dev launch from a clone](../guides/dev-launch.md) for the fuller loop.

If port 5600 is in use, `make kill` frees it. Add or change ports? See the dev-port checklist in [`AGENTS.md`](https://github.com/vcoeur/condash/blob/main/AGENTS.md).

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

The `invoke`/`handle` channel name equals the `CondashApi` method name, so the typed interface anchors it on both sides. The **main → renderer push-event** channels (`tree-events`, `termData`, `menu-command`, …) have no such anchor — they are bare strings repeated between `webContents.send(...)` in main and `ipcRenderer.on(...)` in preload — so they live as named constants in `src/shared/ipc-channels.ts` (`EVENT_CHANNELS`). Reference that map from both ends rather than re-typing the literal.

For renderer-only features (UI states, animations, derived signals), only the renderer changes.

## Testing

```bash
make typecheck     # tsc --noEmit on both projects
make test          # build, then the Playwright E2E suite
make test-unit     # vitest unit tests
make deadcode      # knip — dead files / deps / duplicate exports
```

- **Vitest** (`make test-unit`) — `src/**/*.test.ts`. Fast. Pure-function tests (parsers, path helpers, regexes). `environment: 'node'`.
- **knip** (`make deadcode`) — the dead-code / over-export guard, configured in `knip.json`. It fails the build on dead source files, dead / unlisted / unresolved dependencies, and duplicate exports (the grade that keeps re-added back-compat aliases and orphaned modules out). The pre-existing unused-export / unused-type backlog is graded `warn`: reported for a future sweep, but non-failing. The intentionally-tracked-but-unimported `electron-updater` dependency is allowlisted in `knip.json`. This check is part of the light gate, so it runs on every PR.
- **Playwright** (`make test`) — `tests/*.spec.ts`. Drives the real Electron app. Slower, more authoritative. The Playwright fixture launches Electron with `CONDASH_FORCE_PROD=1` so the renderer loads the real `dist/` build, not the Vite dev server.

For a feature that touches the dashboard's behaviour, prefer Playwright. The e2e suite seeds a temporary conception tree, exercises the feature, and asserts on real DOM + real file writes.

Driving the real Electron app means the suite opens an on-screen window unless it runs against a virtual display. On Linux, `make test` wraps the suite in `xvfb-run` when it's installed, so the window never appears or steals focus — the same thing CI does. `make test-headless` forces that wrap (and errors if `xvfb-run` is missing); `make test-visible` runs with the window visible when you want to watch a run. On macOS/Windows (no `xvfb`), `make test` runs visibly.

On a Wayland session there's a catch: the shell exports `ELECTRON_OZONE_PLATFORM_HINT=wayland` and `WAYLAND_DISPLAY`, and Electron honours those over the virtual X `DISPLAY` that `xvfb-run` provides — so the window would still open on the real compositor and steal focus despite the wrap. The wrapped targets therefore drop `WAYLAND_DISPLAY` and pin `ELECTRON_OZONE_PLATFORM_HINT=x11` for the run, forcing Electron to render into Xvfb. `make test-visible` keeps Wayland on purpose.

## Style and conventions

- **`make format`** runs Prettier across `src/`. Run it before every commit. CI fails on unformatted code.
- **No comments unless the *why* is non-obvious.** Names already say *what*. See [`AGENTS.md`](https://github.com/vcoeur/condash/blob/main/AGENTS.md) for the longer version.
- **Don't add features beyond what the task requires.** Bug fixes don't need surrounding cleanup. Three similar lines beats a premature abstraction.
- **Small commits, descriptive subjects.** Imperative mood, ≤72 characters.
- **One PR per logical change.** A 30-line PR with one review cycle ships faster than a 300-line PR that needs three.
- **Config key casing is frozen.** The settings surface (`settings.json` / `condash.json`) mixes two casings for historical reasons and existing keys are never renamed (a rename is a breaking settings migration). A *new* key takes **snake_case** in the repo-entry / terminal-shell vocabulary (anything under `repositories[]`, the `terminal.xterm` block, the open-with slots) and **camelCase** for app/UI preference keys (everything else). A new key in an existing group follows that group's casing; when genuinely unsure for a new group, prefer camelCase. Never introduce kebab-case, PascalCase, or SCREAMING_SNAKE. A unit guard in `config-schema.test.ts` enforces snake-or-camel on every top-level key; the rule itself is documented in `config-schema.ts`'s header.

## What the build pipeline produces

```
make build       # → dist-electron/main/index.js, dist-electron/preload/index.js, dist/
make package     # → release/{*.AppImage, *.deb, *.dmg, *.exe, latest*.yml}
```

Native modules (`electron`, `node-pty`) stay external — esbuild leaves them as `require()` calls so they load from `node_modules`. `electron-rebuild` rebuilds them against the bundled Electron's Node ABI; `electron-builder` runs it again at package time.

CI follows a two-gate model: a **light gate** on every PR and every push to `main`, and a **real gate** that runs the full suite on the exact commit being published. Three reusable workflows — `_fast.yml`, `_playwright.yml`, `_build.yml` — carry the actual work, so the build matrix (and its AppImage AppRun patch) lives in exactly one place.

- **`.github/workflows/ci.yml`** is the light gate, and the only CI that runs on a PR. It runs on every `pull_request` to `main` (including drafts) and on every `push` to `main`. One Ubuntu job via `_fast.yml`: `prettier --check` + `npm run typecheck` + `npm run build` + `npx vitest run` + `npx knip` (the dead-code guard). Target ≤ 90 s, so iterating on a PR stays cheap. No Playwright, no installer build. Its `ci-light-gate` aggregator is the **only** required check.
- **`.github/workflows/release.yml`** runs only on `v*` tag push, and is where the Playwright suite and the 3-OS installer matrix actually run. `validate-tag` checks tag shape + tag SHA reachable from `origin/main` — the version is **tag-derived**, so `_build.yml` injects `${TAG#v}` into `package.json` before electron-builder and there is no committed version to match; then the suite runs **inline on the tagged commit** in sequence — `_fast.yml` → `_playwright.yml` → `_build.yml` — and only if all three pass does `publish` create the Release and upload the installers. The suite is run for real against whatever is tagged; there is no commit-status stamp to read and no requirement to tag any particular commit. Sequencing the lanes means a cheap format/type error aborts before the expensive Playwright and 3-OS matrix start.

Because the heavy suite runs only at tag time, Playwright and 3-OS build regressions surface there rather than on the PR — run `make test` and `make package` locally before tagging if you want earlier signal. A tag whose commit is broken is caught before any Release is created: the failing lane stops the pipeline and `publish` never runs, so the tag stays in git but nothing public ships. The Windows installer leg is the load-bearing build check: `build/installer.nsh`'s NSIS hooks only assemble into the full installer template when `electron-builder` runs, so NSIS warning 6010 (treated as an error) only surfaces in the matrix.

Every job in the release and docs chains declares a **`timeout-minutes`**. Without one a job inherits GitHub's 360-minute default, so a hung step burns six hours before the pipeline gives up — which is how release `v4.111.0` was lost: an unbounded `apt-get update` stalled on a dead runner mirror, ran out the Playwright lane's budget, and `build`/`publish` were skipped, leaving a tag with no Release. The ceilings are sized from measured run history (build legs 1.4–5.9 min, docs build ~1.6 min), not guessed.

Package installs go through the local composite action **`.github/actions/apt-install`** rather than a bare `apt-get` — it bounds each call with `timeout -k`, waits for the dpkg lock instead of failing instantly on it, repairs an interrupted dpkg on the way out, and can skip entirely when the binary is already on the runner image. It deliberately does **not** retry: the failure it exists for is a mirror stall, which a retry does not help, and nesting retry budgets inside a timeout is how three earlier versions of it were wrong. Re-running the lane is the retry. Two traps are worth knowing before editing any of this:

- A step-level `timeout-minutes` on a step that `uses:` a composite action **does not** propagate into that action's steps ([actions/runner#1979](https://github.com/actions/runner/issues/1979)). The action carries its own `timeout`, and the calling job's ceiling is the outer net. There are deliberately no step-level ceilings on `uses:` steps in this repo — the one that remains, on `Install Playwright browsers`, is a plain `run:` step where it genuinely applies.
- `npx playwright install --with-deps` runs apt *inside* itself, out of reach of any argument. The action therefore writes `/etc/apt/apt.conf.d/99-ci-timeouts` for the whole job as its first act — before its own skip probe, so the policy lands even when the install is skipped. apt ships with `Acquire::Retries` at 0 and no dpkg lock wait for `apt-get`, so without it a dropped index fetch is simply lost and a lock held by `unattended-upgrades` fails instantly.

The only check to require in branch protection is the aggregator job **`ci-light-gate`** — not the inner `fast` check. `ci.yml` filters at the job level (a `changes` job skips the fast lane for docs/assets-only PRs) and ends in an always-running gate job that reports success when its lane succeeded *or* was skipped. Requiring the gate (rather than an inner check that simply doesn't report on a skipped docs-only PR) keeps required checks from wedging trivial PRs in a permanent "Expected" state.

## Documentation changes

This documentation site lives at `docs/` in the same repo. The mkdocs nav is at `mkdocs.yml`. To preview locally:

```bash
pip install mkdocs-material
mkdocs serve     # → http://localhost:8000
```

Conventions:

- Every **content page** in `get-started/`, `tutorials/`, `guides/`, `reference/`, and `explanation/` declares its **Audience** at the top, immediately under the H1. Section index pages, the home page, `legal.md`, and the in-app help bodies under `docs/help/` are exempt.
- Diátaxis layout: tutorials teach, guides solve, reference looks up, explanation explains.
- Cross-link to neighbouring pages.
- `docs/help/*.md` is a **special case**: those six files are loaded from inside the packaged asar by the in-app Help menu. Keep them self-contained, and use **absolute `https://condash.vcoeur.com/…` URLs** for every off-page link — `help-modal.tsx` routes only `http(s)`, `mailto:`, and in-page anchors, so a relative link renders as clickable text that silently does nothing inside the app. The filenames are an allowlist (`src/main/help.ts`), mirrored in the `HelpDocName` union, the Help menu, the modal's title map, `electron-builder.yml`, and `tests/help-loader.spec.ts` — renaming or adding one means touching all six.

Every code change that affects user-visible behaviour ships with a docs update in the same commit.

!!! warning "Docs drift is not caught by CI"

    Nothing in the test suite reads `docs/reference/*`. The only docs-touching test is `tests/help-loader.spec.ts`, which asserts the six in-app help files load non-empty and that `help/cli.md` contains one literal string. `config-schema.test.ts` enforces key *casing*, not doc parity. So a config key, IPC verb, flag, or exit code can be renamed with a green build and a wrong page — **the docs are only as current as the commit that changed the code**. That is why "same commit" above is a hard rule rather than a nicety.

Docs also do **not** deploy on merge. `.github/workflows/docs.yml` triggers on a completed `release` workflow run or a manual dispatch, so a docs-only fix reaches `condash.vcoeur.com` at the next tag (or when someone dispatches the workflow), not when it lands on `main`.

## Issues, PRs, releases

- **Issues** — file at [`github.com/vcoeur/condash/issues`](https://github.com/vcoeur/condash/issues). For bugs, include the OS, the condash version (**Help → About Condash**), and a minimal repro tree if you can.
- **PRs** — branch from `main`, open a PR against `main`. The PR template asks for a Summary, a Changes list, and an optional Impact / Watchpoints section.
- **Releases** — tagged `vMAJOR.MINOR.PATCH`. PATCH for bug fixes and docs; MINOR for new behaviour; MAJOR for breaking config or Markdown changes. The version is derived from the tag — **no version-bump commit**; push the tag on a merged commit and `release.yml`'s `publish` job runs automatically (gated behind the heavy CI matrix).

## What to work on

Three good places to start:

1. **Issues tagged `good first issue`** at the issue tracker.
2. **A page that has drifted.** Because [nothing in CI checks the docs](#documentation-changes), a careful read of one reference page against its source file is genuinely useful work, and it needs no build environment.
3. **A feature you want yourself.** condash exists because someone wanted it; the next feature probably will too.

Before starting on anything large, open an issue with the proposed approach and link to the values it serves. A 200-word issue saves a 2000-word PR rewrite.

## See also

- [Values](values.md) — the principles a contribution should serve.
- [Non-goals](non-goals.md) — things contributions should not try to be.
- [Internals](internals.md) — load-bearing invariants worth understanding before touching the main process.
- [`AGENTS.md`](https://github.com/vcoeur/condash/blob/main/AGENTS.md) — the developer-instructions file checked into the repo (CLAUDE.md is the [agedum](../reference/skill.md#the-harness-launcher-agedum)-rendered view, gitignored).
