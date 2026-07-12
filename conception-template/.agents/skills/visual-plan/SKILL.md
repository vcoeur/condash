---
name: visual-plan
description: >-
  Turn an implementation plan into a structured visual plan document — a
  plan.mdx of typed blocks (diagrams, wireframes, data models, API endpoints,
  annotated code, open questions) inside the project item's notes/, validated
  with `condash plans check` and rendered by the condash in-app viewer. Fully
  local; the plan is the approval gate before code.
---

# /visual-plan — structured plan documents

A visual plan is the plan you would normally write in Markdown, rebuilt as a
scannable document of typed blocks: prose where prose explains, and structured
blocks — wireframes, diagrams, data models, API contracts, annotated code,
file maps, open questions — where structure reads faster. It lives as a
`plan.mdx` note inside the project item, renders in condash's plan viewer, and
is validated by `condash plans check` against the exact schemas the viewer
renders. Everything is local files in the conception tree — there is no
hosted service, no publish step, and no MCP connector.

## When to use

Create a visual plan when the plan is better as a reviewable artifact than a
chat paragraph: multi-file, ambiguous, risky, architecture-heavy, data-heavy,
or UI-heavy work; a decision that needs alignment before code; an existing
text plan that needs a richer review surface. Skip it for trivial, unambiguous
work — a typo, a one-line fix, anything whose diff you could describe in one
sentence. Never pad a plan with filler and never ship a single-step plan.

## Where the plan lives

1. The plan belongs to a project item. If none exists, create one first
   (`/projects create`).
2. Author the document at `notes/NN-<slug>/plan.mdx` inside the item — `NN`
   is the next free note number, exactly like any other note. The folder
   leaves room for future sibling files; today `plan.mdx` is the document.
3. Index it in the README's `## Notes` (`- [NN — <label>](notes/NN-<slug>/plan.mdx)`),
   reference it from the step line as `— see note NN`, and add a
   `## Deliverables` entry when the plan is a designated output — the
   Deliverables pane then opens it in the plan viewer.
4. Append a dated `## Timeline` entry when the plan is ready for review.

Frontmatter is YAML:

```yaml
---
title: <Plan title>
kind: plan
---
```

## Authoring workflow

1. **Research before you draft.** Read the real files, actions, schema, and
   patterns first; name actual files, symbols, and data shapes instead of
   inventing them. Lead with reuse: for each step, name what it reuses before
   what it adds, so the plan explains the genuinely new delta.
2. **Decide the hard-to-reverse bets first.** For non-trivial backend, data,
   or API work, call out the decisions that are expensive to undo — wire
   format, public ids, data-model shape, auth and ownership boundaries — and
   get those right in the plan even if most of the feature ships later. Scope
   to the smallest first cut that proves the approach, stating what is in and
   what is explicitly deferred.
3. **Read `references/blocks.md`** (or run `condash plans blocks`) before
   authoring any structured block — never author tags from memory. Read
   `references/document-quality.md` for the document bar and
   `references/wireframe.md` before ANY wireframe. For `diff` / `annotated-code`
   (and the code nested in a `tabs` block), paste the real file text and encode
   multi-line code as JSON strings — do not retype code from memory.
4. **Write the document.** Ordinary markdown between blocks imports as prose;
   put each structured block where the prose discusses it. UI plans lead with
   the wireframe story near the top (entry surface → changed interaction →
   resulting state); architecture plans lead with a concrete example, then
   diagrams beside the claims they support.
5. **Validate:** `condash plans check <item>/notes/NN-<slug>` must be green —
   it validates the same schemas the viewer renders, so a green check means the
   document parses and matches the viewer. It does not prove each block has
   visible content — `plans check` warns on an empty diagram / code / wireframe
   — so fix errors, take warnings seriously, and open the plan in the viewer
   once before hand-off.
6. **Hand off.** Update the README (Notes index, step reference, timeline,
   Deliverables when designated) and tell the user where the plan is —
   opening the note in condash shows the rendered document. The plan is the
   approval gate: ask for review and name which files/areas the work touches;
   do not start editing code before the direction is approved.
7. **Revise in place.** When scope shifts, update the plan.mdx so the
   document stays the source of truth — never let the real plan live only in
   chat. A revised plan still reads standalone: no "unlike the previous
   version", no revision language.

## Plan discipline

- **Standalone documents.** A reader who never saw the chat must understand
  the plan: objective and done-criteria, scope and non-goals, the approach
  with key decisions and rationale, ordered steps naming real files and
  symbols, risks, and a verification section that exercises the real
  workflow.
- **Clarify vs. assume.** Ask a clarifying question only when an ambiguity
  would change the design and the code cannot resolve it; batch 2–4
  high-leverage questions before finalizing. Otherwise state the assumption
  in the plan and proceed. Every remaining open decision goes in ONE bottom
  `question-form` block under an `### Open Questions` heading, each with a
  recommended default — never a second copy of the questions elsewhere.
- **Planning is read-only.** No source edits while building or reviewing the
  plan.
- **Self-review before handoff** (architecture / data / multi-file / risky
  plans): one adversarial pass over the written document — hard-to-reverse
  decisions made implicitly, steps not anchored in real files, a menu of
  options where the plan should commit, padding. Apply clear-cut fixes;
  route genuine judgment calls to the Open Questions form.

## Visual surface choice

- **Non-visual plans** (architecture-only, backend-only, migrations, copy):
  no wireframes. A strong document with local inline `diagram` /
  `data-model` / `api-endpoint` blocks next to the claims they support.
  Prefer two-dimensional layouts (before/after panels, layers, swimlanes,
  matrices) over left-to-right chains.
- **UI/product plans**: wireframe blocks ARE the review surface — put the
  primary screens near the top, one `wireframe` block per meaningful state,
  with `columns` for Before/After pairs. Show the entry point, the opened
  surface, and the resulting state; add role/empty/error states when the
  work changes them.
- Canvas boards and interactive prototypes (`canvas.mdx` / `prototype.mdx`)
  are NOT supported by the condash viewer — express the flow as an ordered
  sequence of wireframe blocks with short prose transitions instead.

## Reference files

| File | Read before |
|---|---|
| `references/blocks.md` | authoring any structured block (the vocabulary; regenerate with `condash plans blocks`) |
| `references/wireframe.md` | authoring ANY wireframe / `<Screen>` — the quality bar |
| `references/document-quality.md` | writing the plan document — block choice, open questions, altitude |
| `references/exemplar.md` | a worked good/bad example of the bar |

Related: `/visual-recap` builds the same document backwards from a landed
diff. Adapted from Builder.io's visual-plan skill (MIT).
