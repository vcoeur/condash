---
title: Troubleshooting · condash guide
description: Common problems, what they look like, and how to fix them — installer refusals, empty dashboards, stuck terminals, missing repos.
---

# Troubleshooting

> **Audience.** New user and Daily user — anything that surprises someone using condash for real work.

If you hit something not on this page, file an [issue](https://github.com/vcoeur/condash/issues) with the OS, condash version (footer of the dashboard), and a minimal repro.

## Install / first launch

### "App can't be opened — developer cannot be verified" (macOS)

condash is unsigned on purpose. macOS asks you to confirm the download once. The bypass differs between Sonoma and Sequoia — see **[Install — macOS Gatekeeper bypass](../get-started/install.md#macos-gatekeeper-bypass)**.

### "Windows protected your PC" (Windows)

Click **More info → Run anyway**. SmartScreen flags every unsigned binary the first time it sees it. See **[Install — Windows SmartScreen bypass](../get-started/install.md#windows-smartscreen-bypass)**.

### AppImage exits silently with no window (Linux)

Most likely a missing system library. Run the AppImage from a terminal so you can see stderr:

```bash
./condash-*.AppImage
```

If the error mentions `libnss`, `libgtk`, or `libatk-bridge`, install Electron's runtime deps:

```bash
sudo apt install libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1   # Debian/Ubuntu
sudo dnf install nss atk at-spi2-atk gtk3 mesa-libgbm             # Fedora
```

### Folder picker keeps coming back at every launch

condash should remember the conception path you picked. If the picker reappears every time, check the per-machine settings file:

```bash
cat ${XDG_CONFIG_HOME:-~/.config}/condash/settings.json
```

If `conception_path` is not set or points to a directory that no longer exists, condash falls back to the picker. Edit the file by hand to fix it, or pick the right path through the picker once more — condash writes the choice on success.

## Empty dashboard

### "Projects (0)" but my tree has READMEs

Check the conception path is correct (footer of the dashboard, or `cat settings.json`). If the path is right but the count is zero, your items don't match the strict layout. condash only renders items at:

```
projects/YYYY-MM/YYYY-MM-DD-<slug>/README.md
```

Items at the wrong nesting depth (e.g. `projects/<slug>/` without a month directory) are skipped. The slug must match `^[a-z0-9-]+$` after the date prefix.

Fix: `git mv` the items into the right shape, or use the [`condash projects`](../reference/cli.md) verbs to validate.

### Code tab is empty / "Code (0)"

The Code tab scans `workspace_path` from `configuration.json` for direct subdirectories containing a `.git/`. Two common reasons it's empty:

- `workspace_path` is unset in `configuration.json`. Set it to the directory containing your repos.
- `workspace_path` points at a parent directory whose direct children are *not* git repos (e.g. an extra nesting level — `~/src/` when your repos are in `~/src/projects/`). The scan is one level deep.

Fix: open the gear modal and edit `workspace_path` to point at the right directory. The Code tab refreshes within a couple of seconds.

### Knowledge tab is empty

Same shape: condash looks for `<conception_path>/knowledge/`. If the directory is missing, the tab is hidden. Create it with `mkdir knowledge && echo "# Knowledge" > knowledge/index.md` — the tab appears immediately.

## Embedded terminal

### Terminal pane opens, but no shell prompt

The shell process exited immediately. Three common causes:

- The configured `terminal.shell` doesn't exist (`/bin/zsh` on a system without zsh installed). Fall back to `/bin/bash` in `settings.json`.
- The shell rc-file (`.bashrc`, `.zshrc`) errors out. Open the same shell in a separate terminal to see the error.
- (Linux only) `node-pty` was built against the wrong Node ABI. This shouldn't happen for the packaged `.AppImage` / `.deb`. If it does, file an issue with the version.

### `Ctrl+C` copies instead of sending SIGINT (or vice versa)

`Ctrl+C` does **double duty**: copy the current selection if there is one, otherwise send SIGINT. So if you've highlighted some output and hit `Ctrl+C`, you'll copy it. Click somewhere else to clear the selection, then `Ctrl+C` interrupts.

### Terminal pane is missing on Windows

The terminal works on all three platforms. If the pane fails to open on Windows, check that PowerShell or `cmd.exe` resolves through `process.env.ComSpec` and that no system-level policy is blocking child-process creation.

## "Open in IDE" buttons do nothing

The buttons spawn the command in `open_with.<slot>.command` from `settings.json` (per-machine) or `configuration.json` (tree-wide). Two failure modes:

- The command isn't on `$PATH` (typical for macOS GUI editors that don't install a shell launcher). Use the `open -na` form on macOS — see [Config files — Per-OS recipes](../reference/config.md#per-os-recipes).
- The path being passed isn't under `workspace_path` or `worktrees_path`. condash refuses to spawn launchers outside those sandboxes; check the toast message.

## Auto-update

### "An update was downloaded" toast, but condash doesn't restart

`electron-updater` downloads the new build silently and prompts to restart. If the prompt appears but nothing happens after clicking restart:

- **macOS** — re-flagged by Gatekeeper. Drop the quarantine attribute and reopen:
  ```bash
  xattr -dr com.apple.quarantine /Applications/condash.app
  ```
- **Linux AppImage** — make sure the AppImage lives somewhere writable by your user (not under `/opt/`). `electron-updater` rewrites the file in place.
- **Linux apt** — apt-installed users are exempt from in-app updates. `sudo apt update && sudo apt upgrade` is the update path.

### Auto-update is checking too often / not at all

The check fires once per launch. If you keep condash open for days, the update toast may never appear — relaunch to trigger a check, or watch the [releases page](https://github.com/vcoeur/condash/releases) directly.

## File-edit conflicts

### "Reload before saving" toast on every save

A drift check failed: the file on disk no longer matches what condash had cached. Two reasons:

- You edited the file in your editor while the dashboard had an older version. **Click the refresh icon** in the dashboard header, then redo the change.
- A chokidar event was missed (rare; usually a network filesystem). Same fix.

### My step toggles silently undo themselves

Same root cause as above. The renderer flips the marker optimistically, the IPC write fails the drift check, and the renderer rolls back. Refresh the dashboard to pick up the on-disk state.

## Performance

### Refresh button takes longer than a second

The conception tree is too big or sits on a slow filesystem (network mount). condash re-walks the tree on each refresh — there is no index on purpose (see [Why no search index](../explanation/internals.md#why-no-search-index)). At a few hundred items this should be well under 50 ms; if you hit a noticeably slower wall, file an issue with the tree size and FS type.

### Embedded terminal is laggy under load

xterm.js renders a lot of cells on every paint. Two knobs help:

- Lower `terminal.xterm.scrollback` from the default 10 000 to something smaller (1 000).
- Toggle `terminal.xterm.ligatures` off — the ligatures addon is expensive on long lines.

Both keys live in `configuration.json` under `terminal.xterm`. The Settings → Terminal tab in the gear modal edits them live.

## CLI

### `condash projects list` says "no conception"

The CLI honours the same path-resolution chain as the GUI but does not open the folder picker. Point it explicitly:

```bash
condash --conception ~/src/conception projects list
```

Or set the path through `condash config conception-path ~/src/conception` (writes to `settings.json`, picked up by both the GUI and the CLI).

### `condash` opens the GUI when I expected the CLI

The CLI dispatcher only fires for known nouns (`projects`, `knowledge`, `search`, `repos`, `worktrees`, `dirty`, `skills`, `config`, `help`) or top-level `--help` / `--version`. A typo silently drops you into the GUI. See [`condash --help`](../reference/cli.md) for the full list.

## Still stuck?

- Open the [issue tracker](https://github.com/vcoeur/condash/issues) and search for the symptom.
- If nothing matches, file a new issue. Include OS, condash version, and minimum repro.
- For design questions, see [Why Markdown-first](../explanation/why-markdown.md), [Values](../explanation/values.md), and [Non-goals](../explanation/non-goals.md).
