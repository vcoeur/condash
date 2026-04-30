---
title: Non-goals · condash explanation
description: Things condash will deliberately not do. Each entry has a why — read it before opening a "while we're at it" PR.
---

# Non-goals

Things condash will deliberately not do. Each entry has a *why* — read it before opening a "while we're at it" PR.

## No code editing in condash

condash is a Markdown reader/editor and a project dashboard. Source files (`.ts`, `.py`, `.tsx`, etc.) open in the user's IDE via the `open_with` slots. The CodeMirror editor inside the renderer is for Markdown content only — project READMEs, knowledge notes, and the JSON `configuration.json` file (which uses CodeMirror's JSON mode for syntax highlighting in the gear modal).

**Why**: an IDE is a different product. Trying to be one would mean LSP integration, language servers, multi-file refactoring, debugger UI — none of which serve the dashboard's role. Users already have a real IDE configured via `open_with.main_ide`.

## No general-purpose terminal

The xterm pane has two roles, and only two:

1. **Log view** for dev apps started by the Run button — see the output of `make dev` without context-switching.
2. **Project-scoped shell** so the user can interact with Claude / scripts in the right cwd without leaving condash.

Features that would push it toward "competing with your real terminal" — **nested splits** (beyond the 2-column dock), advanced multiplexing, **shell-history *text* search**, theme picker, GPU-acceleration tuning — are out of scope. The user already has Konsole / iTerm / Wezterm / etc. configured via `open_with.terminal`.

What *is* in scope, even though one could argue it edges toward "real terminal":

- **A 2-column dock** with cross-column tab drag-and-drop. The user often works two projects at once and wants to see both shells side-by-side without launching out. No further nesting — at most two columns.
- **Output search inside the live session** (Ctrl+F via `addon-search`). The searchable buffer is the visible session output, not a multi-session history database.
- **Prompt-jump navigation** (Ctrl+↑/↓ on OSC 133 marks). Moves between prompts within the current session — a navigation aid for long output, not a history grep.
- **Programming-font ligatures** as a single on/off toggle in the settings modal. One binary preference, not a configuration surface; ligatures off by default.

**Why**: terminal emulators are a mature product category. Reinventing one inside an Electron renderer is a poor trade. The pane exists because *embedding* unlocks the live runner badge, the per-repo Stop button, and the bottom-of-window status board — none of which a launched-out terminal can provide. The four in-scope items above are the ones that make the *embedded* dock usable for its two roles; everything beyond them is the user's real terminal's job.

## No JSON-format migration

`configuration.json` stays JSON. Migrating to YAML, TOML, or a fenced Markdown block is a non-goal.

**Why**: see [Config files](../reference/config.md) — stdlib parsing, strict schema validation, reliable in-app editing. A Markdown-first tree can comfortably contain one structured-data file.

## No LSP / code intelligence

No language server integration, no go-to-definition, no diagnostics. Even for Markdown — the editor is plain CM6 with Markdown syntax highlighting and wikilink decoration, nothing more.

**Why**: same reason as "no code editing." The IDE owns this surface.

## No notes search index

Search re-walks the conception tree on every query (`src/main/search.ts`). At conception scale (a few hundred Markdown files of a few KB each) this is comfortably under 50 ms; an index would be a maintenance burden for no observable user gain. See [Internals — Why no search index](internals.md#why-no-search-index).

**Why**: simplicity wins until it bites. If a future user has a 10 000-file conception tree, this becomes a real problem and a real index can be added. Today it isn't.

## No multi-window UI

A single `BrowserWindow`. Modals (note, PDF, help) are in-renderer overlays. The terminal pane is a bottom strip in the same window.

**Why**: window state is hard. Multi-window means restoring layouts, focus tracking, drag-between-windows. The dashboard's job is "one place to see what's going on" — multiple windows fight that goal.

## No code signing / OS-store distribution (yet)

condash ships unsigned `.deb`, `.AppImage`, `.dmg`, and `.exe` builds. Code-signing certificates and the App Store / Microsoft Store funnels are out of scope until there's a clear request from a user blocked by signature requirements.

**Why**: cost (certs, store fees, review cycles) without a current audience. Re-evaluate when someone hits a blocker that the [SmartScreen / Gatekeeper bypass](../get-started/install.md) doesn't solve.

## No telemetry / usage reporting

condash collects nothing and phones home for nothing except the `electron-updater` check (a `GET` against the GitHub Releases feed that carries only the user-agent).

**Why**: it's a personal-tool category. Telemetry would buy us nothing the user can't tell us directly.

## No HTTP API or browser frontend

The Electron build talks IPC end-to-end. There is no embedded HTTP server, no `condash-serve` headless mode (the Tauri lineage shipped one), and no `127.0.0.1:<port>` to drive Playwright at. End-to-end tests run inside Electron itself.

**Why**: a dual front door (HTTP + IPC) is twice the surface to keep coherent. The Tauri build needed HTTP because Tauri *is* an HTTP server wrapped in a webview; Electron has direct IPC, so the cost-benefit collapses.

## Revision log

### 2026-04-30 — terminal pane scope revision

The "No general-purpose terminal" entry was rewritten. The four post-`v2.0.0` features that the original prose forbade — 2-column dock, cross-column tab DnD, in-pane output search (Ctrl+F), and the ligature toggle — were not silent drift. They each serve the dock's two roles (log view + project-scoped shell) inside the embedded constraint, and the user explicitly wants them. The revised entry lists them as *in-scope* with the constraint that any further expansion (nested splits, multi-session search, theme picker, etc.) remains out.

OSC 133 prompt-jump (Ctrl+↑/↓) was added at the same time as the revamp; it navigates landmarks inside the current session and is therefore on-pillar with "log view", not a history grep.

The "no shell-history search" bullet was sharpened to "no shell-history *text* search" so that prompt-jump and live-output Ctrl+F aren't ambiguous.

## How to update this document

This file is *append-only in spirit*: don't soften an existing non-goal silently. If you think one needs revisiting, open an issue with a concrete user story, get sign-off, then edit the entry **and** add a dated paragraph to the Revision log explaining what changed and why. Removing a non-goal is a deliberate scope expansion, not a cleanup.
