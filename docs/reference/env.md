---
title: Environment variables · condash reference
description: The short list of environment variables condash reads.
---

# Environment variables

> **Audience.** Daily user and Developer.

## At a glance

| Name | Purpose | Default | Accepted values |
|---|---|---|---|
| `CONDASH_CONCEPTION_PATH` | One-shot conception-path override | unset | Any absolute path |
| `CONDASH_FORCE_DEVICE_SCALE_FACTOR` | Force a fixed integer scale (Wayland fallback) | unset | Positive number |
| `CONDASH_FORCE_PROD` | Force the renderer to load the packaged build (Playwright fixture) | unset | `1` or unset |
| `SHELL` | Fallback for `terminal.shell` | `/bin/bash` | Absolute path to an interactive shell |
| `XDG_CONFIG_HOME` | Linux per-user config root | `~/.config` | Any absolute path |
| `ELECTRON_DISABLE_SANDBOX` | Disable Chromium's setuid sandbox | unset | `1` or unset |

condash itself reads almost no environment variables — configuration lives in `settings.json` (per-user) and `configuration.json` (per-tree). The handful of vars below either feed Electron's startup or back the embedded terminal.

## `SHELL`

Standard POSIX shell variable. Used as the fallback command when `terminal.shell` is not configured in `configuration.json` or `settings.json`. The embedded terminal spawns a node-pty session running this shell.

## `XDG_CONFIG_HOME`

Linux only. Controls where `settings.json` is written. The path resolves to `${XDG_CONFIG_HOME:-~/.config}/condash/settings.json`, owned by Electron's `app.getPath('userData')`. Override only if your distro forces a non-standard XDG layout.

macOS and Windows ignore this variable — they use `~/Library/Application Support/condash/` and `%APPDATA%\condash\` respectively.

## `ELECTRON_DISABLE_SANDBOX`

Set by Electron itself when launched with `--no-sandbox` (the dev script in `package.json:dev:electron` does exactly this; the AppImage's patched `AppRun` does the same — see [Install](../get-started/install.md#linux-appimage)).

You should not set this manually for the production `.deb` build — it installs `chrome-sandbox` SUID-root at `/opt/condash/`, and disabling the sandbox there is a net regression.

## `CONDASH_CONCEPTION_PATH`

A one-shot override for the conception path. When set, it wins over the `conception_path` value in `settings.json`. Useful for:

- Pointing condash at a scratch tree without editing settings.
- Demoing against a specific tree from a script.
- Running multiple condash instances against different trees from different shells.

The override is **session-scoped** — it is not persisted back into `settings.json`, and the next launch without the env var falls back to the saved value.

## `CONDASH_FORCE_DEVICE_SCALE_FACTOR`

Linux + Wayland fallback for fractional-scaling issues on uncommon compositors. When set to a number (e.g. `1.5`), Chromium renders at that fixed integer-divisible scale and the compositor down-scales — useful when the default `WaylandFractionalScaleV1` negotiation produces blurry output on a specific compositor. Leave unset on every other configuration.

## `CONDASH_FORCE_PROD`

Set by the Playwright e2e fixture to force the renderer to load the packaged `dist/` build via `file://`, bypassing the Vite dev URL. Not intended for direct use.

## Not read from the environment

- `CONDASH_ASSET_DIR` — the Electron build has no equivalent. Use `make dev` for the Vite hot-reload loop instead; the production renderer bundle is served from `dist/` inside the asar at runtime.
- `CONDASH_PORT` — there is no embedded HTTP server. The Vite dev server listens on `5600` (configured in `vite.config.ts`, `Makefile`, `package.json` together — see the dev-port checklist in `CLAUDE.md`).
- `CONCEPTION_PATH` — despite the [management skill](skill.md) reading it, condash itself does not.
- `NO_COLOR`, `CLICOLOR`, `FORCE_COLOR` — unused. The dashboard's colour scheme is driven by the theme toggle.
- `VISUAL`, `EDITOR` — condash doesn't spawn a system `$EDITOR` itself. The "Open in editor" buttons resolve through `settings.json:open_with` slots.

## Cross-reference

- [Config files](config.md) — the `settings.json` + `configuration.json` schema.
- [Environment hygiene](../explanation/internals.md#environment-hygiene) — how condash strips `PYTHONHOME` / `PYTHONPATH` / `PERLLIB` / `QT_PLUGIN_PATH` / `GSETTINGS_SCHEMA_DIR` from spawned subprocesses, and why the AppImage build also patches `AppRun` so the leak doesn't reach launchers it spawns.
