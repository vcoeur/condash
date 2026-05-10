# Why Markdown-first

condash exists because no off-the-shelf project tracker gives you all
three of these at once:

1. **The files are yours** — editable in the editor you use, diffable
   in git, grep-able from a shell.
2. **The dashboard is a view, not a second database** — close it and
   the files don't move; delete it and the files don't move.
3. **Writing is cheap** — no form, no required fields, no migration.
   You type Markdown.

## A README looks like this

````markdown
---
date: 2026-04-10
kind: project
status: now
apps:
  - notes.vcoeur.com
branch: feat/session-cookie-auth
---

# Migrate auth to session-cookie hybrid

## Goal

Drop the JWT dependency without breaking existing sessions.

## Steps

- [x] Audit session-cookie usage
- [~] Implement hybrid read path
- [ ] Migration script for existing tokens
````

Legacy bold-prose headers are still accepted.

Every piece earns its keep:

- The YAML frontmatter parses straight into the metadata block.
- `## Steps` checkboxes work in any Markdown tool.
- `git diff` shows exactly what changed when you flip a step.
- `rg "session cookie"` finds it in 30 ms.

## What you give up

- No multi-user collaboration. Git handles conflicts like any other
  text file.
- No web sharing — generate a PDF or publish a static site.
- No time tracking, invoicing, or dependency graphs. Use a real PM
  product if you need those.
- Mobile reading is fine via git/Markdown viewers; the dashboard
  itself is desktop-only.

## When this fits

- Solo developer juggling several apps and wanting one tracker.
- Engineering logbook — dated READMEs that outlive sprints and
  employers.
- A workspace shared with an AI agent that already speaks files
  (Claude Code, etc.).
- Post-mortem tracker for incidents with timelines and links.

## More

The full pitch — three scenarios in detail, the design tradeoffs, the
non-goals — lives at **https://condash.vcoeur.com/explanation/why-markdown/**.
