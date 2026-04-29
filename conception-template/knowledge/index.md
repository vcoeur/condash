# Knowledge

Permanent reference material for this workspace. Stable facts, conventions, cross-cutting topics — not time-bound project work.

## Bucket-picking rubric

Before writing a new entry, decide which tree the content belongs to. Before reading, use the same rubric to pick where to look first.

- *Is it an intent / rule about how we work?* → [`conventions.md`](conventions.md).
- *Is it a fact about one of our apps?* → [`internal/<app>.md`](internal/index.md) (or the app's own `CLAUDE.md` when the fact is app-internal plumbing).
- *Is it a fact that spans apps or the ecosystem?* → [`topics/<subcategory>/<slug>.md`](topics/index.md).
- *Is it about a third-party service we call?* → [`external/<system>.md`](external/index.md).

## Root body files

`conventions.md` is the only body file permitted at the tree root; everything else lives under a subdir.

- [`conventions.md`](conventions.md) — *durable team rules surfaced from sessions: claim + **Why** + **How to apply**; stable by design (no stamps).* `[conventions, team-rules]`

## Structure

Each subdirectory has its own `index.md` describing what goes there and listing its current files. Read the relevant sub-index before the body file; read the body file before acting on it.

- [`internal/`](internal/index.md) — *our own systems: one file per app that has non-trivial conception-side knowledge, plus any shared self-hosted infrastructure.* `[apps, internal-apps, shared-infra]`
- [`external/`](external/index.md) — *third-party services we call: SaaS APIs, cloud providers, payment gateways, analytics platforms. One file per system.* `[third-party, saas, external-apis]`
- [`topics/`](topics/index.md) — *cross-cutting subjects that span multiple apps or the ecosystem. Group on disk by whatever subcategories make sense for this workspace (`ops/`, `security/`, `testing/`, …). One file per topic.* `[cross-cutting, topics]`

## Read rules

Consult `knowledge/` whenever the user's request touches something that could be covered here. Default path:

1. Start at this file to pick the right subdirectory using the rubric above.
2. Read the subdirectory's `index.md` to pick the right body file (or to learn that no file covers the topic yet).
3. Read the body file. Do not act on index one-liners alone — they are pointers, not the source of truth.

Use indexes as a fast filter. Each entry in every `index.md` carries three parts — link, italic one-line description, and a `[keyword-1, keyword-2, …]` tag list. Most lookups should resolve at the index level: read all relevant `index.md` files top-to-bottom, match the user's query against descriptions and keyword tags, and open a body file only when an entry matches.

A `PreToolUse` hook (`.claude/hooks/knowledge-retrieve-reminder.sh`) fires on every `Edit` / `Write` whose target path matches a correctness-critical glob and injects a reminder to read the matching knowledge file. Extend the trigger table when a new critical surface emerges. The hook is a safety net, not a substitute for proactive reading.

## Edit rules

Durable knowledge only. Project-specific plans, incident reports, and in-flight work live under `projects/`, never here.

When you write or modify a file under `knowledge/`:

- **One topic per file.** If a file grows past one subject, split it.
- **Don't create pointer-only per-app stubs.** If there is no conception-side knowledge to record for an app, the `internal/index.md` row *is* the body. Create a body file only when the first non-pointer fact surfaces.
- **Prefer narrow-scope slugs over subject-area slugs.**
- **Cite sources.** `([source](url): "quoted text")` for web, `` (`path/to/file:line`: `relevant snippet`) `` for local code.
- **Verification stamps.** Stamp any fact whose truth depends on an observable source — see [`SKILL.md`](.claude/skills/knowledge/SKILL.md) for the format.
- **Cross-link.** Link body files to the items under `projects/` that produced them, and vice versa.

After any add, rename, delete, or substantial rewrite of a knowledge file, run `/knowledge index` to refresh the affected `index.md` files.
