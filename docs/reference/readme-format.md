---
title: README format · condash reference
description: The header fields condash reads from each item's README.md — types, allowed values, kind-specific extras.
---

# README format

> **Audience.** Daily user.

## At a glance

Every item lives at `projects/YYYY-MM/YYYY-MM-DD-slug/README.md`. The file opens with a **header** (item metadata) followed by an H1 title and the body content.

From condash v2.16.0 onward, the canonical header shape is **YAML frontmatter** — a `---`-delimited block at the top of the file. The legacy **bold-prose** shape (`**Key**: value` lines under the H1) is also accepted indefinitely, so you do not have to migrate existing READMEs unless you want to.

| Field | YAML key | Bold-prose key | Required | Applies to | Notes |
|---|---|---|---|---|---|
| Date | `date` | `**Date**` | no | all | ISO `YYYY-MM-DD`. Defaults to the directory's date prefix when missing. |
| Kind | `kind` | `**Kind**` | no | all | `project` / `incident` / `document`. Defaults to `project`. |
| Status | `status` | `**Status**` | **yes** | all | `now` / `review` / `later` / `backlog` / `done`. Unknown values coerce to `backlog`, log a parser warning, and surface a `!?` badge on the card. |
| Apps | `apps` (sequence) | `**Apps**` | no | all | YAML list of app names; legacy form is comma-separated, backtick-wrapped. Powers the per-app filter. |
| Branch | `branch` | `**Branch**` | no | projects | Git branch name. Hints the `/pr` skill + worktree isolation rules. |
| Base | `base` | `**Base**` | no | projects | Base branch for `/pr`. Defaults to `origin/HEAD`. |
| Environment | `environment` | `**Environment**` | no | incidents | `PROD` / `STAGING` / `DEV`. |
| Severity | `severity` | `**Severity**` | no | incidents | `low` / `medium` / `high`. |
| Severity impact | `severity_impact` | (combined into `**Severity**`) | no | incidents | One-line user-visible impact. |
| Languages | `languages` | `**Languages**` | no | documents | Output language for deliverables. `en` / `fr` / … |

YAML keys are `snake_case`. Bold-prose keys are case-insensitive; values trimmed. Order does not matter in either shape. Unknown fields are silently ignored — safe to add your own.

## Header shape — YAML frontmatter (canonical)

```markdown
---
date: 2026-04-18
kind: project
status: now
apps:
  - helio
branch: feat/bench-harness
base: main
---

# Helio benchmark harness

## Goal
…
```

`condash-cli projects create` emits this shape from v2.16.0 onward. To migrate existing bold-prose READMEs in the tree, run:

```bash
condash-cli projects rewrite-headers --dry-run   # preview
condash-cli projects rewrite-headers              # write
```

The verb is idempotent (already-YAML files are no-ops) and skips any README whose body has unexpected content between the meta block and the first `##` heading — re-run after hand-editing those files.

## Header shape — bold-prose (legacy, still accepted)

```markdown
# Helio benchmark harness

**Date**: 2026-04-18
**Kind**: project
**Status**: now
**Apps**: `helio`
**Branch**: `feat/bench-harness`

## Goal
…
```

The parser scans every line between the title and the first `##` heading. A line is treated as metadata if it matches `**<Key>**: <value>`. The first blank line is not a terminator — only the first `##` heading is.

Both shapes feed the same parser output ([`src/main/parse.ts`](https://github.com/vcoeur/condash/blob/main/src/main/parse.ts) and [`src/shared/header.ts`](https://github.com/vcoeur/condash/blob/main/src/shared/header.ts)):

- `title` — the H1 (frontmatter form: H1 below the closing `---`; bold-prose form: H1 at the top).
- `date`, `kind`, `status` (aka `priority`), `apps`, `branch`, `base`, `extra` (severity, environment, …) — typed fields.
- `summary` — first paragraph after the first `##` heading, truncated to 300 chars.
- `sections` — every `## <heading>` with checkboxes under it (see [conception convention](conception-convention.md)).
- `deliverables` — every `## Deliverables` link to a `.pdf` (see [conception convention](conception-convention.md)).

## Examples

### Project (YAML)

```markdown
---
date: 2026-04-10
kind: project
status: now
apps:
  - notes.vcoeur.com
  - vcoeur.com
branch: feat/session-cookie-auth
base: main
---

# Migrate auth to session-cookie hybrid

## Goal

One-paragraph intent. Becomes the card summary.

## Scope
…
## Steps
- [ ] Audit current session-cookie usage
- [~] Implement hybrid read path
- [x] Decide cookie attributes

## Timeline
- 2026-04-10 — Project created
```

### Incident (YAML)

```markdown
---
date: 2026-04-14
kind: incident
status: review
apps:
  - vcoeur.com
environment: PROD
severity: high
severity_impact: Login returns 500 under concurrent load
---

# Login returns 500 under concurrent load

## Description

First paragraph is the card summary. Keep it one sentence for the dashboard.

## Timeline
- 2026-04-14 11:04 — Pager fires
- 2026-04-14 11:42 — Rollback to previous release
- 2026-04-14 14:20 — Root cause: connection pool exhaustion
```

`environment` and `severity` are incident-only in convention, but the parser will accept them on any kind. Nothing enforces the type split — the dashboard simply renders whatever it finds.

### Document (YAML)

```markdown
---
date: 2026-04-01
kind: document
status: review
apps:
  - notes.vcoeur.com
  - vcoeur.com
  - alicepeintures.com
languages:
  - fr
  - en
---

# GDPR audit — 2026 spring review

## Deliverables

- [Rapport technique](rapport-technique.pdf) — full French version with code references
- [Executive summary](summary-en.pdf) — one-page English abridgement
```

## Status

Five values, in this exact order:

```
now → review → later → backlog → done
```

Anything outside this set is **coerced to `backlog`** with two side-effects so the typo doesn't slip past you:

- The parser logs a `WARNING` with the offending value and the item's path, e.g. `unknown Status 'wip' in projects/2026-04/2026-04-17-foo/README.md — coerced to 'backlog'`.
- The card renders a red **`!? <value>`** badge next to the status pill, with a tooltip showing the valid enum. It disappears as soon as the README is fixed — the next poll cycle re-parses, finds a valid Status, and drops the badge.

![Backlog card showing a red `!? WIP` badge next to its status pill](../assets/screenshots/status-unknown-badge-light.png#only-light)
![Backlog card showing a red `!? WIP` badge next to its status pill](../assets/screenshots/status-unknown-badge-dark.png#only-dark)

Without the badge, a typo like `active` would silently land in the `backlog` column; with it, the item sticks out visibly until corrected.

See [conception convention](conception-convention.md) for the status model and what each value means.

## Apps

YAML form: a sequence of plain strings (no backticks, no parentheticals).

```yaml
apps:
  - vcoeur.com
  - notes.vcoeur.com
  - condash
```

Bold-prose form: comma-separated, backtick-wrapped. Trailing `(…)` parentheticals are stripped, so `` `vcoeur.com` (frontend) `` becomes `vcoeur.com`.

```markdown
**Apps**: `vcoeur.com`, `notes.vcoeur.com`, `condash`
```

Either way, the resulting list powers the dashboard's per-app filter chips.

## Body conventions

Header fields only describe the item's metadata. The body (everything after the title, in YAML form; everything after the first `##`, in bold-prose form) carries the content — goal, scope, steps, timeline, deliverables, notes. See:

- [conception convention](conception-convention.md) — the required and conventional `##` sections.
- [Linking items with wikilinks](../guides/wikilinks.md) — `[[slug]]` / `[[slug|label]]` syntax inside the body and notes.
- [Deliverables and PDFs](../guides/deliverables.md) — the PDF link pattern the dashboard recognises.

## What the parser never looks at

- TOML frontmatter — only `---`-delimited YAML is recognised.
- `##` sections other than `Steps` and `Deliverables` — rendered verbatim as Markdown; not parsed for structure.
- `notes/` subdirectories — indexed as files under the card but never mined for metadata.
- Any file in the item directory other than `README.md`.
