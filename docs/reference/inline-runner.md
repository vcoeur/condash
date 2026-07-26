---
title: Inline dev-server runner · condash reference
description: The per-repo Run/Stop button, the `run:` field, and the one-run-per-repo rule that ties the Code pane to live dev servers.
---

# Inline dev-server runner

> **Audience.** Daily user.

Since v0.13.0, each row in the Code pane — every repo and every declared sub-repo — can carry an inline dev-server runner. Click **Run** and condash spawns the command under a PTY; a row appears in the pane's **ACTIVE RUNS** strip with a collapsible mini xterm streaming live output. The running server survives pane switches, terminal toggles, and even a renderer reload: the pty and its output buffer live in the main process, not in the page.

## When to reach for it

- You want to see your frontend rebuild output next to your item card instead of tabbing into a separate terminal.
- You want a one-click way to restart a dev server from whichever checkout you're currently on — main, a worktree, doesn't matter, the button is in the same place.
- You want the dashboard to notice, automatically, when your dev server exits with a non-zero status.

For one-off commands (a test run, a manual repro), keep using the embedded terminal — see [Use the embedded terminal](../guides/terminal.md). The runner is specifically for **long-running** dev processes.

## Configuring a runner

The runner is opt-in per repo and per sub-repo. Declare it in [`.condash/settings.json`](config.md#repositories) with the `run:` field:

```json
{
  "repositories": [
    "conception",
    { "name": "notes.vcoeur.com", "run": "make dev" },
    {
      "name": "helio",
      "run": "cargo watch -x run",
      "submodules": [
        { "name": "apps/web", "run": "npm --prefix apps/web run dev" },
        "apps/api"
      ]
    }
  ]
}
```

Rules:

- A bare string entry (`"conception"`) declares a repo with no runner. Promote it to `{ "name": "…", "run": "…" }` when you add one.
- **`run`** is a single shell-style string, executed through the configured shell — POSIX shells get `-c`, `cmd.exe` gets `/d /s /c`, PowerShell gets `-NoLogo -NonInteractive -Command`. So `make dev`, pipes, `&&`, and shell builtins behave as you'd expect. The POSIX form is deliberately a **non-login** shell: a login shell would re-source `~/.profile` and undo the [environment scrub](env.md#what-a-spawned-subprocess-inherits) the pty spawn already applied. Your login-shell `PATH` is injected separately, so user-installed CLIs still resolve; if you genuinely need full login behaviour, write `bash -lc '…'` yourself.
- **`{path}`** in the template is substituted with the absolute path of the checkout the click originated from (main or a worktree). Omit it and the command runs with `cwd` set to that checkout — either form works.
- **Inheritance is off.** A parent's `run:` doesn't cascade to its submodules; a submodule without its own `run:` has no Run button. This is deliberate — a repo's top-level dev command is almost never what a subdir wants.

Edit `run` and `force_stop` from **File → Settings… → Repositories**, which gives each configured repo its own form controls. (There is no JSON editor in the Settings modal; the rail's **Open .condash/settings.json** button hands the file to your own editor if you prefer.)

## The Run button lifecycle

Each branch row of a repo with a configured `run` carries a single button that flips between two states, and the repo header shows a live dot with the running branch's name.

| State | What you see | What clicking does |
|---|---|---|
| **Idle** | `▶ Run` | Starts the command under a PTY, sided to the Code pane. A row appears in **ACTIVE RUNS** at the top of the pane. |
| **Running** | `■ Stop` | Runs the [kill pipeline](../explanation/internals.md#pty-kill-pipeline) against the session: `SIGTERM` → optional `force_stop` → 500 ms → `SIGKILL` on the process group. |

The Stop button appears on the branch row whose checkout the live session is actually running in; the repo header carries the same branch name next to a live dot, so a session started from a worktree is visible from anywhere in the repo's card.

### One run per repo

**Starting a run stops the previous one for the same repo.** The rule lives in the main process, keyed on the repo's configured name — top-level repos by their directory name, submodules by their `parent/child` display form. It is deliberately repo-scoped rather than checkout-scoped: main and every worktree share the key, because two parallel dev servers for the same app would race on the same port.

The stop is awaited before the new pty spawns, so the port is free before the replacement binds and the renderer sees the old row disappear before the new one arrives. There is no confirmation prompt and no "switch here" affordance — clicking Run on a second branch simply moves the session there.

## The ACTIVE RUNS strip

Every code-side session gets a row at the top of the Code pane, showing the repo `#handle`, the branch, and a `running` / `exited <code>` status pill.

- **Collapsed by default.** Click the row header to expand a mini xterm; click again to collapse. The terminal is *not* torn down on collapse — it keeps parsing the live stream and keeps its scrollback, so re-expanding shows continuous output rather than an empty screen.
- **Replays on attach.** Main holds a rolling tail of each session's output — **64 000 characters** (with a small reslice slack) — and the xterm replays it through the `termAttach` IPC when the row first mounts. There is no websocket and no HTTP anywhere in this path. Output that scrolls past that tail is gone; use `terminal.logging` if you need the full transcript on disk.
- **Input is allowed.** The xterm is a full TTY: `q` to quit a long-running reporter, arrow keys, `Ctrl+C`. If your dev tool has an interactive REPL (vite, bun, a Django management shell), it works.
- **Resize follows the container.** The row refits its grid when it is expanded and whenever its host resizes, and the resolved geometry is pushed to the pty — so long log lines wrap at the right width. The fit is guarded: a host that has not laid out yet is retried on `requestAnimationFrame` rather than committing xterm's degenerate 2×1 floor to the pty.
- **Exit is visible, not silent.** On exit the row writes a yellow `[process exited N]` marker into its own terminal and the pill flips to `exited <code>`. The row stays until you close it, so the evidence survives.

## IPC verbs

The runner is wired through the same IPC contract as the embedded terminal. The renderer's `termSpawn` request carries only `{ side: 'code', repo, cwd? }` — it never sends the command. Main looks the repo up in the effective config and wraps that entry's `run:` string for the active shell, which is why a renderer can't smuggle an arbitrary command through this path. An explicit `cwd` (the worktree path, when you clicked Run on a non-primary branch row) wins over the entry's primary checkout.

Subsequent `termWrite` / `termResize` / `termAttach` / `termClose` calls drive the session, and the `onTermData` / `onTermExit` / `onTermSessions` push channels stream output and lifecycle events back.

See [IPC API — PTY sessions](ipc-api.md#pty-sessions) for the full surface.

## Live updates

Runner state changes don't go through a polling loop — the main process pushes `termSessions` events when a session starts, exits, or moves between checkouts, and the renderer's Code pane listens. There is no fingerprint-driven refresh; the Solid signals targeted at the affected row update without disturbing the rest of the UI.

## Lifetime

- A session stays alive for as long as the child process is running, regardless of whether the renderer is attached.
- **In the Code pane**, an exited run keeps its ACTIVE RUNS row and its output until you dismiss it.
- **In the bottom terminal pane**, the rule is narrower: a clean `exit 0`, and a stop you asked for, auto-close the tab — a lingering "[process exited 0]" placeholder only forced a manual click. Any *abnormal* death keeps its row, with the verdict badge and a **Restart** button (`termRestart`), because auto-closing would destroy the only evidence of what happened. A Stop that also tripped the cgroup OOM killer counts as abnormal for exactly that reason. The tab strip's **Save buffer** button (xterm's serialize addon) captures the scrollback in either case.
- On clean shutdown (window close, `quitApp` IPC, `SIGTERM` to the Electron main) every registered runner is reaped through the [PTY kill pipeline](../explanation/internals.md#pty-kill-pipeline): SIGTERM → optional `force_stop` → 500 ms wait → SIGKILL on the process group.
- On a dirty crash (OOM, `kill -9` on Electron itself) the children are orphaned; you'll find them in `ps` under PID 1. This is the same footprint as the embedded terminal — condash does not install a double-fork sentinel.

## Known limits

- No backoff on rapid Run/Stop cycles — a pathological loop will fork-spawn without throttling. If you're scripting against the API, rate-limit client-side.
- No per-session environment override. The spawned shell gets a copy of condash's own environment with three edits: `PATH` replaced by the resolved login-shell PATH, `TERM` forced to `xterm-256color`, and the `npm_config_*` trio dropped. Everything else — `LANG`, your exports, anything the launcher leaked — comes through as-is. Set `env` in your `Makefile` or a wrapper script if you need a clean slate. Details: [Environment variables](env.md#what-a-spawned-subprocess-inherits).
- No cross-repo dependency model. Two repos that should "start together" still need two clicks (or a `make` target in a third repo that invokes both).

## See also

- [Repositories and open-with buttons](../guides/repositories-and-open-with.md) — the related but distinct "launcher slots" that open external IDEs rather than PTY-owned processes.
- [Use the embedded terminal](../guides/terminal.md) — the sibling surface for ad-hoc commands.
- [Config files — `repositories`](config.md#repositories) — the broader schema the `run:` field sits inside.
