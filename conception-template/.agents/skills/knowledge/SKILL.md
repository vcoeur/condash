---
name: knowledge
description: "Manage the conception knowledge/ tree — durable reference material for this workspace. Actions: retrieve (search + triage walk), update (add/edit a body file with citation + stamp rules), index (regenerate every knowledge/**/index.md), verify (audit stale verification stamps + tree audits). Every mechanical step shells out to `condash`. Invoke as /knowledge <action>."
---

# /knowledge — conception `knowledge/` tree

Durable reference material lives at `<conception>/knowledge/`. Each directory has its own `index.md` describing what goes there and listing its immediate children. The tree is self-describing: walk root → subdir index → body file.

The skill is editorial only. **Every mechanical step shells out to `condash`.** This guarantees one parser owns every read and write of the tree.

## Command surface

```
/knowledge <action> [args]
```

| Action      | Trigger                              | Details file               |
|-------------|--------------------------------------|----------------------------|
| `retrieve`  | `/knowledge retrieve <query>`        | [retrieve.md](retrieve.md) |
| `update`    | `/knowledge update [path]`           | [update.md](update.md)     |
| `index`     | `/knowledge index`                   | [index.md](index.md)       |
| `verify`    | `/knowledge verify`                  | [verify.md](verify.md)     |

For a one-off lookup or a small edit to a file you already know, use `Read` and `Edit` directly. The `condash knowledge stamp` verb (described under "Verification stamps" below) is also callable on its own when refreshing a single fact's `**Verified:**` line.

## Core rules

These are the contract every `/knowledge` action enforces:

- **One topic per file.** If a body file grows past one subject, split it.
- **Cite sources.** `([source](url): "quoted text")` for web; `` (`path/to/file:line`: `relevant snippet`) `` for local code.
- **Verification stamps.** Stamp any fact whose truth depends on an observable source. Single format:

  ```markdown
  **Verified:** YYYY-MM-DD <where>
  ```

  `<where>` is one of `<app>@<shortsha>` (optionally `on <branch>`), `<conception-path>`, or `<name>: <url>`. For external state without a SHA, append `HH:MM UTC` when intra-day drift matters. The CLI writes this idempotently — `condash knowledge stamp <path> --where <where>` replaces an existing stamp or inserts a new one.

- **Cross-link.** Body files link to the `projects/` items that produced them; items link back via `## Notes`.
- **Don't duplicate app internals.** Single-app details belong in that app's own `CLAUDE.md`. `knowledge/internal/<app>.md` carries conception-side knowledge only.
- **Don't create pointer-only stubs.** If there's no conception-side knowledge for an app, the `internal/index.md` row is the body.
- **Prefer narrow-scope slugs over subject-area slugs.** `ci-action-pinning.md` beats `github-actions.md`.
- **Bucket-picking rubric:** durable team rule → **not here** (goes in the project's `CLAUDE.md` Specific section); single app → `internal/<app>.md` (or index row); ecosystem-spanning → `topics/<subcategory>/<slug>.md`; third-party → `external/<system>.md`.
- **Durable only.** Project-specific plans, incident reports, and in-flight work live under `projects/`, never here.
- **No workflow rules.** `knowledge/` is reference material — facts you look up. Workflow rules, team conventions, and pre-skill behaviour go in the project's `CLAUDE.md`. The bucket-picking rubric, read flow, and edit flow are documented here in `SKILL.md`, not duplicated into `knowledge/index.md`.

## When to create vs. extend

- **Durable team rule** → not here. Lives in the project's `CLAUDE.md` Specific section (auto-loaded).
- **New third-party service** → `external/<system>.md`.
- **New shared self-hosted service** → `internal/<service>.md`.
- **New cross-cutting topic** → `topics/<subcategory>/<slug>.md`.
- **New app** → add a row to `internal/index.md`. Create `internal/<app>.md` only when the first non-pointer fact surfaces.
- **Single-app detail** → that app's own `CLAUDE.md`, not here.

## Promotion check (signalled by `projects`)

`condash projects check-knowledge <slug>` and `condash audit --include knowledge-check` only **signal** that a done project may still hold un-promoted findings — they are read-only and never write the marker. Resolving the signal is this skill's job: run `condash projects scan-promotions <slug>`, walk each candidate through the three-question durability test, and **create the actual knowledge** with `/knowledge update` (stamping the origin paragraph `**Transferred:** YYYY-MM-DD → <path>`). Only once the real promotion is done — or every candidate is genuinely dropped — does the project record `- YYYY-MM-DD — Checked knowledge promotion` as its last timeline entry. The marker attests that this work happened; never append it as a substitute for doing it.

## Index tree contract

Every `knowledge/**/index.md` lists every immediate `.md` file (except itself) and every immediate subdirectory. Entry shape: link, italic one-line description, backticked keyword tag list. Hand-written sections (intro, group headings, root rules) are preserved verbatim. Curated descriptions and tag sets survive across `/knowledge index` runs.

`/knowledge index` runs `condash knowledge index` — see [index.md](index.md).

## Stamp refresh

`**Verified:**` stamps older than one month are suspect. `/knowledge verify` produces a punch-list; the user re-reads the current state of the referenced app and decides to refresh or remove each stale claim. The skill never auto-bumps — that would lie about freshness.

$ARGUMENTS
