---
title: The Projects pane · condash guide
description: Your items grouped by status — the section stack, the three ways to change status, the create-item modal, and how closing and reopening an item work.
---

# The Projects pane

> **Audience.** Daily user.

**When to read this.** You want the day-to-day operations of the primary pane — how items are grouped, how to change a status, how the create modal works — gathered in one place.

The Projects pane is the left-hand view that renders every item in your conception (`projects/**/*/README.md`), one card per item, grouped by status. It is the first item on the activity rail, before [Tasks](tasks-pane.md), [Deliverables](deliverables-pane.md), and [Performance](performance-pane.md).

![The condash window: the Projects pane grouping items under NOW / REVIEW / LATER / BACKLOG / DONE, with the Code pane alongside](../assets/screenshots/dashboard-overview-light.png#only-light)
![The condash window: the Projects pane grouping items under NOW / REVIEW / LATER / BACKLOG / DONE, with the Code pane alongside](../assets/screenshots/dashboard-overview-dark.png#only-dark)

## The status stack

Items form **one scrolling stack of status sections, in the fixed order** `now`, `review`, `later`, `backlog`, `done` — plus a trailing `?` section for any item whose `status:` isn't one of those five (a typo like `wip` lands there, card sprouting a red `!? <value>` badge so it stands out until corrected).

Two sections start collapsed:

- **`backlog`** — the default for an item with no `status:` line at all.
- **`done`** — subdivided into a "closed in the last 7 days" band at the top plus **one collapsible subgroup per month**, so a long history stays browsable without becoming a wall of cards.

The status values and their meanings are defined in [Status model](../reference/conception-convention.md#status-model).

## What a card carries

Two head rows, then a meta row. The first row is the card's chrome: a **star** (see [Star the items that matter](#star)), the item's **short slug** — its directory name with the `YYYY-MM-DD-` prefix dropped, which is exactly what `condash projects <verb> <slug>` and the `{shortSlug}` [action variable](../reference/config.md#terminalprojectactions) take; hover it for the full dated slug — the **date** of the item's last timeline entry beside it (hover for first and last), and the work-on action on the right. That row never wraps: a long slug ellipsises before the date or the action move. The second row is the **kind badge** — a small hairline pill with a monochrome outline and the word (diamond = project, triangle = incident, page = document; a README whose `kind:` didn't parse gets none) — followed by the **title**, which flows on for as many lines as it needs and is never cut. Below that a single meta row: app pills, `branch:`, a badge per open PR on that branch, a warn glyph for a non-canonical status, and the step progress.

The card frame is **neutral** — colour on this pane means "belongs together" and nothing else. A parent and its subprojects share one hue on their frame and a hint of it in the title, so a plan and its spin-offs read as one group at a glance; every other card keeps the plain frame (including a card whose only relation is a `parent:` that no longer resolves — there is nothing for a hue to tie it to), and status stays on the section, not the card. A card in a family also grows a **Part of ↑** banner (child) or a **Subprojects** fold (parent) — collapsed by default, one row per child once opened; the open/closed state is remembered per parent. See [Parent / subprojects](../reference/readme-format.md#parent-subprojects).

## Change an item's status

Three ways, all equivalent:

1. **Drag the card** to another section.
2. **`Ctrl`/`Cmd`+`1`…`5`** with the card focused — the shortcut row for `now`, `review`, `later`, `backlog`, `done`.
3. Click the **status pill** in the item modal's header and pick a value.

All three rewrite the README's `status:` line in place — `status:` for YAML-frontmatter READMEs, `**Status**:` for the legacy bold-prose form. That one-line edit is the whole mutation: the card lands in its new section because the parser re-reads the file, not because condash keeps a record elsewhere. Every write condash is capable of is enumerated in [Mutation model](../reference/mutations.md).

## Star the items that matter { #star }

Each card carries a **star** at the head of its first row. Click it to pin that item to the **top of its status section**; click again to unpin. The star is the section's first sort key, so a starred item leads regardless of its date, and the usual order (newest first, or most-recently-closed first in `done`) decides the rest. It applies in every section, including the `done` band and each of its month subgroups.

Starring is **local and uncommitted**, and that is the point of it:

- The state lives in the conception-scoped `starredProjects` key in `.condash/settings.json` ([config reference](../reference/config.md#starredprojects)) — **not** in the item README. Nothing about your tree changes when you star something, so [auto-commit](auto-commit.md) has nothing to commit and your project history stays free of attention-management noise.
- The flip side: the starred set is per-machine. It does not travel with the tree, and a teammate opening the same conception sees their own stars.

Read the list from a shell with `condash config get starredProjects`. There is no CLI verb to set it — the card star is the way in.

## Create an item

Three entry points open the same **New project** modal:

- the **+ New project ▾** button riding the `NOW` section header,
- the **+ New** button in the pane header,
- **File → New project…** (`Ctrl+N`).

The modal asks for four things, in this order:

| Field | What to enter |
|---|---|
| **Title** | Anything. |
| **Slug** | Auto-derived from the Title and shown as a preview — click **edit** to override. |
| **Kind** | `project`, `incident`, or `document`. |
| **Status** | `now`, `review`, `later`, or `backlog`. (`done` is deliberately not offered here — you close an item, you don't create it closed.) |

Picking **Kind = incident** reveals three more fields: **Environment**, **Severity**, and **Severity impact**. There is **no Apps field** — apps, branch, and base are things you add later, by editing the README or from the item's popup.

condash writes `projects/<YYYY-MM>/<YYYY-MM-DD>-<slug>/README.md` from the canonical template and creates an empty `notes/` beside it. The CLI can do the same from a shell — `condash projects create --kind project --slug <slug> --title "<title>" --apps <app>` (the CLI is stricter: `--kind`, `--slug`, and `--title` are required (`--apps` optional, defaulting to empty), and `--status` rejects `done`). See [CLI → projects](../reference/cli.md#projects).

## Close and reopen

Closing is a **status flip, not a move** — a `done` item stays in its `YYYY-MM/` folder forever; nothing is archived or renamed. Two ways to close:

- the status pill in the modal, picking `done`, or
- from a shell: `condash projects close <slug>` — which appends a dated `Closed.` timeline entry (annotated with `--summary "<text>"` if you give one).

A closed item that needs work again moves back with `condash projects reopen <slug>` (or the status pill), which appends a `Reopened.` entry. `status set`, `close`, and `reopen` share the timeline-append behaviour — see [CLI → projects](../reference/cli.md#projects).

## See also

- **[Status, steps, deliverables](../reference/conception-convention.md)** — what each status means, the step markers, the timeline.
- **[Mutation model](../reference/mutations.md)** — every write condash can perform on your tree, short page.
- **[Work in a branch-isolated worktree](../tutorials/worktrees.md)** — where an item's `branch:` field becomes a real checkout.
