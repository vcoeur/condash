---
title: Visual notes (plans, reviews, designs) · condash guide
description: Visual-note MDX documents — the /visual skill, the four postures, the .mdx block dialect, the in-app viewer, and condash mdx check.
---

# Visual notes (plans, reviews, designs)

**When to read this.** You want a document that reads better than a wall of
prose — wireframes, diagrams, data models, API contracts, annotated diffs —
reviewable inside condash, living as a plain file in the project item.

A **visual note** is an `.mdx` file in a project item's notes
(`notes/NN-<slug>.mdx`). It is MDX used as *data*, never as code: ordinary
Markdown prose interleaved with typed blocks — capitalized tags whose props are
static JSON literals. condash renders it in the in-app viewer and validates it
with `condash mdx check`. Everything is local files; there is no hosted service.

The condash-shipped **`/visual`** skill authors them all. One skill, one
dialect; a frontmatter `kind` picks the posture and what the bottom
question-form asks:

- **`design`** — approaches still being weighed; the form asks *directions*.
- **`plan`** — the reviewable approval gate before code; the form asks *approval*.
- **`review`** — the same dialect driven backwards from a worktree's diff, so a
  reviewer scans the shape of a change before the raw diff; the form asks *feedback*.
- **`note`** — the default when `kind` is omitted: a layout of blocks where prose
  would be worse, with nothing to decide.

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

<Diff id="d1" filename="src/auth.ts" language="ts" mode="split"
  before={"const ttl = 3600;\n"} after={"const ttl = 900;\n"} />
```

- Frontmatter carries `title` and an optional `kind`
  (`design` / `plan` / `review` / `note`, default `note`).
- Prose between blocks is normal Markdown (wikilinks, mermaid fences, and
  relative images all work exactly as in `.md` notes).
- Block props are **static literals only** — no imports, no expressions, no
  `${…}` interpolation. That is what lets condash render agent-authored
  files with no code execution.
- The full vocabulary (~20 block types) comes from `condash mdx blocks`
  or the `/visual` skill's `blocks.md` — one generated document, drift-
  tested against the registry the parser and viewer share.

## Viewing

Any `.mdx` file opens in the viewer — from a Deliverables entry, the
Resources pane, or an `.mdx` link inside a note. The viewer renders each
block natively (split diffs, collapsible endpoints, JSON explorers, themed
wireframes), shows parse/validation issues in a banner, renders an invalid
block as a labeled placeholder instead of blanking the document, and carries
a **Rendered / Source** toggle. Wireframe and diagram HTML is sanitized and
themed through `--wf-*` tokens, so screens read correctly in light and dark.

Question-forms are answered in place, and the **document** saves as a whole:
answer as many forms as you like, then save once with the head Save button or
**Ctrl+S** — every pending answer is written back into the `.mdx` in a single
pass. A dot next to the button marks unsaved answers, and closing the viewer
with answers still pending offers Save / Discard / Cancel rather than dropping
them.

![MDX viewer — a plan document with its PLAN pill, a table, a split diff with line annotations, a decision callout, and the approval question-form](../assets/screenshots/plan-document-light.png#only-light)
![MDX viewer — a plan document with its PLAN pill, a table, a split diff with line annotations, a decision callout, and the approval question-form](../assets/screenshots/plan-document-dark.png#only-dark)

Canvas boards and prototypes (`canvas.mdx` / `prototype.mdx`) are not
supported — flows are expressed as ordered wireframe blocks in the document.

## Validating

```bash
condash mdx check <item>/notes/03-auth-plan     # folder holding plan.mdx
condash mdx check path/to/file.mdx              # or a file directly
```

The check runs the **same parser and schemas the viewer renders**, so a green
check means the document parses and matches the viewer — there is no separate
lint to drift. It does not prove every block has visible content: `check`
warns when a block would render blank (an unfolded diagram, an empty `code` or
`diff`, a wireframe with no html), so read the warnings and open the document
in the viewer once before hand-off. Errors exit 3 with line numbers; `kind` is
optional and never warns.

## Where documents live

| Piece | Convention |
|---|---|
| File | `projects/…/<item>/notes/NN-<slug>.mdx` (supporting files in `notes/NN-<slug>/`) |
| README | indexed in `## Notes`; step lines say `— see note NN` |
| Card | add a `## Deliverables` entry when the document is a designated output |
| Kind | `design` / `plan` / `review` / `note` in frontmatter (optional; default `note`) |

The review unit is the project item's **worktree branch** — potentially
several app repos under `<worktrees_path>/<branch>/` — diffed against each
repo's base; multi-repo reviews group blocks per `#handle`.
