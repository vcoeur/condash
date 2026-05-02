---
title: Background · condash
description: Why condash works the way it does, on one page.
---

# Background

The short version of why condash is shaped this way. The longer treatments — full pitch, full non-goals list, internals — are linked under each section.

## Why Markdown-first

Every project tracker answers a few questions: what am I working on, what's its status, what did I decide and why? condash exists because no off-the-shelf tracker gives you all three of these at once:

1. **The files are yours.** Editable in the editor you already use, diffable in git, grep-able from a shell.
2. **The dashboard is a view, not a second database.** Close it and the files don't move; delete it and the files don't move.
3. **Writing is cheap.** No form, no required fields, no schema migration. You type Markdown.

A README looks like this:

```markdown
# Migrate auth to session-cookie hybrid

**Date**: 2026-04-10
**Kind**: project
**Status**: now
**Apps**: `notes.vcoeur.com`
**Branch**: `feat/session-cookie-auth`

## Goal

Drop the JWT dependency without breaking existing sessions.

## Steps

- [x] Audit session-cookie usage
- [~] Implement hybrid read path
- [ ] Migration script for existing tokens
```

Every piece earns its keep. The `**Key**: value` headers render visually but parse with one regex. `## Steps` checkboxes work in any Markdown tool. `git diff` shows exactly what changed when you flip a step. `rg "session cookie"` finds it in 30 ms.

→ Full pitch with three good-fit scenarios: **[Why Markdown-first](why-markdown.md)**.

## What condash deliberately doesn't do

- **No multi-user collaboration.** Single-user, local-only.
- **No web UI / HTTP server.** End-to-end IPC.
- **No code editing.** Source files open in your IDE via configurable launcher slots.
- **No telemetry.** Nothing leaves your machine except the GitHub Releases feed for auto-updates.
- **No general-purpose terminal.** The xterm pane is a log view + project-scoped shell, not a Konsole / iTerm replacement.
- **No notes search index.** The conception tree is small enough that re-walking on every query is faster than maintaining an index.

→ Full list with rationale per item: **[Non-goals](non-goals.md)**.

## How the pieces fit

condash is an Electron app: a main process (Node.js — filesystem, IPC, watcher) and a renderer (Solid.js — dashboard UI). They talk over a single typed `CondashApi` IPC contract. Markdown reads on every refresh; mutations rewrite specific lines in your README files. A chokidar watcher fires on every file change so the UI is live without polling.

→ Process layout, IPC contract, write queue: **[Internals](internals.md)**.

→ Design principles every change should serve: **[Values](values.md)**.

→ Clone, build, run, ship: **[Contributing](contributing.md)**.
