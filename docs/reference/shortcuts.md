---
title: Keyboard shortcuts · condash reference
description: Every keyboard shortcut the dashboard and embedded terminal recognise, and which are configurable.
---

# Keyboard shortcuts

> **Audience.** Daily user.

## At a glance

| Area | Bindings | Configurable? |
|---|---|---|
| Application menu (File / View) | 13 set by condash, plus 11 OS defaults | no |
| Dashboard global | 3 | no |
| Project cards | 6 | no |
| Note modal | 5 | no |
| Terminal — pane | 4 | yes (`terminal.*`) |
| Terminal — xterm | 4 xterm-level (+ 2 pane-level re-listed for context) | no |

"Set by condash" means an explicit `accelerator:` in [`src/main/menu.ts`](https://github.com/vcoeur/condash/blob/main/src/main/menu.ts). The 11 OS defaults come from Electron `role:` menu items — the whole Edit menu plus zoom / devtools / fullscreen — and carry whatever binding the platform assigns; they are listed below but counted separately because condash does not choose them.

## Application menu

The OS menu bar carries every system-level shortcut. Each item also dispatches an internal `MenuCommand` (see [`src/shared/api.ts`](https://github.com/vcoeur/condash/blob/main/src/shared/api.ts) `MenuCommand`) so the renderer can hook the same intent without going through the menu.

| Menu | Item | Shortcut | What it does |
|---|---|---|---|
| File | Open… | `Ctrl+O` / `Cmd+O` | Reopen the conception folder picker. |
| File | Open Recent ▸ | — | Submenu of the last five conception paths, plus **Clear menu**. Picking one switches the active conception immediately. |
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
| View | Show Dashboard | `Ctrl+Shift+D` / `Cmd+Shift+D` | Swap the bottom band to the Dashboard body (live terminal-tab summaries) — also selectable from the always-first **Dashboard** tab in the terminal strip. |
| View | Hide working surface | — | Hide whichever pane (Code / Knowledge / Resources / Skills / Logs) is in the working slot. |
| View | Show Terminal | `` Ctrl+` `` / `` Cmd+` `` | Toggle the Terminal pane at the bottom. |
| View | Refresh | `F5` | Drop the git-status TTL cache and re-read every list. |
| View | Reload window | `Ctrl+Shift+R` / `Cmd+Shift+R` | Reload the renderer (browser-style hard reload). The bare `Ctrl+R` slot is taken by **Show Resources**. |
| Help | About / Welcome / Quick start / … | — | Open the matching `docs/` page in the in-app Help modal. |

The View toggles round-trip through `getLayout` / `setLayout` — see [Config files — LayoutState](config.md#layoutstate). The visible state is kept in sync with the menu's `checkbox` items.

### OS-default menu items

Eleven further items are Electron `role:` entries. condash sets **no** accelerator on any of them, so each item's label and binding come from Electron's per-platform defaults rather than from condash — which is why they are not listed with the accelerators above and why this page does not spell them out.

| Menu | Roles |
|---|---|
| Edit | `undo`, `redo`, `cut`, `copy`, `paste`, `selectAll` |
| View | `toggleDevTools`, `resetZoom`, `zoomIn`, `zoomOut`, `togglefullscreen` |

The Edit-menu roles act on whatever the OS considers focused. They are **not** the terminal's copy/paste path — a focused xterm handles `Ctrl+C` / `Ctrl+V` itself (see [xterm-level](#embedded-terminal-xterm-level)), because Electron's paste role does not reliably deliver a paste event to xterm's hidden textarea.

### The activity rail

Every View toggle above has a pointer twin on the **activity rail** down the left edge. Top to bottom: **Projects · Tasks · Deliverables · Performance**, a divider, then **Code · Knowledge · Resources · Skills · Logs**. The first group fills the left band; the second fills the right working slot. The active item is highlighted. Hovering shows the item's name; the five working-slot items add their shortcut in brackets, and the four left-band items have no keyboard shortcut, so their tooltip is the bare name.

![Activity rail — Projects, Tasks, Deliverables, Performance, then a divider, then Code, Knowledge, Resources, Skills, Logs](../assets/screenshots/activity-rail-light.png#only-light)
![Activity rail — Projects, Tasks, Deliverables, Performance, then a divider, then Code, Knowledge, Resources, Skills, Logs](../assets/screenshots/activity-rail-dark.png#only-dark)

Clicking the item that is already active hides its pane — the same tristate the `Show …` menu items have.

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
| `Ctrl+S` / `Cmd+S` | Save (atomic overwrite via the [`writeNote`](ipc-api.md#mutations) IPC verb). Refuses if the file has drifted on disk. |

## Embedded terminal — pane-level

These live at the dashboard level and can fire from outside the terminal pane (e.g. toggle it open from anywhere). Configurable via the `terminal:` block, which is a **personal/per-machine key** — it lives in the global `settings.json` only, and a conception file that carries it is rejected by the strict schema. Shortcut strings follow the `KeyboardEvent.key` convention — modifiers are `Ctrl`, `Shift`, `Alt`, `Meta`.

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

All four are handled by one document-level `keydown` listener registered in the **capture** phase, so they run before xterm's own textarea listener rather than being swallowed by a focused terminal. Two nuances:

- The **pane toggle** is the only shortcut that fires unconditionally — from inside an `<input>`, the CodeMirror editor, or the active xterm alike.
- **Screenshot-paste** also wins inside the xterm (that's the surface you want to paste into) and additionally calls `stopPropagation()`, which is what suppresses xterm's own built-in `Ctrl+Shift+V` clipboard paste from overwriting the path.

The `?` overlay, `Ctrl+K`, and the two move-tab shortcuts yield to any editable target instead. Move-tab additionally requires the terminal pane to be open.

### Screenshot-paste flow

When `terminal.screenshot_paste_shortcut` fires:

1. **Main process:** the [`termLatestScreenshot(dir)`](ipc-api.md#pty-sessions) IPC verb scans the top level of `terminal.screenshot_dir` and returns the most recently modified **file** (any extension — it does not filter on image types). There is no HTTP route.
2. **Renderer:** the returned path is typed into the active terminal tab — **no `Enter` appended**. You confirm.
3. If `terminal.screenshot_dir` is unset, or the directory is missing or empty, a transient toast surfaces the reason.

See [using the embedded terminal](../guides/terminal.md#screenshot-paste).

## Embedded terminal — xterm-level

These live inside xterm's `attachCustomKeyEventHandler` and only fire while a terminal tab has focus. Not configurable — they match GNOME Terminal / Ghostty conventions.

| Shortcut | Action |
|---|---|
| `Ctrl+C` | Copy the selection if there is one; otherwise send `SIGINT` to the foreground process. |
| `Ctrl+V` | Paste from the system clipboard. The clipboard is read in the main process (`clipboardReadText` IPC) and fed through `term.paste()`, which applies bracketed-paste wrapping when the program has that mode on. |
| `Ctrl+Shift+V` | Paste the path of the newest screenshot — intercepted by the screenshot-paste handler unless rebound. |
| `Ctrl+F` | Open the in-tab **search bar** (xterm search addon). `Esc` closes it. |
| `Ctrl+Up` / `Ctrl+Down` | Jump to the previous / next OSC 133 prompt boundary in the active tab. Requires the [shell integration snippet](../guides/terminal.md#shell-integration); without it, the keys fall through to the shell. |
| `Ctrl+Left` / `Ctrl+Right` | Same as the pane-level move-tab shortcuts — intercepted here because xterm consumes arrow keys. |

Copy writes the system clipboard through the browser's native [`navigator.clipboard`](https://developer.mozilla.org/docs/Web/API/Clipboard_API) API. Paste reads it through the `clipboardReadText` IPC (main-process Electron `clipboard`), because `navigator.clipboard.readText()` is permission-gated and unreliable in the renderer. There is no HTTP endpoint.

**There is no `Ctrl+Shift+C` "always copy".** The xterm handler requires `!shiftKey`, and the accelerator belongs to **View → Show Code**, which wins globally. Use `Ctrl+C` with a selection — it copies and clears the selection, and only falls through to `SIGINT` when nothing is selected.

## Input focus rules

"Editable" means the event target sits inside an `<input>`, a `<textarea>`, a `contenteditable` element, the CodeMirror editor (`.cm-editor`), or the embedded xterm (`.xterm-host`). Whether a shortcut yields to one is decided per cluster, not globally:

| Cluster | Inside an editable target |
|---|---|
| Terminal-pane toggle (`` Ctrl+` ``) | **Fires anyway** — always wins, deliberately. |
| Screenshot-paste (`Ctrl+Shift+V`) | **Fires anyway** when the terminal pane is open, and suppresses xterm's own paste. |
| `?` overlay, `Ctrl+K` search, move-tab | Yields. |
| Project-card digits (`Ctrl+1..5`) | Yields when the target is an `<input>` / `<textarea>` / `<select>` / contenteditable, and it additionally ignores any keypress carrying `Alt` or `Shift`. |
| Note-modal shortcuts | Handled at capture phase inside the modal, so xterm / CodeMirror cannot swallow them. |

The application-menu accelerators are owned by the OS menu bar and are unaffected by renderer focus entirely.

## Reloading shortcut changes

`terminal` shortcut changes saved from **File → Settings… → Terminal** take effect **live** — the renderer re-reads the prefs and reparses the shortcut specs, no restart.

A **hand-edit of the global `settings.json` does not**. condash's chokidar watcher is rooted at the conception directory, so it never sees that file; the prefs reload is driven by a `config` event on `.condash/settings.json` (or by the modal's own save). Reopen the conception — or just save once from the Settings modal — to pick a hand-edit up. Separately, `workspace_path` / `worktrees_path` / the `repositories` list need an actual restart whichever way they are edited.
