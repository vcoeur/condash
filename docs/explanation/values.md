---
title: Values · condash explanation
description: The design values that drive condash. The positive counterpart to the non-goals page — read this before adding a feature, then check the non-goals before designing it.
---

# Values

> **Audience.** Developer — anyone designing, reviewing, or contributing changes to condash.

[Non-goals](non-goals.md) is a list of things condash will deliberately not do. This page is the positive counterpart: the principles that explain *why* the non-goals are non-goals, and that should guide any feature decision.

## 1. The Markdown is the source of truth

The conception tree on disk is authoritative. The dashboard is a renderer, not a database front-end. Anything condash knows about your work, it just read from a file. Anything you change in the dashboard, it just wrote to a file.

Practical consequences:

- **No cache except where simplicity demands one.** The git-status TTL cache exists because polling `git status` on every paint is wasteful, but the cache is 3 seconds — short enough to be invisible, short enough to never lie about reality.
- **No background sync.** The user's editor and the dashboard write to the same files; concurrency is handled by drift checks, not by reconciling a separate database.
- **No schema migration.** Markdown header fields are parsed lazily. New fields can appear; old fields can disappear; existing trees keep working.

If a feature needs a database, an index, or a sync server, it probably belongs somewhere other than condash.

## 2. Single user, local only

condash binds to nothing public. It speaks IPC to one renderer and `fs` to one tree. There is no auth, no multi-user mode, no remote control surface, no opt-in telemetry.

Practical consequences:

- **No login screen, ever.** No accounts, no API keys, no OAuth flow.
- **No opt-out telemetry either.** condash collects nothing about you. The only thing it ever fetches is the GitHub Releases feed during the auto-update check.
- **No feature where "single-user" is in tension with how it's meant to work.** Real-time collaboration, presence indicators, "X is editing this" markers: not even on the long-term roadmap. Use git.

## 3. Simple over clever

Reach for the boring solution first. Re-walk the tree on every search query. Use a 3-second cache instead of a coherent index. Atomic writes via tmp + rename instead of an in-memory journal. Solid signals instead of state-management folklore.

Practical consequences:

- **Three similar lines is fine.** Don't introduce an abstraction the third time the pattern appears — wait until the fifth, when you actually understand the cleavage.
- **No frameworks for things stdlib does.** The Markdown headers parse with a regex. The README walker is a single recursive `readdir`. There is no DI container, no event bus, no service-locator.
- **`tsc --noEmit` + esbuild instead of a unified build framework.** The build pipeline fits in `scripts/build-electron.mjs`.

The exception: where simplicity actively hurts the user. The 16 ms paint budget below is non-negotiable, even when "simple" would mean a 60 ms re-render.

## 4. Sub-16-millisecond interaction-to-paint

Any user-initiated action must commit to paint within one display frame at 60 Hz. This is the budget that makes the dashboard feel like a tool and not a webpage.

Practical consequences:

- **Optimistic UI is the default.** A click toggles the step in the renderer immediately; the IPC write follows; on failure, the renderer rolls back and surfaces a toast.
- **No animations on critical paths.** Status pills don't fade. Cards don't slide. The drag-drop handler does not animate the dropped position into place.
- **Profiling, not vibes.** When a renderer pause appears, it's measured (with `performance.mark` / Chrome DevTools), not handwaved. The IPC handler that backs each verb has a known latency.

If a feature can't fit in 16 ms, it gets a different surface — a modal, a dialog, an explicit "running…" state. Never a stalled main UI.

## 5. Cross-platform without per-OS branches in the renderer

condash is Electron precisely so the renderer renders identically on Linux, macOS, and Windows. The renderer code is allowed to call native APIs through IPC, but it must never branch on `process.platform`.

Practical consequences:

- **All path normalisation happens at the IPC boundary.** `toPosix` in `src/shared/path.ts` is the only path-format API the renderer touches. The main process keeps native separators internally.
- **All shell wrapping happens in the main process.** `wrapForShell` in `src/main/terminals.ts` builds platform-specific argv for `bash`, `cmd.exe`, and `pwsh`. The renderer just sends `{shell, command}`.
- **CSS uses logical properties** (no `marginLeft`-style; use `margin-inline-start`). Flex / grid only — no absolute pixel positioning that depends on a particular OS chrome.

If a feature would require a per-OS branch in the renderer, it needs a different design.

## 6. Open standards over bespoke formats

When a standard exists, use it. When one doesn't, prefer plain text + a regex over a custom binary format.

Practical consequences:

- **GitHub Flavored Markdown for content.** Tasks (`[ ]`/`[x]`) are GFM-task-list. Headers are H1/H2/H3. Tables are pipe tables. Anyone with a Markdown editor can read the same files.
- **JSON for structured config.** No YAML, no TOML. JSON has stdlib parsers everywhere, strict schema validators, and reliable in-app editing.
- **OSC 133 for terminal prompt boundaries.** Same protocol as iTerm2, WezTerm, kitty, Warp. Drop-in shell snippets, no custom protocol.
- **`xterm-256color` for terminal capabilities.** Works with every modern terminal program.

The exception: when a standard doesn't exist (the **Status** field syntax, the directory layout `projects/YYYY-MM/<slug>/`), pick the simplest possible plain-text shape and commit to it.

## 7. The dashboard is a thin write surface

Of every action a user performs, only a small handful translate to file writes from the dashboard. The rest belong to the user's editor or to a Claude Code session via the management skills.

The full list of writes lives in [Mutation model](../reference/mutations.md). It is short on purpose.

Practical consequences:

- **No "rich editing" of READMEs.** The text is a plain Markdown buffer in CodeMirror with task-list and wikilink decoration. No WYSIWYG, no toolbar, no slash-commands.
- **Mutations are reversible by `sed`.** Anything condash writes, you could write by hand. The renderer is a shortcut, not a magic layer.
- **Drift is detected, not reconciled.** If the file changed under condash's feet, the next mutation refuses and the user re-reads the file. There is no merge.

When in doubt, do less from the dashboard, more from the editor.

## 8. Skills are first-class

condash ships its own Claude Code skills (`/projects`, `/knowledge`) and is designed to coexist with them. Anything the dashboard does, the user can also do from a Claude Code session via plain file I/O — no IPC bridge, no API surface, no integration layer.

Practical consequences:

- **No feature that requires the dashboard to be running** to make sense. Items can be created, edited, and closed entirely from the shell or from a Claude session — the dashboard catches up via the chokidar watcher.
- **No feature that requires bespoke "AI integration".** condash doesn't talk to any LLM directly. The skills do, on the user's terms.
- **The skill content is shipped from condash itself.** `condash skills install` copies the canonical skill files into the user's tree. New skill verbs land in condash, the user re-runs `condash skills install`, and they're available in Claude Code.

## How to use this page

When you open a PR that adds a feature, ask: which value drives this? When you reject a PR, ask: which value did this trample? When a feature looks compelling but doesn't fit any of these eight, that's a signal it might belong in a different tool.

If you think a value needs revisiting, open an issue with a concrete user story, get sign-off, then propose the change here. Like the [non-goals](non-goals.md) page, this is append-only in spirit — softening a value silently is a recipe for scope creep.

## See also

- [Non-goals](non-goals.md) — the negative counterpart to this page.
- [Internals](internals.md) — the load-bearing invariants that implement these values.
- [Why Markdown-first](why-markdown.md) — the user-facing pitch built on top of value 1.
- [Contributing](contributing.md) — how to put these values into practice when working on condash itself.
