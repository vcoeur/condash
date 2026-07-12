# Document quality — single source of truth

The canonical quality bar for the visual note, whatever its posture
(design / plan / review / note). Read it in full before authoring; do not write
the document from memory.

**The document is serious technical writing, not marketing.** Write a `plan` or
`design` the way a strong implementation plan reads, a `review` the way a strong
change summary reads: outcome-first, prose-first, self-contained, specific.
State the objective and what "done" means, the scope and non-goals, the approach
with key decisions and their rationale, ordered steps that name real files,
symbols, actions, and data shapes, the risks, and a closing verification step.
Replace vague prose with specifics; never ship a step like "make it work". No
hero art, slogans, value props, or marketing cards.

**Every document must stand alone.** Even when revising, the output is the note
itself, not a changelog of the conversation. No "preserve the previous plan",
"as discussed above", "this revision", "unlike the prior version". A reader who
opens the note with no chat history should understand it. State the positive
model directly instead of negative framing against absent context.

**Make abstract notes instantly legible.** If the idea is broad or strategic,
put one concrete product snapshot near the top — for UI-capable concepts a
wireframe of the real app state plus a short paragraph — before dense
architecture, mode tables, or roadmaps.

**Preserve the user's level of abstraction.** A motivating use case is not
automatically the architecture. Separate the reusable core from
app-specific adapters and examples; label examples as examples unless they
are the whole requested scope.

**Use the right block, and make it carry substance.** The authoritative
vocabulary is `blocks.md` (`condash mdx blocks`); highlights:

- Prose for the plan narrative — ordinary markdown between blocks.
- `annotated-code` for the file map: when a load-bearing file is worth
  highlighting, carry the real code AND anchor short margin notes to the
  lines that actually change. A few high-signal notes per file, never one
  per line; only files worth reading, never an exhaustive list. Drop to a
  plain `code` block only for a throwaway snippet. Group several files in a
  vertical `tabs` block. If the exact code is unknown, show the smallest
  plausible planned shape or a commented stub.
- For a decision: a genuinely open either/or goes in the bottom Open
  Questions `question-form` as a `single` question with `recommended: true`
  on your pick. An already-committed approach is settled prose or a
  `callout` with `tone="decision"`, optionally beside a `columns` comparison
  of the options weighed — never a mid-document form for a question you
  already answered.
- `columns` for side-by-side before/after or current/target comparisons
  where each side carries real nested blocks; label the columns.
- `diagram` for two-dimensional architecture/data-flow relationships, only
  when it clarifies something real: paired panels, layers, swimlanes,
  matrices, grouped regions — not a default left-to-right chain. Author
  `html`/`css` with the `.diagram-*` primitives (`.diagram-panel`,
  `.diagram-node`, `.diagram-pill`, …) and `--wf-*` tokens; never
  `font-family` or hex/rgb/hsl literals. Keep labels short; labels must not
  overlap nodes or each other.
- `tabs` for multiple states or comparisons. A tab that reveals only prose
  usually means the plan is under-specified.
- `table`, `checklist`, `callout` for scannable structure.
- `custom-html` is a bounded escape hatch — never the primary home for a
  mockup or comparison, and it must read correctly in both themes via the
  `--wf-*` tokens.

**Open questions live at the bottom as ONE form.** A final `question-form`
block under an `### Open Questions` heading is the only place that
enumerates them; a one-line pointer in the overview is fine, a second list
is not. `single`/`multi` for clear choices, `freeform` for constraints,
`recommended: true` for your default. Non-answerable assumptions stay as
concise `callout`s in the relevant section. For complex plans, do a final
open-question audit: every meaningful decision is either committed with
rationale or in the form with a recommended default.

**Verification must exercise the real workflow.** Beyond typecheck/tests when
the plan changes UI, files, or multi-app flows: at least one end-to-end smoke
matching the user journey, naming the command or manual path when known.

**Before handoff, open the plan in condash and check it.** `condash mdx
check` must be green, and the rendered document must read cleanly: no
overlap, no clipped fragments, wireframes correct in the current theme (dark
especially — hard-coded light colors are defects; use `--wf-*` tokens).
