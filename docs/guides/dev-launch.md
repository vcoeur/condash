---
title: Dev launch · condash guide
description: Run condash from a clone of the repo with hot-reload — installer-free, the path every contributor uses.
---

# Dev launch

> **Audience.** Contributor — anyone running condash from source instead of an installer.

**When to read this.** You cloned the repo, want to run the dashboard against your local code, and need to know which `make` target does what.

## One-time install

```bash
git clone https://github.com/vcoeur/condash.git
cd condash
make install
```

`make install` is just `npm install` — `electron-rebuild` then fires from the package's `postinstall` hook, rebuilding native modules against the bundled Electron's Node ABI. That distinction matters when you're debugging a failed rebuild: re-running `npm install` re-runs it; nothing in the Makefile does.

The rebuild step is the one that fails on a missing C/C++ toolchain — see [Contributing — prerequisites](../explanation/contributing.md#prerequisites) for the per-OS package list.

## The watch loop

```bash
make dev
```

`make dev` runs three things concurrently:

- **`dev:main`** — esbuild in `--watch` mode, rebundling `src/main/` and the preload on every save.
- **`dev:renderer`** — `vite`, serving the renderer at `localhost:5600` with hot module reload.
- **`dev:electron`** — `electron`, opening a single `BrowserWindow` against the dev URL once both the port and the main bundle are ready.

**There is no typechecker in the loop.** esbuild strips types without checking them, so a type error will not stop `make dev` — run `npm run typecheck` (`tsc --noEmit` over both tsconfigs) yourself, or let CI catch it.

Renderer edits hot-reload. Main / preload edits are rebundled but need the window reloaded to take effect: **`Ctrl+Shift+R`** (View → Reload window). Note that `Ctrl+R` is *not* reload here — that accelerator is given to **View → Show Resources**, which is more useful day to day.

If port `5600` is in use, `make kill` frees it. The production preview served by `vite preview` uses `5601`; both are `strictPort`, so a busy port fails loudly rather than silently sliding to the next one.

## Tests and gates

The other half of the loop:

| Target | What it does |
|---|---|
| `make test` | Build, then run the Playwright suite. **Headless by default** — the runner wraps the suite in a throwaway Xvfb display so no window ever steals your focus. |
| `make test-headless` | Same thing, named explicitly. |
| `make test-visible` | Build and run with the window visible (`CONDASH_TEST_HEADED=1`). |
| `make test-unit` | The vitest unit suite, no build needed. |
| `make deadcode` | `knip` — fails on dead files, dead/unlisted deps, and duplicate exports. |
| `make typecheck` | `tsc --noEmit` over main and renderer. |
| `make format` | Prettier over `src/`. |

A direct `npx playwright test` that skips the wrapper is aborted by a global-setup guard before any window opens — that guard is deliberate, not an obstacle to route around.

## `--no-sandbox` and the sandbox toggle

`make dev` runs Electron with `--no-sandbox` to avoid per-worktree `chrome-sandbox` ownership fixes. The dev window only loads `localhost:5600` and local `file://` URLs — the threat surface is local-only.

If you want the sandbox on while developing, drop `--no-sandbox` from `dev:electron` in `package.json` and then, once per worktree:

```bash
sudo chown root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

macOS and Windows are unaffected — the sandbox there does not require the SUID step.

## See also

- [Contributing](../explanation/contributing.md) — full clone-to-PR workflow including testing and style.
- [CLI](../reference/cli.md) — the runtime command-line surface, useful once you have a build to drive.
