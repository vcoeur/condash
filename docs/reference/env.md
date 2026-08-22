---
title: Environment variables · condash reference
description: Every environment variable condash reads — the GUI, the CLI, and the spawned-subprocess environment — and the ones it deliberately doesn't.
---

# Environment variables

> **Audience.** Daily user and Developer.

## At a glance

| Name                                | Purpose                                                                                         | Default     | Accepted values                       |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- | ----------- | ------------------------------------- |
| `CONDASH_CONCEPTION_PATH`           | One-shot conception-path override (legacy alias `CONDASH_CONCEPTION` still accepted — CLI only) | unset       | Any absolute path                     |
| `CLAUDE_PROJECT_DIR`                | Back-compat alias for `CONDASH_CONCEPTION_PATH` in Claude Code sessions (CLI only)              | unset       | Any absolute path                     |
| `CONDASH_FORCE_DEVICE_SCALE_FACTOR` | Force a fixed integer scale (Wayland fallback)                                                  | unset       | Positive number                       |
| `CONDASH_FORCE_PROD`                | Force the renderer to load the packaged build (Playwright fixture)                              | unset       | `1` or unset                          |
| `CONDASH_DEV_USER_DATA_DIR`         | Redirect Electron's `userData` dir for an unpackaged dev launch                                 | unset       | Any absolute path                     |
| `SHELL`                             | Fallback for `terminal.shell`                                                                   | `/bin/bash` | Absolute path to an interactive shell |
| `XDG_CONFIG_HOME`                   | Linux per-user config root                                                                      | `~/.config` | Any absolute path                     |
| `ELECTRON_DISABLE_SANDBOX`          | Disable Chromium's setuid sandbox                                                               | unset       | `1` or unset                          |
| `NO_COLOR`                          | **CLI only** — any non-empty value disables ANSI styling                                        | unset       | Any non-empty value                   |
| `CLICOLOR`                          | **CLI only** — the literal `0` disables ANSI styling; nothing else is read                      | unset       | `0`, or unset                         |
| `DEEPSEEK_API_KEY`                  | Fallback for `dashboard.apiKey` when the key is not in `settings.json`                          | unset       | Provider API key                      |
| `DEEPSEEK_BASE_URL`                 | Fallback for `dashboard.baseUrl`                                                                | unset       | OpenAI-compatible base URL            |
| `CONDASH_CLI_VERSION`               | Version string the CLI reports; baked in at build time                                          | `dev`       | Any string                            |
| `CONDASH_CLI_DEBUG`                 | **CLI only** — print the JS stack alongside a runtime error                                     | unset       | Any non-empty value                   |
| `CONDASH_TEMPLATE_ROOT`             | Override the shipped `conception-template/` root                                                | bundled     | Any absolute path                     |
| `CONDASH_USER_SKILLS_ROOT`          | Override the user-scope skills root the Skills pane reads (test seam)                           | `~/.config/agents/skills` | Any absolute path       |
| `CONDASH_USER_AGENTS_MD`            | Override the user-scope `AGENTS.md` the Skills pane reads (test seam)                           | `~/.config/agents/AGENTS.md` | Any absolute path    |
| `CONDASH_BENCH`                     | **Test only** — run the opt-in terminal-logger benchmark assertions                            | unset       | `1` or unset                          |

condash reads few environment variables — configuration lives in `settings.json` (per-user) and `.condash/settings.json` (per-tree). The vars above either feed Electron's startup, back the embedded terminal, or exist as CLI ergonomics and test seams.

A handful of standard POSIX / platform variables are consulted as fallbacks and never as configuration: `HOME` (default worktrees root when `worktrees_path` is unset), `APPDATA` (the Windows equivalent of `XDG_CONFIG_HOME`), `ComSpec` (Windows shell fallback when `SHELL` is unset), `XDG_SESSION_TYPE` (Wayland detection), and `XDG_RUNTIME_DIR` (the systemd-scope capability probe behind [`terminal.memory`](config.md#terminal-memory)). The inherited `PATH` is kept as the fallback when the [login-shell probe](#login-shell-path-for-spawned-subprocesses) can't resolve one.

## `SHELL`

Standard POSIX shell variable. Used as the fallback command when `terminal.shell` is not configured in the per-machine `settings.json` (`terminal` is a global-only key). On Windows, where `SHELL` is normally unset, the chain falls through to `ComSpec` and then `cmd.exe`. The embedded terminal spawns a node-pty session running the resolved shell. `$SHELL` is also the shell condash probes once at startup to resolve your login-shell PATH (next section).

## Login-shell PATH for spawned subprocesses

GUI-launched condash (a Wayland session, the macOS Dock, a `.desktop` entry) never sources your login dotfiles (`~/.profile`, `~/.zprofile`, `~/.bash_profile`), so the PATH it inherits is missing anything you added there. Without help, the embedded terminal, repo **Run** commands, `force_stop`, and "open in IDE" launchers can't find user-installed CLIs (`opencode`, `~/bin` wrappers, `~/.local/bin` tools).

condash resolves this once at startup: it spawns `$SHELL` as a login + interactive shell, reads the PATH that shell exports, caches the result, and uses it as the PATH for every subprocess it spawns. No configuration and no dotfile changes are required — keep your PATH wherever your login shell already reads it.

- **PATH only.** Every other variable keeps its inherited value; the pty-only `TERM` and `npm_config_*` edits are applied on top of it, and nothing else is touched. Design rationale: [environment hygiene](../explanation/internals.md#environment-hygiene).
- **Timeout-guarded.** A hung rc-file can't block startup — after 5 s condash falls back to the inherited PATH.
- **Resolved once.** Edit a dotfile after launch → restart condash to pick it up.
- **POSIX only.** On Windows the PATH is inherited as-is.

## `XDG_CONFIG_HOME`

Linux only. Controls where `settings.json` is written. The path resolves to `${XDG_CONFIG_HOME:-~/.config}/condash/settings.json`, owned by Electron's `app.getPath('userData')`. Override only if your distro forces a non-standard XDG layout.

macOS and Windows ignore this variable — they use `~/Library/Application Support/condash/` and `%APPDATA%\condash\` respectively.

## `ELECTRON_DISABLE_SANDBOX`

Set by Electron itself when launched with `--no-sandbox` (the dev script in `package.json:dev:electron` does exactly this; the AppImage's patched `AppRun` does the same — see [Install](../get-started/index.md#linux-appimage)).

You should not set this manually for the production `.deb` build — it installs `chrome-sandbox` SUID-root at `/opt/condash/`, and disabling the sandbox there is a net regression.

## `CONDASH_CONCEPTION_PATH`

A one-shot override for the conception path. When set, it wins over the `lastConceptionPath` value in `settings.json`. Useful for:

- Pointing condash at a scratch tree without editing settings.
- Demoing against a specific tree from a script.
- Running multiple condash instances against different trees from different shells.

The override is **session-scoped** — it is never persisted back into `settings.json`: every settings write (theme, layout, any other preference saved while the env var is set) starts from the on-disk state, so `lastConceptionPath` keeps the saved value and the next launch without the env var falls back to it.

The legacy name `CONDASH_CONCEPTION` is still accepted for back-compat (skills and scripts written before the rename keep working); when both are set, `CONDASH_CONCEPTION_PATH` wins. The legacy alias is **CLI-only** — the Electron app reads only `CONDASH_CONCEPTION_PATH`.

## `CLAUDE_PROJECT_DIR`

Back-compat alias for `CONDASH_CONCEPTION_PATH`. Used by Claude Code sessions where the `CLAUDE_PROJECT_DIR` variable is already set. When both are set, `CONDASH_CONCEPTION_PATH` wins. **CLI-only** — the Electron app ignores it.

## `CONDASH_FORCE_DEVICE_SCALE_FACTOR`

Linux + Wayland fallback for fractional-scaling issues on uncommon compositors. When set to a number (e.g. `1.5`), Chromium renders at that fixed integer-divisible scale and the compositor down-scales — useful when the default `WaylandFractionalScaleV1` negotiation produces blurry output on a specific compositor. Leave unset on every other configuration.

## `CONDASH_FORCE_PROD`

Forces the renderer to load the built `dist/` bundle via `file://` instead of the Vite dev URL, for any unpackaged launch that is not `npm run dev`. Set by the Playwright e2e fixture and by every script that drives a real app — `scripts/snap.mjs`, `scripts/perf-baseline.mjs`, `scripts/perf-load.mjs`.

Omitting it in such a script is a silent failure, not a loud one: `isDev` stays true, the app navigates to a dev server nobody started, and the run continues against a renderer that never mounted. Note that forcing prod mode also skips the dev `userData` redirect, so an isolated launch must pass `--user-data-dir` and verify the live path rather than relying on `CONDASH_DEV_USER_DATA_DIR`.

## `NO_COLOR` / `CLICOLOR` { #no_color-clicolor }

**CLI only.** `condash <noun> <verb>` decides ANSI styling from four inputs, in this order:

1. The explicit `--no-color` flag wins.
2. Styling is off whenever stdout is not a TTY — pipes, redirection, CI logs.
3. `NO_COLOR` set to **any non-empty value** disables it ([no-color.org](https://no-color.org)).
4. `CLICOLOR` set to exactly `0` disables it ([bixense.com](https://bixense.com/clicolors/)). Any other value is ignored.

There is no way to force styling back **on** — `FORCE_COLOR` is not read, and neither is `CLICOLOR_FORCE`. None of this touches the Electron GUI, whose colours come from the `theme` setting.

## `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`

Fallbacks for the [`dashboard`](config.md#dashboard) block's `apiKey` and `baseUrl`. The settings value wins when it is set and non-blank; the environment fills in otherwise. This exists so a headless or CI run can supply the key without writing it into the per-machine `settings.json` — the same reason `apiKey` is a global-file-only key. A blank `baseUrl` on both sides means the provider's built-in endpoint.

Setting these does **not** enable the dashboard: `dashboard.enabled` is still off by default, and nothing leaves the machine until you turn it on.

## `CONDASH_CLI_VERSION`, `CONDASH_CLI_DEBUG`

Both are CLI-only.

- **`CONDASH_CLI_VERSION`** is baked into the bundle at build time by `scripts/build-cli.mjs` and is what `condash --version` prints; it is also stamped into the `.agents/.condash-skills.json` manifest by `condash skills install`. An unbuilt bundle reports `dev`. You would only set it by hand when building the CLI yourself.
- **`CONDASH_CLI_DEBUG`**, when non-empty, makes a runtime failure print the underlying JS stack after the `error: …` line. Off by default so a scripted caller gets one clean line on stderr.

## `CONDASH_TEMPLATE_ROOT`, `CONDASH_USER_SKILLS_ROOT`, `CONDASH_USER_AGENTS_MD`

Override hatches, primarily for tests. Nothing in normal use needs them.

- **`CONDASH_TEMPLATE_ROOT`** replaces the bundled `conception-template/` root that the **CLI** ships skills and marker regions from ([`condash skills install`](cli.md#skills)). Point it at a checkout to test skill sources without rebuilding the bundle. The GUI resolves its own copy from `app.getAppPath()` and ignores this variable.
- **`CONDASH_USER_SKILLS_ROOT`** and **`CONDASH_USER_AGENTS_MD`** relocate the two paths the Skills pane reads in its **user** scope — by default `~/.config/agents/skills/` and `~/.config/agents/AGENTS.md`, the [agedum](skill.md#the-harness-launcher-agedum) sources. The pane is read-only in that scope either way.

## `CONDASH_BENCH`

**Test only — never set it in normal use.** The terminal-logger benchmark suite (`src/main/terminal-logger-bench.test.ts`) is skipped by default because its arms are sized to measure, not to assert quickly. Set `CONDASH_BENCH=1` to opt in:

```
CONDASH_BENCH=1 npm run test:unit -- src/main/terminal-logger-bench.test.ts
```

The benchmark compares the incremental grid-body flush against a pinned copy of the pre-change flush and asserts both arms still produce the right bytes — see the terminal-logging notes in `AGENTS.md` for what the ratios mean and which ones are real.

## Not read from the environment

- `CONDASH_ASSET_DIR` — the Electron build has no equivalent. Use `make dev` for the Vite hot-reload loop instead; the production renderer bundle is served from `dist/` inside the asar at runtime.
- `CONDASH_PORT` — there is no embedded HTTP server. The Vite dev server listens on `5600` (configured in `vite.config.ts`, `Makefile`, `package.json` together — see the dev-port checklist in `AGENTS.md`).
- `CONCEPTION_PATH` — the unprefixed name is not read anywhere. Use `CONDASH_CONCEPTION_PATH`.
- `FORCE_COLOR` — not read. Its two siblings **are**: see [`NO_COLOR` / `CLICOLOR`](#no_color-clicolor) below. The GUI's colour scheme is driven entirely by the theme setting, not by any environment variable.
- `VISUAL`, `EDITOR` — condash doesn't spawn a system `$EDITOR` itself. The "Open in editor" buttons resolve through `settings.json:open_with` slots.

## What a spawned subprocess inherits

Every child condash starts inherits a copy of condash's own environment, with `PATH` replaced by the resolved login-shell PATH (above). **How much more is done to it depends on whether the child is a pty:**

| Child | Environment |
|---|---|
| A terminal tab, a Code-pane **Run**, a scheduled task run | All three edits below — these are pty spawns. |
| An open-with launcher, a `force_stop` | The PATH replacement only. They are spawned directly (`shell: false`, no pty), so neither `TERM` nor the `npm_config_*` scrub applies. |

The three edits, in full:

1. `PATH` replaced by the resolved login-shell PATH (above) — **every** child gets this one.
2. `TERM` forced to `xterm-256color`.
3. `npm_config_prefix`, `npm_config_globalconfig`, and `npm_config_userconfig` **deleted**. Electron inherits these from whatever shell launched it, and a global `npm_config_prefix` breaks nvm in a child shell.

So an IDE started through an `open_with` slot still carries whatever `npm_config_prefix` Electron was launched with — if that breaks a tool inside the IDE, scrub it in the launcher command rather than expecting condash to have done it.

Nothing else is removed. In particular, a POSIX `run:` command is deliberately run through a **non-login** shell (`-c`, not `-lc`): a login shell would re-source `~/.profile` and undo the scrub, and the login-shell PATH is already injected by the mechanism above. Prefix your command with `bash -lc` yourself if you want full login behaviour.

## Cross-reference

- [Config files](config.md) — the `settings.json` + `.condash/settings.json` schema.
- [Environment hygiene](../explanation/internals.md#environment-hygiene) — the same three edits from the design side, including why the interpreter-specific variables an AppImage runtime can leak (`PYTHONHOME`, `PERLLIB`, `QT_PLUGIN_PATH`, …) are *not* scrubbed, and the AppImage-launcher side of the same problem.
