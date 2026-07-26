---
title: Troubleshooting · condash guide
description: Common problems, what they look like, and how to fix them — installer refusals, empty dashboards, stuck terminals, missing repos.
---

# Troubleshooting

> **Audience.** New user and Daily user — anything that surprises someone using condash for real work.

If you hit something not on this page, file an [issue](https://github.com/vcoeur/condash/issues) with the OS, the condash version (**Help → About Condash**), and a minimal repro.

## Install / first launch

### "App can't be opened — developer cannot be verified" (macOS)

condash is unsigned on purpose. macOS asks you to confirm the download once. The bypass differs between Sonoma and Sequoia — see **[Install — macOS Gatekeeper bypass](../get-started/index.md#macos)**.

### "Windows protected your PC" (Windows)

Click **More info → Run anyway**. SmartScreen flags every unsigned binary the first time it sees it. See **[Install — Windows SmartScreen bypass](../get-started/index.md#windows)**.

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

If `lastConceptionPath` is not set or points to a directory that no longer exists, condash falls back to the picker. Edit the file by hand to fix it, or pick the right path through the picker once more — condash writes the choice on success.

## Empty dashboard

### "Projects (0)" but my tree has READMEs

Check the conception path is correct — it is the first thing in the **status bar along the top of the window**, or `cat settings.json`. If the path is right but the count is zero, your items don't match the strict layout. condash only renders items at:

```
projects/YYYY-MM/YYYY-MM-DD-<slug>/README.md
```

Items at the wrong nesting depth (e.g. `projects/<slug>/` without a month directory) are skipped. The slug must match `^[a-z0-9-]+$` after the date prefix.

Fix: `git mv` the items into the right shape, or use the [`condash projects`](../reference/cli.md) verbs to validate.

### Code pane is empty / "Code (0)"

The Code pane scans `workspace_path` from `.condash/settings.json` (or the legacy `condash.json`) for direct subdirectories containing a `.git/`. Two common reasons it's empty:

- `workspace_path` is unset. Set it to the directory containing your repos.
- `workspace_path` points at a parent directory whose direct children are *not* git repos (e.g. an extra nesting level — `~/src/` when your repos are in `~/src/projects/`). The scan is one level deep.

Fix: open Settings — the **Settings** button at the right of the status bar, `Ctrl+,`, or **File → Settings** — and edit `workspace_path` under **Workspace & paths** to point at the right directory. The Code pane refreshes within a couple of seconds.

### Knowledge pane is empty

Same shape: condash looks for `<conception_path>/knowledge/`. When the directory is missing the rail item stays put and the pane renders *"No knowledge/ directory under the selected conception path."* Create it with `mkdir knowledge && echo "# Knowledge" > knowledge/index.md` — the tree appears immediately.

## Embedded terminal

### Terminal pane opens, but no shell prompt

The shell process exited immediately. Three common causes:

- The configured `terminal.shell` doesn't exist (`/bin/zsh` on a system without zsh installed). Fall back to `/bin/bash` in `settings.json`.
- The shell rc-file (`.bashrc`, `.zshrc`) errors out. Open the same shell in a separate terminal to see the error.
- (Linux only) `node-pty` was built against the wrong Node ABI. This shouldn't happen for the packaged `.AppImage` / `.deb`. If it does, file an issue with the version.

### A command on my PATH isn't found in the terminal

condash resolves your **login-shell PATH** at startup and uses it for the embedded terminal, repo **Run** commands, and launchers — so CLIs you added in `~/.profile` / `~/.zprofile` (`opencode`, `~/bin` wrappers, `~/.local/bin` tools) resolve even when condash was started from the GUI. If a command still isn't found:

- Confirm it's actually on PATH in a **login** shell: `bash -lic 'command -v <cmd>'`. If that fails too, the entry is missing from your login dotfiles — not a condash problem.
- Resolution runs once at startup. If you edited a dotfile after launching condash, restart condash to re-resolve.
- A broken rc-file can make the probe time out (5 s), leaving the inherited PATH. Open the same shell in a separate terminal to check for errors.

### `Ctrl+C` copies instead of sending SIGINT (or vice versa)

`Ctrl+C` does **double duty**: copy the current selection if there is one, otherwise send SIGINT. So if you've highlighted some output and hit `Ctrl+C`, you'll copy it. Click somewhere else to clear the selection, then `Ctrl+C` interrupts.

### Terminal pane is missing on Windows

The terminal works on all three platforms. If the pane fails to open on Windows, check that PowerShell or `cmd.exe` resolves through `process.env.ComSpec` and that no system-level policy is blocking child-process creation.

## "Open in IDE" buttons do nothing

The buttons spawn the command in `open_with.<slot>.command`. **`open_with` is a personal, global-only key** — it lives in the per-machine `settings.json` and nowhere else; a conception's `.condash/settings.json` carrying it is rejected by the schema. Three failure modes:

- **The slot isn't configured at all.** There are no built-in defaults: a slot with no `command` produces no button, and asking for it explicitly errors with `open_with.<slot> is not configured`. Add the block — see [Repositories and open-with buttons](repositories-and-open-with.md#the-three-open_with-slots).
- The command isn't on `$PATH` (typical for macOS GUI editors that don't install a shell launcher). Use the `open -na` form on macOS — see [Config files — Per-OS recipes](../reference/config.md#per-os-recipes).
- The path being passed isn't under one of the three allowed roots — the **conception path**, `workspace_path`, or `worktrees_path`. condash refuses to spawn launchers outside those sandboxes; check the toast message.

Remember the command is **argv-split, not shell-parsed**: no `&&`, no pipes, no `$VAR`. If your command needs any of that, point the slot at a script.

## File-edit conflicts

### "Reload before saving" toast on every save

A drift check failed: the file on disk no longer matches what condash had cached. Two reasons:

- You edited the file in your editor while the dashboard had an older version. Refresh with **View → Refresh** (`F5`) — or the Projects pane's own refresh control — then redo the change.
- A chokidar event was missed (rare; usually a network filesystem). Same fix.

### My step toggles silently undo themselves

Same root cause as above. The renderer flips the marker optimistically, the IPC write fails the drift check, and the renderer rolls back. Refresh the dashboard to pick up the on-disk state.

## Performance

### Refresh button takes longer than a second

The conception tree is too big or sits on a slow filesystem (network mount). condash re-walks the tree on each refresh to re-read project READMEs and repo git state (the project list isn't indexed; [search](../explanation/internals.md#search-index) is). At a few hundred items this should be well under 50 ms; if you hit a noticeably slower wall, file an issue with the tree size and FS type.

### Embedded terminal is laggy under load

xterm.js renders a lot of cells on every paint. Two knobs help:

- Lower `terminal.xterm.scrollback` from its default of **5000** to something smaller (1000).
- Toggle `terminal.xterm.ligatures` off — the ligatures addon is expensive on long lines.

Both keys live under `terminal.xterm` in the **per-machine** `settings.json` — `terminal` is a global-only key, so there is one copy shared by every conception. The Settings modal's **Terminal** section edits them live; the modal has no tabs, just a scrolling surface with a section rail.

If that doesn't account for it, measure rather than guess. Open the **[Performance pane](performance-pane.md)** in the left band: per-tab memory, growth rate, and throttle state are always live, and pressing **Record** adds main-process event-loop delay — the most direct measure of UI stalls, since main is a single thread shared by every tab as well as git status, file watching, and all IPC. Records land in `<conception>/.condash/perf/`.

Disk logging (`terminal.logging.enabled`) is worth checking specifically: when it's on, the main process runs a second full ANSI parse of every byte, duplicating work the renderer already does. Turning it off is a quick A/B.

## A terminal tab disappeared

A tab that vanishes on its own was killed, not closed. Since the tab now reports why, look at the row before dismissing it: an abnormal exit **keeps its row** with a verdict badge and a **Restart** button, and only a clean `exit 0` auto-closes.

The verdicts that matter:

- **killed — out of memory (cap)** — the tab exceeded its own `MemoryMax` and its cgroup OOM killer stopped it. Raise `terminal.memory.max`, or find what in that tab is growing.
- **killed — out of memory (system pressure)** — the machine ran short of memory and an external killer (systemd-oomd, reacting to pressure) took the whole tab scope. The tab did **not** reach its own cap, so raising `terminal.memory.max` will not help; lowering `terminal.memory.high` so the tab throttles earlier, or reducing total load, will.
- **killed — SIGKILL** — killed from outside with no memory evidence. Also what you get when the cgroup counters could not be read at the moment of death: condash reports the honest "cause unknown" rather than attributing the kill from a sample window that closed before it happened.
- **exited — code N** — the program itself failed.
- **stopped** — you stopped it, closed the tab, or quit condash. Never an OOM verdict, even though the kill pipeline ends in SIGKILL: a tab resting near its `MemoryHigh` has the throttle counter ticking under ordinary reclaim, so without this a deliberate shutdown would record as a memory kill and pollute the log history.

The same verdict is written into the session's log footer under `.condash/logs/`, so a tab that died while you were away can still be diagnosed after the fact.

To catch the second case before it kills anything, watch the **[Performance pane](performance-pane.md)**: a tab marked **throttled** is one the kernel is actively reclaiming against, and that is the state tabs die in.

### If every tab shows the same memory figure

Fixed after v4.96.0. In v4.96.0 exactly, condash resolved a tab's cgroup immediately after spawning it — before `systemd-run` had migrated the child into its scope — so every tab cached condash's *own* app scope. The symptom is unmistakable: every row in the Performance pane shows an identical level, an identical growth rate, and moves in lockstep, because they are all reading one cgroup. Death verdicts on that build read the app's counters too, so they are not trustworthy. Upgrade; there is no workaround on that version.

To check which cgroup a tab is actually in on any version:

```bash
systemctl --user list-units --type=scope 'condash-*'
```

## CLI

### `condash projects list` says "no conception"

The CLI honours the same path-resolution chain as the GUI but does not open the folder picker. Point it explicitly:

```bash
condash --conception ~/src/conception projects list
```

To make it stick, write the path into the per-machine settings file:

```bash
condash config set lastConceptionPath ~/src/conception
```

Both the GUI and the CLI pick that up. Note that `condash config conception-path` **only prints** the resolved path and how it was resolved — it takes no argument and writes nothing; it is the verb to run when you want to know *which* tree the CLI thinks it is looking at.

### `condash` reports an unknown noun

The single `condash` binary dispatches GUI vs. CLI based on argv (see [CLI — How dispatch works](../reference/cli.md#how-dispatch-works)). If you typed a typo for a CLI noun (e.g. `condash projct list`), `condash` reports `unknown noun` and exits with code 2. Re-run with the correct noun — `condash --help` lists every accepted one.

## Reading the toasts

Toasts at the bottom of the dashboard come in three colours. The colour signals what just happened — read it before reading the message.

| Colour | Kind | When you see it |
|---|---|---|
| Green / accent | success | A write completed: `Created <slug>`, `Path copied`, `Force-stopped <repo>`, `Initialised conception template`. The action took effect — nothing to do. |
| Red / warn | error | An action failed and was not retried: `Run failed`, `Open failed`, `Status change failed`, `Could not persist layout`. The trailing message is the underlying cause; the dashboard state was *not* mutated. |
| Neutral | info | Diagnostic context: `[[slug]] matched 3 items — opening the first`, branch warnings on close. The dashboard state did change; the toast is FYI. |

Toasts auto-dismiss after 4 seconds. Identical messages don't stack — a second flash of the same text resets the timer instead of queuing a duplicate.

## Still stuck?

- Open the [issue tracker](https://github.com/vcoeur/condash/issues) and search for the symptom.
- If nothing matches, file a new issue. Include OS, condash version, and minimum repro.
- For design questions, see [Why Markdown-first](../explanation/why-markdown.md), [Values](../explanation/values.md), and [Non-goals](../explanation/non-goals.md).
