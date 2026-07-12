---
name: visual
description: >-
  Author and review "visual notes" — MDX documents of typed blocks (wireframes,
  diagrams, data models, API contracts, annotated diffs, open questions) that
  render in the condash in-app viewer and validate with `condash mdx check`.
  The umbrella over /visual-plan (a forward plan) and /visual-review (a review
  built from a diff); it owns the shared block vocabulary, the wireframe and
  document-quality bars, and the `condash mdx` CLI. Use when asked for a visual
  note, a visual plan, or a visual review. Fully local; no hosted service.
---

# /visual — visual notes (MDX documents)

A **visual note** is Markdown prose interleaved with typed blocks — capitalized
JSX-like tags whose props are static JSON literals (`<Diff>`, `<DataModel>`,
`<WireframeBlock>`, `<QuestionForm>`, …). condash renders it natively in the
in-app viewer and validates it with `condash mdx check` against the exact
schemas the viewer draws, so a green check is renderability. Everything is a
local `.mdx` file in a project item's `notes/`; there is no hosted service, no
publish step, no MCP connector. MDX is parsed as DATA, never compiled — no
imports, no expressions, no `${…}`.

## Two flows — pick by direction

| You want | Skill | Frontmatter |
|---|---|---|
| A plan **before** code — the reviewable approval gate | **`/visual-plan`** | `kind: plan` |
| A review **from** a landed diff — scan the shape before the raw diff | **`/visual-review`** | `kind: review` |

Both author the same dialect into `notes/NN-<slug>.mdx`; they differ only in
direction and emphasis. Reach for `/visual-plan` when the work is ahead of you,
`/visual-review` when it already exists on a branch. When the ask is just "make
a visual note" with no direction, default to `/visual-plan` for upcoming work
and `/visual-review` for a finished branch.

## The dialect in 30 seconds

```mdx
---
title: Add session refresh
kind: plan
---

## Goal

Refresh tokens without re-login.

<DataModel id="sessions" entities={[{ id: "sessions", name: "sessions", fields: [
  { name: "id", type: "uuid", pk: true },
  { name: "refresh_at", type: "timestamptz", change: "added" },
] }]} />
```

- Frontmatter carries `title` and `kind: plan | review`.
- Prose between blocks is ordinary Markdown.
- Block props are **static literals only** — that is what lets condash render
  agent-authored files with no code execution.

## Shared references — read before authoring

These are the single source of truth for both flows. Read the relevant one
before authoring; never author blocks from memory.

| File | Read before |
|---|---|
| [`blocks.md`](blocks.md) | authoring any structured block — the vocabulary (regenerate with `condash mdx blocks`) |
| [`wireframe.md`](wireframe.md) | authoring ANY wireframe / `<Screen>` — the quality bar |
| [`document-quality.md`](document-quality.md) | writing the document — block choice, open questions, altitude |
| [`exemplar.md`](exemplar.md) | a worked good/bad example of the bar |

## Validate and view

```bash
condash mdx check <path>/notes/NN-<slug>.mdx    # a file, or a folder holding plan.mdx
condash mdx blocks                              # print the block vocabulary
```

A green `check` means the document parses and matches the viewer by
construction; it still warns on a block that would render blank (an unfolded
diagram, an empty `code`, a wireframe with no html), so read the warnings and
open the note in condash once before hand-off. Any `.mdx` opens in the plan
viewer — from a Deliverables entry, the Resources pane, or an `.mdx` link in a
note.

## Open questions — answered in the viewer

A document's open decisions live in ONE bottom `question-form` block under an
`### Open Questions` heading, each with a recommended default — the single place
they are enumerated. Non-answerable assumptions stay as concise `callout`s in
the relevant section.

condash renders the form **interactively**: the reader picks options (radio for
`single`, checkboxes for `multi`) or types a `freeform` answer and clicks
**Save**. The answer is written back onto each question as an `answer` field in
the same `.mdx` — an option id, a list of option ids, or the free text — so a
question and its answer live in one file and one git diff. On the next turn,
re-read the note and act on the `answer` fields; never re-ask in chat what the
form already answered.

Adapted from Builder.io's visual-plan / visual-recap skills (MIT).
