---
title: Use the embedded terminal · condash guide
description: Open the PTY pane, manage tabs across two sides, use the launcher button, paste screenshot paths, move tabs between sides.
---

# Use the embedded terminal

> **Audience.** Daily user.

**When to read this.** You want to stop alt-tabbing out to a separate terminal window while you work — or you've toggled the pane open once and couldn't find half the features.

The embedded terminal is a real PTY driven by `node-pty` in the main process and rendered by `xterm.js` (locked to xterm 6.x with the recommended addon stack — search, web-links, clipboard, unicode11, webgl, serialize, image, ligatures) in the renderer.

## Opening the pane

Two ways:

- **View → Show Terminal** in the menu bar.
- Press the configured toggle shortcut. Default is `` Ctrl+` ``; change it under `terminal.shortcut` in `settings.json`.

![Terminal pane open beneath the dashboard](../assets/screenshots/terminal-light.png#only-light)
![Terminal pane open beneath the dashboard](../assets/screenshots/terminal-dark.png#only-dark)

The pane pushes the dashboard up — it does not overlay. Toggling the pane closed suspends rendering but keeps every tab's PTY alive and its scrollback intact. Code-pane Run buttons no longer auto-open the pane — output stays in the per-row CodeRunRow inside the Code pane.

## Single-column by default; drag to split

The pane starts as a single column. The right column materialises only when at least one tab lives there (created from the right strip's `+` button or dragged across from the left). During a tab drag, a **`Drop to split →`** zone appears on the right edge so you can promote single → split without first creating an empty right pane. Collapsing the last right tab returns to a single column.

Each side header carries:

- **Spawn dropdown** — a single button that opens a menu with all configured launchers. The first option is always `New shell` (spawns the configured shell); below it are the entries from `terminal.launchers` whose `command` is non-empty. Selecting an option immediately spawns the corresponding tab. The menu is rendered through a Solid `<Portal>` to `document.body` (with `position: fixed` coordinates from `createDropdownMenu({ align: 'left' })`) so it escapes `.terminal-pane`'s `contain: layout paint` and the strip's `overflow: auto` — both of which would otherwise clip the menu down to the strip's 32 px height.
- **Tab strip** — click to focus the tab; middle-click to close. Clicking inside the xterm itself also promotes the tab to active (the click+focus listener was wired so a stray click never silently sends keys to a different tab than the one you're looking at).

Tab titles depend on how the tab was spawned:

- **`New shell`** — labelled `shell`; once the shell emits an OSC 7 cwd hint, the label switches to the cwd basename (`condash`, `notes`, …) and follows subsequent `cd`s.
- **Launcher option** — labelled with the entry's `title` if set, otherwise the `command` (e.g. `Claude`, `claude`, `python -m notebook`). The label is **pinned**: OSC 7 cwd updates do *not* override it.
- **Code-card "open in term"** — labelled `<repo> · <branch>` (e.g. `condash · my-feature`). Also pinned, so the branch stays visible even after the shell `cd`s inside the worktree.

A manual double-click rename always wins. The full path shows in the title attribute. Tabs **auto-close on process exit** — the previous "[process exited N]" stale-tab behaviour is gone. If you want the buffer before close lands, use the toolbar's **Save buffer** button (powered by xterm's serialize addon).

`TERM=xterm-256color`, and the shell is launched with `-l` so your login rc-files run.

## Power-user shortcuts

The custom-key hook intercepts a few combos before the bytes hit the shell:

| Shortcut | Effect |
|---|---|
| `Ctrl+F` | Open the **search bar** at the top of the active tab — find-as-you-type with case / regex toggles. `Esc` to close. |
| `Ctrl+Up` / `Ctrl+Down` | **Jump to the previous / next OSC 133 prompt boundary.** Requires shell integration — see [Shell integration](#shell-integration) below. Without integration, the keys fall through to the shell. |
| `Ctrl+Left` / `Ctrl+Right` | Move the active tab between the left and right sides. |

URLs in the buffer are clickable thanks to the web-links addon — clicking opens through the safe `openExternal` IPC verb (allowlists `https:` and `mailto:`).

## Shell integration { #shell-integration }

Drop-in snippets for bash, zsh, and fish make the terminal render **semantic prompts** — a coloured gutter mark next to each prompt boundary (green = exit 0, red = non-zero) and `Ctrl+Up` / `Ctrl+Down` to jump between them. They emit two standard OSC sequences:

- **OSC 133** — prompt-boundary protocol (`A` prompt-start, `B` prompt-end, `C` command-start, `D;<exit>` command-end with exit code). Same protocol used by iTerm2, WezTerm, kitty, and Warp.
- **OSC 7** — current working directory (`file://host/path`). Drives the cwd-basename tab label for the plain `+` shell tabs (pinned tabs ignore OSC 7).

### Where the snippets live

The three files — `osc133.bash`, `osc133.zsh`, `osc133.fish` — sit in the condash source tree under [`integrations/`](https://github.com/vcoeur/condash/tree/main/integrations). They are **not** included in the .deb / AppImage / .dmg / .exe installers, since shell rc files are user-owned. Either:

- Clone the repo somewhere stable and source from that path, e.g. `~/src/condash/integrations/osc133.zsh`.
- Download just the file you need with `curl` / `wget` from the link above (raw view) and drop it next to your rc, e.g. `~/.config/condash/osc133.zsh`.

Substitute `<path>` below with whichever location you used.

### Source it from your rc

Pick the line that matches your shell. Each snippet is idempotent (the `[[ -f ... ]]` / `test -f` guard skips silently if the file is missing, so the rc is safe to commit even on machines where condash isn't installed).

**bash — `~/.bashrc`**

```bash
[[ -f <path>/osc133.bash ]] && source <path>/osc133.bash
```

**zsh — `~/.zshrc`**

```zsh
[[ -f <path>/osc133.zsh ]] && source <path>/osc133.zsh
```

**fish — `~/.config/fish/config.fish`**

```fish
test -f <path>/osc133.fish; and source <path>/osc133.fish
```

Open a fresh tab (`+` in the terminal pane) so the new rc is picked up. Existing tabs need to be reloaded — the snippet only takes effect for processes spawned after the source.

### Verifying

In a fresh tab, run:

```bash
printf '\e]133;A\a'
```

That sends a manual prompt-start mark. condash should paint a small accent-coloured gutter dot on that line. Then run a failing command:

```bash
false
```

The gutter mark for the next prompt should switch to red (exit 1). If neither paints, the snippet didn't load — check the path you substituted, and that you reopened the tab.

A snippet sourced from a non-condash terminal (gnome-terminal, iTerm2, …) emits the same invisible escape sequences and is silently ignored — there is no visible change in those terminals, so it is safe to leave the line in your shared rc.

## Live theming and font tweaks (Settings → Terminal)

**File → Settings… → Terminal** (`Ctrl+,`, then the **Terminal** section) live-edits the `terminal.xterm` block: font family / size / line-height / letter-spacing / weight, cursor style + blink, scrollback depth, the ligatures toggle, and the full ANSI colour palette. The Terminal section ships on both Settings tabs: the **Global** copy writes to `settings.json` (per-machine default); the **This conception** copy writes to `condash.json` (per-tree override, picked up by teammates on git pull). Each field on the conception tab carries an inheritance badge with a Reset-to-global button. Either way, changes apply to existing tabs without a relaunch — the renderer rebuilds the xterm options object on save.

See [`terminal.xterm` in the config reference](../reference/config.md#terminalxterm) for the full key table.

## Moving tabs between sides

Keyboard shortcuts move the active tab left or right:

| Action | Default shortcut | Config key |
|---|---|---|
| Move active tab to left side | `Ctrl+Left` | `terminal.move_tab_left_shortcut` |
| Move active tab to right side | `Ctrl+Right` | `terminal.move_tab_right_shortcut` |

The shortcut syntax follows the HTML `KeyboardEvent.key` convention: `Ctrl+Shift+X`, `Alt+1`, etc. Modifiers allowed: `Ctrl`, `Shift`, `Alt`, `Meta`.

Use this to pair a build terminal on one side with a log-tail on the other without leaving the keyboard.

## Screenshot-paste

This is the feature nobody discovers on their own. It solves one specific problem: "I just took a screenshot; now I want its path in my terminal to `cat`, `mv`, `gh pr comment --body-file`, or whatever."

Press `Ctrl+Shift+V` (configurable as `terminal.screenshot_paste_shortcut`) anywhere in the dashboard. condash:

1. Looks up `terminal.screenshot_dir` (default: `$XDG_PICTURES_DIR/Screenshots` on Linux, `~/Desktop` on macOS).
2. Finds the newest image file there.
3. Inserts its absolute path at the active tab's prompt — no `Enter` appended; you confirm.

Typical use: take a screenshot of a failing test → `Ctrl+Shift+V` → the path appears → prefix with `cat ` or drop into a `gh issue create --body-file ` command.

Clipboard-based paste (`Ctrl+V`) also works for regular text, and uses the OS clipboard via a server-side bridge because xterm.js can't read the browser clipboard directly. Both `Ctrl+V` (paste) and `Ctrl+C` (copy) flow through this bridge.

## Configuration surface

Everything lives under `terminal:` in `${XDG_CONFIG_HOME:-~/.config}/condash/settings.json`:

```json
{
  "terminal": {
    "shell": "/bin/zsh",
    "shortcut": "Ctrl+`",
    "screenshot_dir": "/home/you/Pictures/Screenshots",
    "screenshot_paste_shortcut": "Ctrl+Shift+V",
    "launchers": [
      { "label": "Claude", "command": "claude", "title": "Claude" },
      { "label": "Jupyter", "command": "python -m notebook", "title": "Jupyter" }
    ],
    "move_tab_left_shortcut": "Ctrl+Left",
    "move_tab_right_shortcut": "Ctrl+Right"
  }
}
```

See the [config reference](../reference/config.md) for the full key table with defaults.

The legacy scalar `terminal.launcher_command` from condash ≤ 2.27 is transparently migrated into `launchers[0]` (label: `λ`) on first load and dropped from the file on next write — no manual action. Legacy `symbol`-based entries (`lambda` → `λ`, `mu` → `μ`) are also migrated to `label` automatically.

## Editing shortcuts

The Settings modal's **Terminal** tab has a form field for every `terminal.*` key listed under [Configuration surface](#configuration-surface) above — `shortcut`, `screenshot_paste_shortcut`, `move_tab_left_shortcut`, `move_tab_right_shortcut`, `screenshot_dir`, `shell`. Launchers appear as a dynamic list with **Label**, **Command**, and **Title** inputs per row. Use **+ Add launcher** to create new entries, the **×** button to remove, and **↑ / ↓** to reorder. Edit them there and the change applies on save. To test a new shortcut, set it and press the combination — no relaunch needed.

## Platform notes

The terminal works on Linux, macOS, and Windows. The shell defaults differ by platform:

- **Linux / macOS** — `$SHELL` (or `/bin/bash` if unset).
- **Windows** — `%ComSpec%` (`cmd.exe` by default). Override with `terminal.shell = "C:\\Program Files\\PowerShell\\7\\pwsh.exe"` if you prefer PowerShell, or any `bash` from Git for Windows / MSYS2.

Per-platform shell wrapping (so `terminal.run` strings reach the right shell) lives in `src/main/terminals.ts:wrapForShell`. Shell-integration snippets under `integrations/` cover bash, zsh, fish, and PowerShell.

## Session logging

Every terminal tab can be captured to disk for later review. Capture is **opt-in** (default off, since 2.25.0) for privacy — flip *Record terminal sessions to disk* in `Settings → Terminal → Logging` to start recording. When on, each pty spawn produces **one plain-text file**:

```
<conception>/.condash/logs/YYYY/MM/DD/HHMMSS-<session-id>.txt
```

The file carries the rendered terminal buffer with two `# condash: {...}` JSON metadata lines folded in: a header at line 1 (`{sid, side, repo?, cwd, cmd, argv, started}`) and a footer at the last line, written when the session exits (`{finished, exitCode}`). `cat`ing the file shows everything — no sidecar to keep in sync.

```
# condash: {"sid":"t-…","side":"my","cmd":"npm","argv":["run","dev"],"repo":"condash","cwd":"/home/alice/…","started":"2026-05-14T10:00:27Z"}

<rendered terminal buffer — plain UTF-8 text, no SGR / ANSI escapes>

# condash: {"finished":"2026-05-14T10:01:45Z","exitCode":0}
```

The writer pipes pty bytes into a headless xterm (`@xterm/headless`) and every 5 seconds reads each row of the active buffer via `IBufferLine.translateToString(true)`, joins with `\n`, prepends the header (and appends the footer if the session has exited), and atomically replaces the `.txt`. Colour / bold / underline are deliberately not preserved — for full ANSI fidelity, use the live terminal pane's **Save buffer** button instead.

Toggling logging off does **not** delete past transcripts — the Logs pane keeps browsing them and the janitor's age/cap eviction stays in charge of cleanup.

The whole `.condash/` directory is gitignored by default — the auto-migrator appends a `.condash/` line to your `.gitignore` the first time it lifts a legacy `condash.json` into the new layout, so logs (and per-host settings) stay per-host with no commit-leak risk.

### Browsing logs

`View → Show Logs` (`Cmd+Shift+L`) opens the Logs working surface — a **sessions list grouped by day**, newest day first. Each row is a card showing the spawn time, repo (when launched via Run), short command, size on disk, and exit code (or "running" while alive; the left edge tints red for non-zero exits).

Clicking a card opens the **session viewer modal**: a wide overlay with the full plain-text transcript and a case-insensitive search box. The transcript is virtualised — only the visible window of lines is mounted, so even a 100 MB log scrolls smoothly. Long lines horizontal-scroll rather than wrap (every row stays exactly one line-height tall, which the virtualizer needs). Search precomputes per-line hit indices once per query; the n/N counter plus the ↑/↓ buttons cycle hits, `Enter` jumps forward, `Shift+Enter` backward, `Cmd/Ctrl+F` focuses the search box, `Esc` closes the modal.

The `⌫` button in the modal head deletes the open session (one `.txt`, no sidecar to clean up).

### Searching logs across sessions

Logs are a source of the global search modal (`Cmd+K`), alongside projects, knowledge, resources, and skills. A log hit's title shows the session's start time (`YYYY-MM-DD HH:MM:SS`); activating it opens the viewer modal directly on that session. The `# condash:` header / footer lines are stripped from the body before substring matching so search snippets carry actual transcript text, not the metadata JSON.

#### What's captured

The writer treats the pty `output` stream as the source of truth. Typed keystrokes are **not captured separately** — the kernel pty echoes them back through `output`, so the rendered buffer already shows what was typed. Capturing keystrokes again would either double-echo (if fed into the same xterm) or build a parallel keystroke log (richer than `~/.bash_history`); we do neither.

Long-running streams (`tail -f`, full-screen TUIs like `vim` / `htop` / Claude Code) are bounded by the xterm scrollback: bytes that scroll past the scrollback window are dropped, exactly as they would be in the live terminal pane. The on-disk `.txt` therefore self-bounds to roughly *scrollback × line width* and never grows beyond that.

### Tuning capture

The `terminal.logging` block in `.condash/settings.json` (or in the global `settings.json` for cross-conception defaults) carries the knobs:

```json
{
  "terminal": {
    "logging": {
      "enabled": false,
      "retentionDays": 14,
      "maxDirMb": 500,
      "scrollback": 10000
    }
  }
}
```

See the [config reference](../reference/config.md#terminal-logging) for per-key defaults and effects.

A janitor runs at app start and every 24 hours: it deletes day-directories older than `retentionDays`, gzips any uncompressed `.txt` whose day-directory is at least one day old (today's dir is always skipped to avoid racing with active writers), then evicts the oldest day-directory while total size is over `maxDirMb`. There is no per-file rotation — `scrollback` is the only size knob.

#### Migration from `.jsonl`

condash ≤ 2.22 wrote a JSONL event stream (one record per pty burst) instead of the rendered `.txt`. Files in that format remain on disk if they were captured by an older version, but the Logs pane no longer reads them — only the janitor's age-based eviction touches them. To free space immediately, delete `<conception>/.condash/logs/` and start fresh on the new format.

### Privacy

Terminal output routinely carries secrets: `gh auth login` paste, env-var dumps, ssh passphrases, API tokens in `curl -H` lines. The on-disk-at-rest risk is comparable to `~/.bash_history`, but the file is much richer. Mitigations baked in:

- `.condash/` is gitignored by default — no accidental commit.
- Logs never leave the host — no telemetry, no cloud sync.
- `terminal.logging.enabled = false` cuts capture per-conception or globally; existing files stay on disk for the janitor.
- The Logs pane's **Delete day** button wipes one day at a time.

No automatic redaction — pattern-based scrubbing is unreliable and gives false reassurance. To capture a sensitive command without recording its output, disable logging via the settings toggle before running it.
