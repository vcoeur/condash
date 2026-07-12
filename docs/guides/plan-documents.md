---
description: Plan and recap MDX documents — the visual-plan / visual-recap skills, the plan.mdx block dialect, the in-app viewer, and condash plans check.
---

# Plan documents (visual plans & recaps)

**When to read this.** You want an implementation plan or a change recap that
reads better than a wall of prose — wireframes, diagrams, data models, API
contracts, annotated diffs — reviewable inside condash, living as a plain
file in the project item.

A **plan document** is a `plan.mdx` file in a project item's notes
(`notes/NN-<slug>/plan.mdx`). It is MDX used as *data*, never as code:
ordinary Markdown prose interleaved with typed blocks — capitalized tags
whose props are static JSON literals. condash renders it in the in-app plan
viewer and validates it with `condash plans check`. Everything is local
files; there is no hosted service.

Two condash-shipped skills author them:

- **`/visual-plan`** — a forward plan: the approval gate before code.
- **`/visual-recap`** — the same dialect driven backwards from a worktree's
  diff, so a reviewer scans the shape of a change before the raw diff.

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

- Frontmatter carries `title` and `kind: plan | recap`.
- Prose between blocks is normal Markdown (wikilinks, mermaid fences, and
  relative images all work exactly as in `.md` notes).
- Block props are **static literals only** — no imports, no expressions, no
  `${…}` interpolation. That is what lets condash render agent-authored
  files with no code execution.
- The full vocabulary (~20 block types) comes from `condash plans blocks`
  or the skills' `references/blocks.md` — one generated document, drift-
  tested against the registry the parser and viewer share.

## Viewing

Any `.mdx` file opens in the plan viewer — from a Deliverables entry, the
Resources pane, or an `.mdx` link inside a note. The viewer renders each
block natively (split diffs, collapsible endpoints, JSON explorers, themed
wireframes), shows parse/validation issues in a banner, renders an invalid
block as a labeled placeholder instead of blanking the document, and carries
a **Rendered / Source** toggle. Wireframe and diagram HTML is sanitized and
themed through `--wf-*` tokens, so screens read correctly in light and dark.

Canvas boards and prototypes (`canvas.mdx` / `prototype.mdx`) are not
supported — flows are expressed as ordered wireframe blocks in the document.

## Validating

```bash
condash plans check <item>/notes/03-auth-plan     # folder holding plan.mdx
condash plans check path/to/file.mdx              # or a file directly
```

The check runs the **same parser and schemas the viewer renders**, so a green
check means the document parses and matches the viewer — there is no separate
lint to drift. It does not prove every block has visible content: `check`
warns when a block would render blank (an unfolded diagram, an empty `code` or
`diff`, a wireframe with no html), so read the warnings and open the document
in the viewer once before hand-off. Errors exit 3 with line numbers; a missing
`kind` warns.

## Where documents live

| Piece | Convention |
|---|---|
| File | `projects/…/<item>/notes/NN-<slug>/plan.mdx` |
| README | indexed in `## Notes`; step lines say `— see note NN` |
| Card | add a `## Deliverables` entry when the document is a designated output |
| Kind | `plan` (forward) or `recap` (from a diff) in frontmatter |

The recap unit is the project item's **worktree branch** — potentially
several app repos under `<worktrees_path>/<branch>/` — diffed against each
repo's base; multi-repo recaps group blocks per `#handle`.
