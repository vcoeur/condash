# Good vs. bad exemplar — single source of truth

A worked example of the bar. Read it alongside `document-quality.md` before
authoring a note. The three examples below are a `plan`, a `review`, and the
anti-pattern that fails all postures.

**GOOD.** A UI-first plan for a todo app: near the top, a `desktop` wireframe
whose `html` is a real flex layout — a sidebar of links (`Inbox 12`,
`Today 4`, `Done`), a main column with `<h1>Today</h1>`, accent `.wf-pill`s
for the filters, a muted `OVERDUE` section label, and `.wf-card` task rows
carrying real titles, due dates, and one `button.primary` — styled only
through bare elements, helper classes, and `--wf-*` tokens. Below it, an
implementation-grade document: objective and done-criteria, a few
`annotated-code` blocks (grouped in a vertical `tabs` block) showing the real
shape of the load-bearing files, a `callout` with `tone="decision"` stating
the chosen approach with a `columns` block weighing the two real options
behind it, and a validation step — none of it repeating what the wireframes
already show. Flow-dependent changes appear as an ordered sequence of
wireframe states with short prose transitions. This is the bar.

**GOOD.** A backend architecture review: no wireframes at all. The document
opens with context, then repeats a section rhythm per recommendation: title,
confidence, real file paths, one local two-dimensional before/after or
layered `diagram` beside the claim it supports, and terse
Problem/Solution/Why bullets in the codebase's vocabulary. The diagram uses
space to show boundaries and ownership — not a left-to-right chain. The plan
ends with a top recommendation and a bottom `question-form` only if the next
direction is genuinely open.

**BAD.** A wireframe `html` with hard-coded hex colors, a `font-family`, or
fixed pixel frame sizes; gray placeholder bars on a non-skeleton frame; a
forced desktop + mobile pair for a popover; a fresh kit-tree screen instead
of `html`; a mockup escaped into a `custom-html` block; a marketing-style
document with a hero heading that restates what the wireframes show; an
architecture plan forced into overlapping labeled boxes while the actual
code evidence lives elsewhere; a product wireframe mixing a real screen with
repo names, file-contract arrows, or architecture notes; and a plan that
describes itself as a revision of a prior conversation instead of a
standalone proposal; a `diagram` / `code` / `wireframe` whose payload is empty
so it passes `mdx check` yet renders blank; and a code block retyped from
memory instead of copied from the real file. Never produce this.
