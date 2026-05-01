---
title: Keyboard shortcuts · condash reference
description: Every keyboard shortcut the dashboard and embedded terminal recognise, and which are configurable.
---

# Keyboard shortcuts

> **Audience.** Daily user.

## At a glance

| Area | Count | Configurable? |
|---|---|---|
| Dashboard global | 1 | no |
| Note modal | 4 | no |
| Terminal — pane | 3 | yes (`[terminal]`) |
| Terminal — xterm | 4 | no |

## Dashboard global

| Shortcut | Action | Configurable |
|---|---|---|
| `Escape` | Close the topmost modal (note preview, then config modal) | no |

Search, tab switching, and item focus are pointer-driven — there is no global "focus search" or "switch tab" shortcut. The history-tab search field autofocuses when the tab is selected.

## Note modal

Active whenever a note preview (`.note-modal.open`) is on screen. Handled at capture phase so xterm / CodeMirror can't swallow them.

| Shortcut | Action |
|---|---|
| `Ctrl+F` / `Cmd+F` | Open the in-note Find bar (view mode only — edit mode falls through to the browser's native find) |
| `Ctrl+E` / `Cmd+E` | Toggle between view and the last-used edit mode |
| `Escape` | Close the Find bar if open, else close the modal |
| `Enter` / `Shift+Enter` / `F3` | Step to next / previous match (when the Find bar is focused) |

Inside the CodeMirror edit pane:

| Shortcut | Action |
|---|---|
| `Ctrl+S` / `Cmd+S` | Save (atomic overwrite via `POST /note`). Refuses if the file has drifted on disk. |

## Embedded terminal — pane-level

These live at the dashboard level and can fire from outside the terminal pane (e.g. toggle it open from anywhere). Configurable via the `terminal:` block in `settings.json` (preferred, per-machine) or `configuration.json` (tree default). Shortcut strings follow the `KeyboardEvent.key` convention — modifiers are `Ctrl`, `Shift`, `Alt`, `Meta`.

| Default | Action | Config key |
|---|---|---|
| `` Ctrl+` `` | Toggle the terminal pane | `terminal.shortcut` |
| `Ctrl+Shift+V` | Paste the path of the newest screenshot (see below) | `terminal.screenshot_paste_shortcut` |
| `Ctrl+Left` | Move the active tab to the left pane | `terminal.move_tab_left_shortcut` |
| `Ctrl+Right` | Move the active tab to the right pane | `terminal.move_tab_right_shortcut` |

Shortcut spec grammar:

```
shortcut      := modifier+ key
modifier      := "Ctrl" | "Shift" | "Alt" | "Meta"
key           := single char | KeyboardEvent.key name (e.g. "Enter", "`")
```

All parts are joined with `+`. Examples: `Ctrl+T`, `Ctrl+Shift+F`, `Alt+1`, `` Ctrl+` ``.

The toggle shortcut is intercepted both at the document level and inside xterm's own keydown listener — otherwise a focused terminal would swallow it. Same for screenshot-paste and the move-tab shortcuts.

### Screenshot-paste flow

When `terminal.screenshot_paste_shortcut` fires:

1. Server-side: `GET /recent-screenshot` scans `terminal.screenshot_dir` for the newest image file (by mtime).
2. Client-side: the returned path is pasted into the active terminal tab — **no `Enter` appended**. User confirms.
3. If the directory is missing or empty, a transient toast surfaces the reason.

See [using the embedded terminal](../guides/terminal.md#screenshot-paste).

## Embedded terminal — xterm-level

These live inside xterm's `attachCustomKeyEventHandler` and only fire while a terminal tab has focus. Not configurable — they match GNOME Terminal / Ghostty conventions.

| Shortcut | Action |
|---|---|
| `Ctrl+C` | Copy the selection if there is one; otherwise send `SIGINT` to the foreground process. |
| `Ctrl+Shift+C` | Always copy (no-op with no selection). |
| `Ctrl+V` / `Ctrl+Shift+V` | Paste from the system clipboard via the renderer's `navigator.clipboard` API. `Ctrl+Shift+V` is intercepted by the screenshot-paste handler unless rebound. |
| `Ctrl+F` | Open the in-tab **search bar** (xterm search addon). `Esc` closes it. |
| `Ctrl+Up` / `Ctrl+Down` | Jump to the previous / next OSC 133 prompt boundary in the active tab. Requires the [shell integration snippet](../guides/terminal.md#shell-integration); without it, the keys fall through to the shell. |
| `Ctrl+Left` / `Ctrl+Right` | Same as the pane-level move-tab shortcuts — intercepted here because xterm consumes arrow keys. |

Clipboard plumbing reads and writes the system clipboard through the browser's native [`navigator.clipboard`](https://developer.mozilla.org/docs/Web/API/Clipboard_API) API. There is no HTTP endpoint and no native bridge.

## Input focus rules

The pane-level shortcuts skip keystrokes where all of the following are true:

- The event target is an `<input>`, `<textarea>`, or `contenteditable` element.
- The shortcut has no non-shift modifier (so a bare `Tab` or single-letter key in an input never steals focus).

This keeps `` Ctrl+` `` from firing while you're typing in the history-tab search, but lets `Ctrl+Left` and `` Ctrl+` `` still work everywhere because they carry a modifier.

## Reloading shortcut changes

`terminal` shortcut changes saved via the gear modal take effect **live** — chokidar fires a `config` event, the renderer reloads the parsed shortcut specs. No restart needed. Changes made by hand-editing `configuration.json` or `settings.json` likewise re-render via the watcher; only `workspace_path` / `worktrees_path` / the `repositories` list need an actual restart.
