# AGENTS.md — conception-demo

> **Demo fixture.** These are instructions for the imaginary *helio* project the
> screenshot fixture describes — not for the condash repository that ships it.

## Layout

- `projects/YYYY-MM/YYYY-MM-DD-slug/README.md` — one item per directory, dated.
- `knowledge/` — durable reference material for helio and helio-web.
- `resources/` — the conception-global file browser: runbooks and notes.
- `tasks/<slug>/{task.json,prompt.md}` — reusable agent prompts.

## Conventions

- Item READMEs stay thin: Goal, Scope, Steps, Timeline, Deliverables, Notes.
  Long-form findings go in `notes/NN-<slug>.md` (or `.mdx` for a visual note).
- Statuses are `now`, `review`, `later`, `backlog`, `done` — nothing else.
  `review` means "done on our side, waiting for an external signal".
- Cross-link items with `[[slug]]`; never paste a filesystem path.
- Every code change updates the repo's own docs in the same commit.
