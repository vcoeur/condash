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

The pane pushes the dashboard up — it does not overlay. Toggling the pane closed suspends rendering but keeps every tab's PTY alive and its scrollback intact. Code-tab Run buttons no longer auto-open the pane — output stays in the per-row CodeRunRow inside the Code tab.

## Single-column by default; drag to split

The pane starts as a single column. The right column materialises only when at least one tab lives there (created from the right strip's `+` button or dragged across from the left). During a tab drag, a **`Drop to split →`** zone appears on the right edge so you can promote single → split without first creating an empty right pane. Collapsing the last right tab returns to a single column.

Each side header carries three buttons:

- **`+`** — spawn a new tab running the configured shell.
- **Launcher `+`** (if `terminal.launcher_command` is set) — spawn a new tab whose child process is the launcher command instead of the shell. Default is `claude`, so this slot opens a Claude Code session. Set `launcher_command = ""` to hide the button.
- **Tab strip** — click to focus the tab; middle-click to close. Clicking inside the xterm itself also promotes the tab to active (the click+focus listener was wired so a stray click never silently sends keys to a different tab than the one you're looking at).

Each tab is labelled with its child's argv[0] (e.g. `bash 1`, `claude 2`). Once the shell emits an OSC 7 cwd hint, the label switches to the cwd basename (`condash`, `notes`, …); a manual rename overrides. The full path always shows in the title attribute. Tabs **auto-close on process exit** — the previous "[process exited N]" stale-tab behaviour is gone. If you want the buffer before close lands, use the toolbar's **Save buffer** button (powered by xterm's serialize addon).

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
- **OSC 7** — current working directory (`file://host/path`). Drives the cwd-basename tab label.

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

**File → Settings… → Terminal** (`Ctrl+,`, then the **Terminal** tab) live-edits the `terminal.xterm` block: font family / size / line-height / letter-spacing / weight, cursor style + blink, scrollback depth, the ligatures toggle, and the full ANSI colour palette. The Terminal tab sits under **Global Condash Settings**, so it writes to `settings.json` (per-machine). For a tree-wide default that teammates pick up automatically, hand-edit `terminal.xterm` in `configuration.json` instead. Either way, changes apply to existing tabs without a relaunch — the renderer rebuilds the xterm options object on save.

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
    "launcher_command": "claude",
    "move_tab_left_shortcut": "Ctrl+Left",
    "move_tab_right_shortcut": "Ctrl+Right"
  }
}
```

See the [config reference](../reference/config.md) for the full key table with defaults.

## Editing shortcuts

The Settings modal's **Terminal** tab has a form field for every `terminal.*` key listed under [Configuration surface](#configuration-surface) above — `shortcut`, `screenshot_paste_shortcut`, `move_tab_left_shortcut`, `move_tab_right_shortcut`, `launcher_command`, `screenshot_dir`, `shell`. Edit them there and the change applies on save. To test a new shortcut, set it and press the combination — no relaunch needed.

## Platform notes

The terminal works on Linux, macOS, and Windows. The shell defaults differ by platform:

- **Linux / macOS** — `$SHELL` (or `/bin/bash` if unset).
- **Windows** — `%ComSpec%` (`cmd.exe` by default). Override with `terminal.shell = "C:\\Program Files\\PowerShell\\7\\pwsh.exe"` if you prefer PowerShell, or any `bash` from Git for Windows / MSYS2.

Per-platform shell wrapping (so `terminal.run` strings reach the right shell) lives in `src/main/terminals.ts:wrapForShell`. Shell-integration snippets under `integrations/` cover bash, zsh, fish, and PowerShell.
