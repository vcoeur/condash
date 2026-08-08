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

## Change an item's status

Three ways, all equivalent:

1. **Drag the card** to another section.
2. **`Ctrl`/`Cmd`+`1`…`5`** with the card focused — the shortcut row for `now`, `review`, `later`, `backlog`, `done`.
3. Click the **status pill** in the item modal's header and pick a value.

All three rewrite the README's `status:` line in place — `status:` for YAML-frontmatter READMEs, `**Status**:` for the legacy bold-prose form. That one-line edit is the whole mutation: the card lands in its new section because the parser re-reads the file, not because condash keeps a record elsewhere. Every write condash is capable of is enumerated in [Mutation model](../reference/mutations.md).

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
