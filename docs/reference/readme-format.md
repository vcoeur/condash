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
| Status | `status` | `**Status**` | in practice | all | `now` / `review` / `later` / `backlog` / `done`. Omitting it is not an error — the parser defaults to `backlog` and `condash projects validate` reports a **warning**, not a failure. Unknown values are preserved verbatim (no silent rewrite), log a parser warning, and surface a `!? <value>` badge on the card. |
| Apps | `apps` (sequence) | `**Apps**` | no | all | YAML list of app names; legacy form is comma-separated, backtick-wrapped. Powers the per-app filter. |
| Branch | `branch` | `**Branch**` | no | projects | Git branch name. Hints the `/pr` skill + worktree isolation rules. |
| Base | `base` | `**Base**` | no | projects | Base branch for `/pr`. Defaults to `origin/HEAD`. |
| Parent | `parent` | `**Parent**` | no | all | Slug of the item this one spins off from. Drives the card's **Part of** banner and the parent's **Subprojects** rows. [↓](#parent-subprojects) |
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

`condash projects create` emits this shape from v2.16.0 onward. To migrate existing bold-prose READMEs in the tree, run:

```bash
condash projects rewrite-headers --dry-run   # preview
condash projects rewrite-headers              # write
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
- `date`, `kind`, `status` (aka `priority`), `apps`, `branch`, `base`, `parent`, `extra` (severity, environment, …) — typed fields.
- `summary` — the complete, unbounded content of the first `##` section only. Wrapped
  source lines within a paragraph become spaces; one or more blank lines between
  paragraphs become a single blank line, which the project preview preserves.
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

Complete intent for the project. The Goal may contain multiple paragraphs; all of
them appear in the project preview with paragraph separation preserved.

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

The complete first H2 section is the summary shown in the project preview. It may
contain multiple paragraphs; the next H2 heading ends it.

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
  - helio-web
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

A README with **no** `status:` line at all is read as `backlog` — no badge, no error, just a warning from `condash projects validate`. That is the one case where the parser supplies a value; every other input is passed through untouched.

Anything outside the five known values is **preserved verbatim** — the parser does not rewrite it. Two side-effects keep typos from slipping past:

- The parser logs a `WARNING` with the offending value and the item's path, e.g. `unknown Status 'wip' in projects/2026-04/2026-04-17-foo/README.md`.
- The card renders a red warning badge carrying the offending value verbatim, with a tooltip showing the valid enum, and the item is filed under its own **`?`** group. Sort order falls back to "after every known value" (per `statusOrder` in [`src/shared/projects.ts`](https://github.com/vcoeur/condash/blob/main/src/shared/projects.ts)), so the typo sits visibly at the end of the list until corrected. The badge disappears as soon as the README is fixed — the next poll cycle re-parses, finds a valid Status, and drops the badge.

![A `?` group at the end of the Projects pane, its one card carrying a red `wip` badge](../assets/screenshots/status-unknown-badge-light.png#only-light)
![A `?` group at the end of the Projects pane, its one card carrying a red `wip` badge](../assets/screenshots/status-unknown-badge-dark.png#only-dark)

Without the badge, a typo like `active` would silently sit at the tail of the sort with no visible marker; with it, the item sticks out until corrected.

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

## Parent (subprojects) { #parent-subprojects }

A plan often spawns implementation items that deserve their own README, timeline, and branch. `parent:` records that edge — one line on the **child**, naming the plan it derives from:

```yaml
---
date: 2026-07-18
kind: project
status: now
apps:
  - condash
branch: checkout-revamp-payments
parent: 2026-07-15-checkout-revamp
---
```

- **The child declares; the parent stays untouched.** The reverse edge — a parent's list of children — is derived by scanning the project list, never stored, so there is exactly one source of truth and no pair of fields to keep in sync.
- **The value is a slug**, in the canonical dated form (`YYYY-MM-DD-slug`). Unlike `apps` / `branch` it is *not* backtick-wrapped; the bold-prose parser accepts either form for hand-written files, but nothing emits bold-prose `**Parent**`.
- **`condash projects create --parent <slug>` is the safe way to set it.** The short form resolves against the tree and the canonical dated slug is what gets written, so the reference stays stable; an unknown or ambiguous slug exits 4 / 6 rather than writing a dangling reference.
- **List a plan's children** with [`condash projects list --parent <slug>`](cli.md#projects).
- **A self-reference is a validation error** (`parent '<slug>' refers to the item itself`). Whether the slug resolves to a real item is checked at create time, not on every parse — a parent that was never created, or was renamed afterwards, is left dangling rather than rejected.

On the Projects pane the edge renders both ways. The child card grows a **Part of ↑** banner carrying the parent's title and status pill; the parent card grows a **Subprojects** fold — a header with the child count, **collapsed by default**, that opens to one clickable row per child with its own status pill, ordered by status then slug (the open/closed state is remembered per parent, in the same browser-local store as the section collapse). Both banner and rows are buttons that open the referenced item. Every card in the chain — the root plan, any middle node, every leaf — shares one **family colour** on the card frame, hashed from the root's slug; it is the only colour a card frame ever carries, and standalone cards stay neutral. The frame itself also encodes the direction: a card with children keeps only a narrow solid **left** edge in the family colour, a card that declares a `parent:` keeps only a narrow dashed **right** edge, and a mid-tree node wears both at once — hierarchy is decoration only, so cards are never reordered, indented or nested to express it. A dangling `parent:` degrades to the raw slug as non-clickable text rather than disappearing; a card whose only relation is that dangling link takes no family colour — there is no second card for a hue to tie it to (a dangling link above a node that has children just makes that node the family's root).

## Step markers

The `## Steps` list uses five canonical markers, recognised by the parser
and round-tripped by every writer (CLI mutation verbs, GUI step-toggle,
the markdown editor):

- `- [ ]` — **todo.** Not yet started.
- `- [~]` — **doing.** In flight.
- `- [x]` — **done.** Resolved successfully.
- `- [!]` — **blocked.** Surfacing a problem that needs attention; counts
  toward the milestone total but not toward resolved.
- `- [-]` — **dropped.** Resolved by removing the work; counts as resolved
  for the progress bar.

The canonical list lives in `src/shared/types/project.ts` (`STEP_MARKERS`). Any
marker outside this set is treated as plain prose by the parser.

## Body conventions

Header fields only describe the item's metadata. The body (everything after the title, in YAML form; everything after the first `##`, in bold-prose form) carries the content — goal, scope, steps, timeline, deliverables, notes. See:

- [conception convention](conception-convention.md) — the required and conventional `##` sections.
- [Linking items with wikilinks](../guides/wikilinks.md) — `[[slug]]` / `[[slug|label]]` syntax inside the body and notes.
- [Deliverables and PDFs](../guides/deliverables.md) — the PDF link pattern the dashboard recognises.

## What the parser never looks at

- TOML frontmatter — only `---`-delimited YAML is recognised.
- `##` sections other than `Steps` (plus any section carrying checkboxes), `Deliverables`, and `Timeline` — rendered verbatim as Markdown; not parsed for structure.
- `notes/` subdirectories — indexed as files under the card but never mined for metadata.
- Any file in the item directory other than `README.md`.
