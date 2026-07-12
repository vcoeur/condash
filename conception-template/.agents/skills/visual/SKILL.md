---
name: visual
description: >-
  Author "visual notes" — MDX documents of typed blocks (wireframes, diagrams,
  data models, API contracts, annotated diffs, open questions) that render in
  the condash in-app viewer and validate with `condash mdx check`. One skill,
  four postures set by frontmatter `kind`: a **design** exploring directions, a
  **plan** as the approval gate before code, a **review** built from a landed
  diff, or a plain **note** where a visual layout beats Markdown. Owns the block
  vocabulary, the wireframe and document-quality bars, and the `condash mdx`
  CLI. Use when asked for a visual note, visual plan, visual design, or visual
  review, or for any note better shown as blocks than prose. Fully local; no
  hosted service.
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

## Four postures — set `kind`

The document's posture is one frontmatter field, `kind`. It picks the reader's
job and what the bottom `question-form` asks — nothing else about the dialect
changes.

| `kind` | You are asking | When | The form asks |
|---|---|---|---|
| `design` | "which direction?" — options weighed, not yet chosen | before an approach is settled | directions |
| `plan` | "approve this?" — the reviewable gate before code | before code | approval |
| `review` | "does this read right?" — a landed change, above line-by-line | after code, from a diff | feedback |
| `note` | *(nothing to decide)* — a layout of blocks beats prose | any time | nothing |

`kind` is optional; **omit it for a plain `note`** (the default). Unknown values
are accepted and render as a neutral pill — no warning. The viewer colors the
four known postures in its header pill.

**Infer the posture, don't interrogate.** Upcoming work → `plan`; a finished
branch or PR → `review`; approaches still being weighed → `design`; a reference,
explainer, or data layout with no open decision → `note`. Ask which posture only
when it is genuinely ambiguous *and* the answer changes what you build.

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

- Frontmatter carries `title` and, optionally, `kind` (see the table above).
- Prose between blocks is ordinary Markdown — imports as `rich-text`.
- Block props are **static literals only** — that is what lets condash render
  agent-authored files with no code execution.

## Where the note lives

1. The note belongs to a project item. If none exists, create one first
   (`/projects create`).
2. Author it at `notes/NN-<slug>.mdx` inside the item — `NN` is the next free
   note number, exactly like any other note. Supporting files go in
   `notes/NN-<slug>/`.
3. Index it in the README's `## Notes` (`- [NN — <label>](notes/NN-<slug>.mdx)`),
   reference it from the relevant step as `— see note NN`, and add a
   `## Deliverables` entry when the note is a designated output — the
   Deliverables pane then opens it in the viewer.
4. Append a dated `## Timeline` entry when the note is ready for its reader
   (approval, feedback, or hand-off).

## Authoring workflow

1. **Ground first — never author from memory.** Read the real files, actions,
   schema, and patterns; name actual files, symbols, and data shapes. For a
   `review`, the facts come from the diff (see [`review.md`](review.md)); for a
   `plan`/`design`, lead with what each step reuses before what it adds.
2. **Decide the hard-to-reverse bets first** (`plan`/`design`, non-trivial
   backend/data/API): call out decisions expensive to undo — wire format,
   public ids, data-model shape, auth and ownership — and get them right even
   if most of the feature ships later. Scope to the smallest first cut that
   proves the approach; state what is in and what is explicitly deferred.
3. **Read the shared references** for what you are about to author (table
   below) — the block vocabulary before ANY block, the wireframe bar before ANY
   wireframe. For `diff` / `annotated-code` (and code nested in `tabs`), paste
   the real file text and encode multi-line code as JSON strings — never retype
   code from memory.
4. **Write the document.** Ordinary markdown between blocks imports as prose;
   put each structured block where the prose discusses it. UI notes lead with
   the wireframe story near the top (entry surface → changed interaction →
   resulting state); architecture notes lead with a concrete example, then
   diagrams beside the claims they support.
5. **Validate:** `condash mdx check <item>/notes/NN-<slug>.mdx` must be green —
   it validates the same schemas the viewer renders, so green means the document
   parses and matches the viewer. It does not prove each block has visible
   content — `mdx check` warns on an empty diagram / code / wireframe — so fix
   errors, take warnings seriously, and open the note in the viewer once before
   hand-off.
6. **Hand off.** Update the README (Notes index, step reference, timeline,
   Deliverables when designated) and tell the user where the note is. For a
   `plan`, this is the approval gate: name which files/areas the work touches
   and do not start editing code before the direction is approved.
7. **Revise in place.** When scope shifts, update the `.mdx` so the note stays
   the source of truth — never let it live only in chat. A revised note still
   reads standalone: no "unlike the previous version", no revision language.

**Planning is read-only.** No source edits while building a `design`, `plan`, or
`review`. **Self-review before hand-off** (architecture / data / multi-file /
risky notes): one adversarial pass over the written document — hard-to-reverse
decisions made implicitly, steps not anchored in real files, a menu of options
where the note should commit, padding. Apply clear-cut fixes; route genuine
judgment calls to the Open Questions form.

## Visual surface choice

- **Non-visual notes** (architecture-only, backend, migrations, copy): no
  wireframes. A strong document with local inline `diagram` / `data-model` /
  `api-endpoint` blocks next to the claims they support. Prefer two-dimensional
  layouts (before/after panels, layers, swimlanes, matrices) over
  left-to-right chains.
- **UI/product notes**: wireframe blocks ARE the surface — put the primary
  screens near the top, one `wireframe` block per meaningful state, `columns`
  for Before/After pairs. Show the entry point, the opened surface, and the
  resulting state; add role/empty/error states when the work changes them.
- Canvas boards and interactive prototypes are NOT supported by the viewer —
  express a flow as an ordered sequence of wireframe blocks with short prose
  transitions instead.

## Open questions — answered in the viewer

A note's open decisions live in ONE bottom `question-form` block under an
`### Open Questions` heading, each with a recommended default — the single place
they are enumerated. What they ask follows the posture: **directions** for a
`design`, **approval** for a `plan`, **feedback** for a `review`; a `note`
usually has none. Non-answerable assumptions stay as concise `callout`s in the
relevant section.

condash renders the form **interactively**: the reader picks options (radio for
`single`, checkboxes for `multi`) or types a `freeform` answer and clicks
**Save**. The answer is written back onto each question as an `answer` field in
the same `.mdx` — an option id, a list of option ids, or the free text — so a
question and its answer live in one file and one git diff. On the next turn,
re-read the note and act on the `answer` fields; never re-ask in chat what the
form already answered.

## Validate and view

```bash
condash mdx check <path>/notes/NN-<slug>.mdx    # a file, or a folder holding plan.mdx
condash mdx blocks                              # print the block vocabulary
```

A green `check` means the document parses and matches the viewer by
construction; it still warns on a block that would render blank (an unfolded
diagram, an empty `code`, a wireframe with no html), so read the warnings and
open the note in condash once before hand-off. Any `.mdx` opens in the viewer —
from a Deliverables entry, the Resources pane, or an `.mdx` link in a note.

## Shared references — read before authoring

Read the relevant one before authoring; never author blocks from memory.

| File | Read before |
|---|---|
| [`blocks.md`](blocks.md) | authoring any structured block — the vocabulary (regenerate with `condash mdx blocks`) |
| [`wireframe.md`](wireframe.md) | authoring ANY wireframe / `<Screen>` — the quality bar |
| [`document-quality.md`](document-quality.md) | writing the document — block choice, open questions, altitude |
| [`review.md`](review.md) | a `review` — worktree scope, diff → block mapping, the grounding rule |
| [`exemplar.md`](exemplar.md) | a worked good/bad example of the bar |

Adapted from Builder.io's visual-plan / visual-recap skills (MIT).
