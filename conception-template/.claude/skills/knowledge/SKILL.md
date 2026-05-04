---
allowed-tools: Read, Write, Edit, Glob, Grep, AskUserQuestion, Bash(condash *), Bash(git -C * rev-parse *), Bash(git -C * status*)
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
- **Bucket-picking rubric:** intent/rule → `conventions.md`; single app → `internal/<app>.md` (or index row); ecosystem-spanning → `topics/<subcategory>/<slug>.md`; third-party → `external/<system>.md`.
- **Durable only.** Project-specific plans, incident reports, and in-flight work live under `projects/`, never here.

## When to create vs. extend

- **Durable team rule** → `knowledge/conventions.md` (root-level exception). Structure: claim (H3) + **Why** + **How to apply**. No stamp.
- **New third-party service** → `external/<system>.md`.
- **New shared self-hosted service** → `internal/<service>.md`.
- **New cross-cutting topic** → `topics/<subcategory>/<slug>.md`.
- **New app** → add a row to `internal/index.md`. Create `internal/<app>.md` only when the first non-pointer fact surfaces.
- **Single-app detail** → that app's own `CLAUDE.md`, not here.

## Index tree contract

Every `knowledge/**/index.md` lists every immediate `.md` file (except itself) and every immediate subdirectory. Entry shape: link, italic one-line description, backticked keyword tag list. Hand-written sections (intro, group headings, root rules) are preserved verbatim. Curated descriptions and tag sets survive across `/knowledge index` runs.

`/knowledge index` runs `condash knowledge index` — see [index.md](index.md).

## Stamp refresh

`**Verified:**` stamps older than one month are suspect. `/knowledge verify` produces a punch-list; the user re-reads the current state of the referenced app and decides to refresh or remove each stale claim. The skill never auto-bumps — that would lie about freshness.

$ARGUMENTS
