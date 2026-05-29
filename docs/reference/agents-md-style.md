---
title: AGENTS.md style guide · condash reference
description: How to write the per-conception ## Specifics section and durable team rules in an AGENTS.md file.
---

# AGENTS.md style guide

> **Audience.** Conception maintainers — anyone who edits the `AGENTS.md` at the root of a conception tree.

Each conception carries one `AGENTS.md` at its root, split by a marker line (`<!-- end condash agents -->`) into two parts. condash owns everything from line 1 through the marker (the H1 preamble + the `## General` section) and regenerates it on every `condash skills install` — the head carries `{{ conception_name }}` / `{{ description }}` substitution. Everything **after** the marker is yours: the `## Specifics` section, which describes the apps, repositories, and team rules for this workspace. condash never reads or rewrites the tail.

This guide covers the shape of the `## Specifics` section (below the marker).

## Apps table

Open `## Specifics` with the **Apps** table — one row per app the conception covers.

| Column | Meaning |
|---|---|
| **App** | Logical name prefixed with `#` (e.g. `#alicepeintures.com`). Lower-case, kebab-or-dot, matching the repo basename when possible. The slug used in cross-references everywhere. |
| **Purpose** | One line in plain English — what the app *is*. Lets a reader skim "what's in this conception" without opening anything. |
| **Repo** | Absolute path on this host (e.g. `~/src/<workspace>/<repo>`). |
| **Config** | Path to the app's own agent-config file (typically `<repo>/AGENTS.md`). Spell it out when it lives elsewhere. |
| **Knowledge** | Path to the per-app knowledge entry-point in this conception (e.g. `knowledge/internal/<slug>.md`). The entry point is where deep details live — Config is the navigation layer. |

Keep the table tight: navigation fields only. Operational config (formatter, port, base branch, …) belongs in `.condash/settings.json`, not here.

### Submodules

A submodule (or any sub-repo / sub-package within a parent app) is reachable as `#<parent>/<submodule>/<path>` by default — one row in the table for the parent, submodules treated as internal structure. Promote a submodule to its own row when it earns the navigation cost: it has its own `AGENTS.md`, its own `knowledge/internal/*.md` entry, or it's worked on in independent PR cycles.

Naming for promoted submodules: bare `#<sub>` when the basename is unique workspace-wide; dotted `#<parent>.<sub>` (e.g. `#PaintingManager.app`) when the bare slug would collide with another app or another submodule.

The `submodules:` block in `.condash/settings.json` is orthogonal — that block lists runnable targets for the dashboard (what `make dev` to invoke, what to force-stop). The Apps table is the human / agent navigation index. They can disagree without harm; align by intent, not by mirroring.

### Cross-references via `#<app>/<path>`

Knowledge entries, project notes, and rule bodies refer to source code as `#<app>/<path-in-repo>` (e.g. `#<app>/src/server.ts:42`) instead of `~/src/<workspace>/<app>/...`. The `#` prefix makes references grep-friendly and decouples prose from any one host's filesystem layout — the Apps table is the only place the absolute path appears.

When in doubt: an `#<name>/...` token is *always* an app reference; a path with no leading `#` is a path inside *this* conception (`projects/...`, `knowledge/...`, `.condash/settings.json`).

## Rules

After the Apps table, add durable team rules — anything an agent should always know about this workspace. Each rule:

- Lives under a `### <imperative title>` heading.
- Has body bullets describing *what to do*.
- Carries one **Why:** sentence explaining the rationale (so an agent can judge edge cases).
- Optionally a **How to apply:** sentence for when the rule kicks in.

Group rules under `### ` topical headings (e.g. `### Repo workflow`, `### Legal / privacy`) when the file gets long. Stable by design — no verification stamps; rules either live or get deleted.
