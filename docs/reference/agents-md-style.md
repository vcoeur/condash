---
title: AGENTS.md style guide · condash reference
description: How to write the per-conception ## Specifics section and durable team rules in an AGENTS.md file.
---

# AGENTS.md style guide

> **Audience.** Conception maintainers — anyone who edits the `AGENTS.md` at the root of a conception tree.

Each conception carries one `AGENTS.md` at its root, split by a marker line (`<!-- end condash agents -->`) into two parts. condash owns everything from line 1 through the marker (the H1 preamble + the `## General` section) and regenerates it on every `condash skills install` — the head carries `{{ conception_name }}` / `{{ description }}` substitution. Everything **after** the marker is yours: the `## Specifics` section, which describes the apps, repositories, and team rules for this workspace. condash never reads or rewrites the tail.

This guide covers the shape of the `## Specifics` section (below the marker).

## Apps table

Open `## Specifics` with the **Apps** table — one row per live app the conception covers.

**The table is generated.** [`condash applications sync-docs`](cli.md#applications) rewrites the whole region between two HTML-comment sentinels from the app registry:

```markdown
<!-- condash:apps:start -->
| App | Repo | Purpose | AGENTS.md | Knowledge |
|-----|------|---------|-----------|-----------|
| `#helio` | `~/src/acme/helio` | Customer-facing API | `/home/you/src/acme/helio/AGENTS.md` | `knowledge/internal/helio.md` |
| ↳ `#helio.web` | `~/src/acme/helio/apps/web` | Marketing site | | `knowledge/internal/helio.web.md` |
<!-- condash:apps:end -->
```

Add both sentinels by hand the first time. Without them `sync-docs` writes nothing and reports `missingSentinels`, printing `AGENTS.md has no condash:apps sentinels — add them around the Apps table once, then re-run.` — so a maintainer who follows the shape below but omits the markers is told why, though the command still exits 0 rather than failing.

| Column | Meaning |
|---|---|
| **App** | The `#handle`, backticked. Lower-case, kebab-or-dot, matching the repo basename when possible. The slug used in cross-references everywhere. A submodule row is prefixed `↳ ` and rendered directly under its parent. |
| **Repo** | The path as configured in `repositories[]` (e.g. `~/src/<workspace>/<repo>`). |
| **Purpose** | One line on what the app is for, from the registry's `purpose` field. Empty until set — fill it with `condash applications set <handle> --purpose "…"`, then re-run `sync-docs`. Pipes and newlines in the text are escaped and flattened so a long purpose cannot break the table. |
| **AGENTS.md** | Absolute path to the app's own agent-config file. `sync-docs` resolves it per checkout with the fallback `AGENTS.md` → `CLAUDE.md` → `.claude/CLAUDE.md`, so the cell always points at the file that actually exists; empty when the checkout carries none. (Formerly labelled **Config**.) |
| **Knowledge** | The conventional per-app knowledge entry point, `knowledge/internal/<handle>.md`. Emitted for every row whether or not the file exists — it is the path to create, not a link that was checked. |

Five columns, and no others: `sync-docs` regenerates the whole region, so any column you add by hand is erased on the next run — including a hand-kept companion table beside it, which is what the `Purpose` column exists to make unnecessary. Retired handles are omitted too — the table documents live apps only. Keep it a navigation index; operational config (formatter, port, base branch, …) belongs in `.condash/settings.json`.

Everything the table needs comes from the registry, so the way to change a row is [`condash applications set`](cli.md#applications) followed by `sync-docs` — never a hand-edit inside the sentinels.

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
