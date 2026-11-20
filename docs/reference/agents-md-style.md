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
| App | Repo | AGENTS.md | Knowledge |
|-----|------|-----------|-----------|
| `#helio` | `helio` | `helio/AGENTS.md` | `knowledge/internal/helio.md` |
| ↳ `#helio.web` | `helio/apps/web` | `helio/apps/web/AGENTS.md` | `knowledge/internal/helio.web.md` |
<!-- condash:apps:end -->
```

Add both sentinels by hand the first time. Without them `sync-docs` writes nothing and reports `missingSentinels`, printing `AGENTS.md has no condash:apps sentinels — add them around the Apps table once, then re-run.` — so a maintainer who follows the shape below but omits the markers is told why, though the command still exits 0 rather than failing.

| Column | Meaning |
|---|---|
| **App** | The `#handle`, backticked. Lower-case, kebab-or-dot, matching the repo basename when possible. The slug used in cross-references everywhere. A submodule row is prefixed `↳ ` and rendered directly under its parent. |
| **Repo** | The path as configured in `repositories[]` (e.g. `~/src/<workspace>/<repo>`, or bare `helio` for a workspace-relative entry). |
| **AGENTS.md** | The app's own agent-config file, **relative to the workspace root**, resolved per checkout with the fallback `AGENTS.md` → `CLAUDE.md` → `.claude/CLAUDE.md` so the cell always points at the file that actually exists; empty when the checkout carries none. A repo configured with an absolute path outside the workspace renders that path verbatim — there is no workspace-relative form to invent. (Formerly labelled **Config**.) |
| **Knowledge** | The conventional per-app knowledge entry point, `knowledge/internal/<handle>.md`. Emitted for every row whether or not the file exists — it is the path to create, not a link that was checked. |

Four columns, and no others: `sync-docs` regenerates the whole region, so any column you add by hand is erased on the next run. Retired handles are omitted too — the table documents live apps only. Keep it a navigation index; operational config (formatter, port, base branch, …) belongs in `.condash/settings.json`.

Everything the table needs comes from the registry, so the way to change a row is [`condash applications set`](cli.md#applications) followed by `sync-docs` — never a hand-edit inside the sentinels.

### The table is reproducible: `condash-apps.json`

The rows come from the app registry. By default that registry is `.condash/settings.json` — gitignored, per-machine — so two machines running `sync-docs` on the same clone can regenerate different tables and flip-flop the committed file forever. The optional committed registry file at the conception root ends that:

```json
{
  "repositories": [
    "condash",
    { "handle": "kasten", "path": "notes.vcoeur.com" }
  ],
  "retired_apps": []
}
```

- **When the file exists**, `sync-docs` reads the table's registry from it alone — `repositories` / `retired_apps` in `.condash/settings.json` are ignored for the table. The same entry shapes as the settings registry apply (see [Config files → repositories](config.md#repositories)), validated just as strictly, and the file carries **only** the two registry keys: a `workspace_path` or any other per-machine key is rejected.
- **When it does not exist**, today's behaviour is unchanged — the table comes from `.condash/settings.json`.
- **Adopt it in one command:** `condash applications sync-docs --export` writes `condash-apps.json` from the current settings registry (validated with the same schema before it lands). While the file exists, `applications add` / `set` / `rename` re-export it in the same operation — it never drifts from the settings registry; hand-editing is possible but is overwritten by the next mutation.
- **Invalid file → hard error.** A malformed or schema-violating `condash-apps.json` makes `sync-docs` fail with a `condash-apps.json: <path> — <reason>` message and leave the sentinel block untouched; it never falls back silently to a machine-local table.

Relative repo paths in the committed file resolve against `workspace_path` from the settings — the one per-machine input still read, because relative repo paths need *a* filesystem anchor. It cancels out of the output: cells render workspace-relative, so two machines with the same clone regenerate byte-identical tables regardless of where the workspace sits on disk. One residual input is inherent: the `AGENTS.md` column probes each checkout for its instruction file, so a repo that exists on one machine and is uncloned on another renders an empty cell on the second one.

### Submodules

A submodule (or any sub-repo / sub-package within a parent app) is reachable as `#<parent>/<submodule>/<path>` by default — one row in the table for the parent, submodules treated as internal structure. Promote a submodule to its own row when it earns the navigation cost: it has its own `AGENTS.md`, its own `knowledge/internal/*.md` entry, or it's worked on in independent PR cycles.

Naming for promoted submodules: bare `#<sub>` when the basename is unique workspace-wide; dotted `#<parent>.<sub>` (e.g. `#PaintingManager.app`) when the bare slug would collide with another app or another submodule.

The `submodules:` block in `.condash/settings.json` is orthogonal — that block lists runnable targets for the dashboard (what `make dev` to invoke, what to force-stop). The Apps table is the human / agent navigation index. They can disagree without harm; align by intent, not by mirroring.

### Cross-references via `#<app>/<path>`

Knowledge entries, project notes, and rule bodies refer to source code as `#<app>/<path-in-repo>` (e.g. `#<app>/src/server.ts:42`) instead of `~/src/<workspace>/<app>/...`. The `#` prefix makes references grep-friendly and decouples prose from any one host's filesystem layout. The Apps table follows the same rule — its `AGENTS.md` cells are workspace-relative, so the committed `AGENTS.md` contains no absolute path at all.

When in doubt: an `#<name>/...` token is *always* an app reference; a path with no leading `#` is a path inside *this* conception (`projects/...`, `knowledge/...`, `.condash/settings.json`).

## Rules

After the Apps table, add durable team rules — anything an agent should always know about this workspace. Each rule:

- Lives under a `### <imperative title>` heading.
- Has body bullets describing *what to do*.
- Carries one **Why:** sentence explaining the rationale (so an agent can judge edge cases).
- Optionally a **How to apply:** sentence for when the rule kicks in.

Group rules under `### ` topical headings (e.g. `### Repo workflow`, `### Legal / privacy`) when the file gets long. Stable by design — no verification stamps; rules either live or get deleted.
