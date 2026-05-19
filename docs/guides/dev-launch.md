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

`make install` runs `npm install` and then `electron-rebuild` against the bundled Electron's Node ABI. The rebuild step is the one that fails on a missing C/C++ toolchain — see [Contributing — prerequisites](../explanation/contributing.md#prerequisites) for the per-OS package list.

## The watch loop

```bash
make dev
```

`make dev` runs three things concurrently:

- `tsc --watch` typechecks `src/main/` and `src/renderer/` continuously (no emit; esbuild handles bundling).
- `vite` serves the renderer at `localhost:5600` with hot module reload.
- `electron` opens a single `BrowserWindow` against the dev URL. Main / preload changes restart on the next launch (`Ctrl+R` reloads the renderer in-place).

If port `5600` is in use, `make kill` frees it.

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
