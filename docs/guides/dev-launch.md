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

Renderer edits hot-reload. Main / preload edits are rebundled but need the window reloaded to take effect: **`Ctrl+Shift+R`** (View → Reload window).

If port `5600` is in use, `make kill` frees it. The production preview served by `vite preview` uses `5601`; both are `strictPort`, so a busy port fails loudly rather than silently sliding to the next one.

## Tests and gates

The other half of the loop:

| Target | What it does |
|---|---|
| `make test` | Build, then run the Playwright suite. **Headless by default** — the runner wraps the suite in a throwaway Xvfb display so no window ever steals your focus. |
| `make test-headless` | Same thing, named explicitly. |
| `make test-visible` | Build and run with the window visible (`CONDASH_TEST_HEADED=1`). |
| `make test-unit` | The vitest unit suite, no build needed. |
| `make gate` | The pre-push gate: the full fast lane (format-check, typecheck, build, unit suite, knip) run locally under CI's umask 022 — mirrors `.github/workflows/_fast.yml`. |
| `make hooks` | One-time wiring: point `core.hooksPath` at `.githooks/` so the pre-push gate below runs on every push. |
| `make deadcode` | `knip` — fails on dead files, dead/unlisted deps, and duplicate exports. |
| `make typecheck` | `tsc --noEmit` over main and renderer. |
| `make format` | Prettier over `src/`. |

A direct `npx playwright test` that skips the wrapper is aborted by a global-setup guard before any window opens — that guard is deliberate, not an obstacle to route around.

## Pre-push gate

After `make hooks` has been run once (repo-local config — every clone needs it once, and because the setting is shared across worktrees and `.githooks/` is a tracked directory, it then applies to every worktree of that clone), a `git push` first runs `.githooks/pre-push`, which runs `make gate`.

`make gate` runs the same five steps the CI fast lane (`.github/workflows/_fast.yml`) runs, in the same order, delegating to the same Makefile targets: `format-check`, `typecheck`, `build`, `test-unit`, `deadcode`. Its whole sequence runs under `umask 022` — not cosmetics: a local gate that runs the suites under a dev host's *ambient* environment re-creates the exact masking it exists to catch. One dev machine's ambient umask `002` (vs CI's `022`) masked a 152/194 recovery-suite failure until CI found it; the gate is only worth having if it reproduces CI's file-permission environment.

Skip semantics:

- **`CONDASH_SKIP_GATE=1`** — exits 0 immediately, without running the gate. For a push you know is fine and don't want to wait out the minutes for (a docs-only branch, a WIP mirror).
- **`--no-verify`** also skips the hook, but skips *every* hook, not just this gate — prefer the env var.
- The hook itself skips the gate and exits 0 when the push sends no new commits: a branch deletion (null new sha), or a push whose remote ref already equals the local one. There is nothing new to gate.
- If `node_modules` is missing, the hook fails fast with a "run `npm ci` first" message instead of a confusing vitest crash.
- Before the gate runs, the hook strips git's hook environment (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`, `GIT_CONFIG_PARAMETERS`, ...): a child git resolves its repo from those variables instead of its own `cwd`, and the gate's test fixtures spawn git with explicit `cwd` values — with the handoff inherited, every fixture git call lands in the real repository instead of its own temporary one. CI and manual `make gate` runs never have those variables set, so the unset is a no-op there.
- On failure the hook exits non-zero after naming the failed step family — fix it and push again; the push never happened, so nothing was published half-checked.

The recovery suites' private fixture base resolves, in order: an explicit `CONDASH_VITEST_RECOVERY_PARENT`, then `~/.condash-recovery-vitest`, then — only when the home root is not writable (an agent sandbox mounting `/home` read-only) — `~/.local/state/condash-recovery-vitest`. A gated push from such a sandbox needs no variable exported.

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
