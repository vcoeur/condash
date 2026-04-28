# condash non-goals

Things condash will deliberately not do. Each entry has a *why* — read it before opening a "while we're at it" PR.

## No code editing in condash

condash is a markdown reader/editor and a project dashboard. Source files (`.ts`, `.py`, `.tsx`, etc.) open in the user's IDE via the `open_with` slots. The CodeMirror editor inside the renderer is for markdown content only — project READMEs, knowledge notes, and the JSON `configuration.json` file (which uses CodeMirror's JSON mode for syntax highlighting in the gear modal).

**Why**: an IDE is a different product. Trying to be one would mean LSP integration, language servers, multi-file refactoring, debugger UI — none of which serve the dashboard's role. Users already have a real IDE configured via `open_with.main_ide`.

## No general-purpose terminal

The xterm pane has two roles, and only two:

1. **Log view** for dev apps started by the Run button — see the output of `make dev` without context-switching.
2. **Project-scoped shell** so the user can interact with Claude / scripts in the right cwd without leaving condash.

Features that would push it toward "competing with your real terminal" — pane splitting, advanced multiplexing, shell-history search, theme picker, ligature configuration, GPU-acceleration tuning — are out of scope. The user already has Konsole / iTerm / Wezterm / etc. configured via `open_with.terminal`.

**Why**: terminal emulators are a mature product category. Reinventing one inside an Electron renderer is a poor trade. The pane exists because *embedding* unlocks the LIVE badge, the per-repo Stop button, and the bottom-of-window status board — none of which a launched-out terminal can provide.

## No JSON migration

`configuration.json` stays JSON. Migrating to YAML, TOML, or a fenced markdown block is a non-goal.

**Why**: see [`configuration.md`](configuration.md) — stdlib parsing, strict schema validation, reliable in-app editing. A markdown-first tree can comfortably contain one structured-data file.

## No LSP / code intelligence

No language server integration, no go-to-definition, no diagnostics. Even for markdown — the editor is plain CM6 with markdown syntax highlighting and wikilink decoration, nothing more.

**Why**: same reason as "no code editing." The IDE owns this surface.

## No notes search index

Search re-walks the conception tree on every query (`src/main/search.ts`). At conception scale (a few hundred markdown files of a few KB each) this is comfortably under 50 ms; an index would be a maintenance burden for no observable user gain.

**Why**: simplicity wins until it bites. If a future user has a 10 000-file conception tree, this becomes a real problem and a real index can be added. Today it isn't.

## No multi-window UI

A single `BrowserWindow`. Modals (note, PDF, help) are in-renderer overlays. The terminal pane is a bottom strip in the same window.

**Why**: window state is hard. Multi-window means restoring layouts, focus tracking, drag-between-windows. The dashboard's job is "one place to see what's going on" — multiple windows fight that goal.

## No code signing / OS-store distribution (yet)

condash ships as `.deb` + AppImage on Linux. macOS and Windows packaging exist in `electron-builder.yml` but aren't signed; they're for self-builders, not distribution. Code-signing certificates and the App Store / Microsoft Store funnels are out of scope until there's a clear request from a non-Linux user.

**Why**: cost (certs, store fees, review cycles) without a current audience. Re-evaluate when someone outside the Linux flow asks.

## No telemetry / usage reporting

condash collects nothing and phones home for nothing except the auto-update check (which is a `GET` against the GitHub Releases feed and carries only the user-agent).

**Why**: it's a personal-tool category. Telemetry would buy us nothing the user can't tell us directly.

---

## How to update this document

This file is *append-only in spirit*: don't soften an existing non-goal. If you think one needs revisiting, open an issue with a concrete user story, get sign-off, and only then edit. Removing a non-goal is a deliberate scope expansion, not a cleanup.
