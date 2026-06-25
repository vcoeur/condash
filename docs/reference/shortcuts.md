---
title: Keyboard shortcuts · condash reference
description: Every keyboard shortcut the dashboard and embedded terminal recognise, and which are configurable.
---

# Keyboard shortcuts

> **Audience.** Daily user.

## At a glance

| Area | Count | Configurable? |
|---|---|---|
| Application menu (File / View) | 14 | no |
| Dashboard global | 3 | no |
| Project cards | 6 | no |
| Note modal | 4 | no |
| Terminal — pane | 3 | yes (`[terminal]`) |
| Terminal — xterm | 4 | no |

## Application menu

The OS menu bar carries every system-level shortcut. Each item also dispatches an internal `MenuCommand` (see [`src/shared/api.ts`](https://github.com/vcoeur/condash/blob/main/src/shared/api.ts) `MenuCommand`) so the renderer can hook the same intent without going through the menu.

| Menu | Item | Shortcut | What it does |
|---|---|---|---|
| File | Open… | `Ctrl+O` / `Cmd+O` | Reopen the conception folder picker. |
| File | Open conception directory | — | Reveal the current conception in the OS file manager. |
| File | Settings | `Ctrl+,` / `Cmd+,` | Open the Settings modal. |
| File | Search… | `Ctrl+Shift+F` / `Cmd+Shift+F` | Open the global search modal. |
| File | New project… | `Ctrl+N` / `Cmd+N` | Open the new-project modal. |
| File | Quit | (no accelerator) | Trigger the quit-confirm flow. |
| View | Show Projects | — | Toggle the Projects pane on the left edge. |
| View | Show Code | `Ctrl+Shift+C` / `Cmd+Shift+C` | Show the Code pane in the working slot. |
| View | Show Knowledge | `Ctrl+Shift+K` / `Cmd+Shift+K` | Show the Knowledge pane in the working slot. |
| View | Show Resources | `Ctrl+R` / `Cmd+R` | Show the Resources pane in the working slot. |
| View | Show Skills | `Ctrl+L` / `Cmd+L` | Show the Skills pane in the working slot. |
| View | Show Logs | `Ctrl+Shift+L` / `Cmd+Shift+L` | Show the Logs pane (per-session terminal log viewer) in the working slot. |
| View | Show Dashboard | `Ctrl+Shift+D` / `Cmd+Shift+D` | Show the Dashboard pane (live terminal-tab summaries) in the working slot. |
| View | Hide working surface | — | Hide whichever pane (Code / Knowledge / Resources / Skills / Logs / Dashboard) is in the working slot. |
| View | Show Terminal | `` Ctrl+` `` / `` Cmd+` `` | Toggle the Terminal pane at the bottom. |
| View | Refresh | `F5` | Drop the git-status TTL cache and re-read every list. |
| View | Reload window | `Ctrl+Shift+R` / `Cmd+Shift+R` | Reload the renderer (browser-style hard reload). The bare `Ctrl+R` slot is taken by **Show Resources**. |
| Help | About / Welcome / Quick start / … | — | Open the matching `docs/` page in the in-app Help modal. |

The View toggles round-trip through `getLayout` / `setLayout` — see [Config files — LayoutState](config.md#layoutstate). The visible state is kept in sync with the menu's `checkbox` items.

## Dashboard global

| Shortcut | Action | Configurable |
|---|---|---|
| `Ctrl+K` / `Cmd+K` | Open the global search modal (same effect as `Ctrl+Shift+F`). | no |
| `Escape` | Close the topmost modal | no |
| `?` | Toggle the keyboard-shortcut cheat-sheet overlay | no |

Item focus and pane switching are pointer-driven — there is no "switch pane" shortcut. The search modal takes over the keyboard once it opens.

## Project cards

Each project card in the Projects pane is keyboard-focusable. Tab into a card (or click it once), then drive its status with the digit shortcuts. The focus ring shows which card the next keypress will affect.

| Shortcut | Action |
|---|---|
| `Tab` / `Shift+Tab` | Move focus between cards (and other focusable elements). |
| `Ctrl+1` / `Cmd+1` | Set the focused card's status to `now`. |
| `Ctrl+2` / `Cmd+2` | Set the focused card's status to `review`. |
| `Ctrl+3` / `Cmd+3` | Set the focused card's status to `later`. |
| `Ctrl+4` / `Cmd+4` | Set the focused card's status to `backlog`. |
| `Ctrl+5` / `Cmd+5` | Set the focused card's status to `done`. |

The digit-to-status mapping follows `KNOWN_STATUSES` in `src/shared/types/project.ts` — `1..N` maps to position `0..N-1`. Pressing a digit equal to the card's current status is a no-op.

The shortcut yields to text inputs, textareas, contenteditable surfaces, the embedded xterm, and the CodeMirror editor — typing `Ctrl+1` in the search modal or in a note's edit pane never steals it from the focused element.

Status changes via the keyboard go through the same `setStatus` mutation as the drag-drop path, so they fire the timeline `Closed.` / `Reopened.` entries on done-edges and surface the same out-of-tree branch warning when the project's worktree disagrees with the new status.

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

These live at the dashboard level and can fire from outside the terminal pane (e.g. toggle it open from anywhere). Configurable via the `terminal:` block in `settings.json` (preferred, per-machine) or `.condash/settings.json` (tree default). Shortcut strings follow the `KeyboardEvent.key` convention — modifiers are `Ctrl`, `Shift`, `Alt`, `Meta`.

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
| `Ctrl+V` | Paste from the system clipboard. The clipboard is read in the main process (`clipboardReadText` IPC) and fed through `term.paste()`, which applies bracketed-paste wrapping when the program has that mode on. |
| `Ctrl+Shift+V` | Paste the path of the newest screenshot — intercepted by the screenshot-paste handler unless rebound. |
| `Ctrl+F` | Open the in-tab **search bar** (xterm search addon). `Esc` closes it. |
| `Ctrl+Up` / `Ctrl+Down` | Jump to the previous / next OSC 133 prompt boundary in the active tab. Requires the [shell integration snippet](../guides/terminal.md#shell-integration); without it, the keys fall through to the shell. |
| `Ctrl+Left` / `Ctrl+Right` | Same as the pane-level move-tab shortcuts — intercepted here because xterm consumes arrow keys. |

Copy writes the system clipboard through the browser's native [`navigator.clipboard`](https://developer.mozilla.org/docs/Web/API/Clipboard_API) API. Paste reads it through the `clipboardReadText` IPC (main-process Electron `clipboard`), because `navigator.clipboard.readText()` is permission-gated and unreliable in the renderer. There is no HTTP endpoint.

## Input focus rules

The pane-level shortcuts skip keystrokes where all of the following are true:

- The event target is an `<input>`, `<textarea>`, or `contenteditable` element.
- The shortcut has no non-shift modifier (so a bare `Tab` or single-letter key in an input never steals focus).

This keeps `` Ctrl+` `` from firing while you're typing in the search modal, but lets `Ctrl+Left` and `` Ctrl+` `` still work everywhere because they carry a modifier.

## Reloading shortcut changes

`terminal` shortcut changes saved via the gear modal take effect **live** — chokidar fires a `config` event, the renderer reloads the parsed shortcut specs. No restart needed. Changes made by hand-editing `.condash/settings.json` or `settings.json` likewise re-render via the watcher; only `workspace_path` / `worktrees_path` / the `repositories` list need an actual restart.
