---
allowed-tools: Read, Write, Edit, Glob, Grep, AskUserQuestion, Bash(find ${CLAUDE_PROJECT_DIR}/knowledge*), Bash(git -C ~/src/* rev-parse *), Bash(git -C ${CLAUDE_PROJECT_DIR} status*)
description: "Manage the conception knowledge/ tree — durable reference material for this workspace. Actions: retrieve (search + triage walk), update (add/edit a body file with citation + stamp rules), index (regenerate every knowledge/**/index.md), verify (audit stale verification stamps). Invoke as /knowledge <action>."
---

# /knowledge — conception `knowledge/` tree

Durable reference material lives at:

```
<conception-root>/knowledge/
├── index.md                                          (tree root — rubric, read rules, edit rules)
├── conventions.md                                    (durable team rules)
├── internal/{index.md, <app>.md…}                    (our apps + self-hosted services)
├── external/{index.md, <system>.md…}                 (third-party services we call)
└── topics/{index.md, <subcat>/{index.md, <slug>.md…}} (cross-cutting subjects; subcategories are whatever the workspace defines)
```

Each directory has its own `index.md` describing what goes there and listing its immediate children. The tree is self-describing: walk root → subdir index → body file.

## Command surface

```
/knowledge <action> [args]
```

| Action      | Trigger                              | Details file          |
|-------------|--------------------------------------|-----------------------|
| `retrieve`  | `/knowledge retrieve <query>`        | [retrieve.md](retrieve.md) |
| `update`    | `/knowledge update [path]`           | [update.md](update.md)     |
| `index`     | `/knowledge index`                   | [index.md](index.md)       |
| `verify`    | `/knowledge verify`                  | [verify.md](verify.md)     |

For a one-off lookup or a small edit to a file you already know, use `Read` and `Edit` directly — the skill is mainly worth invoking for `index`, `verify`, and multi-file `update` flows that need citation / stamp discipline.

## Core rules

These are the contract every `/knowledge` action enforces:

- **One topic per file.** If a body file grows past one subject, split it.
- **Cite sources.** `([source](url): "quoted text")` for web, `` (`path/to/file:line`: `relevant snippet`) `` for local code.
- **Verification stamps.** Stamp any fact whose truth depends on an observable source. Single format, as a section header immediately above the claims it governs:

  ```markdown
  **Verified:** YYYY-MM-DD <where>
  ```

  `<where>` is one of `<app>@<shortsha>` (optionally `on <branch>` — recommended when your branching model means merged vs. in-flight matters; SHA with `git -C <workspace_path>/<app> rev-parse --short HEAD`, branch with `git -C <workspace_path>/<app> rev-parse --abbrev-ref HEAD`), `<conception-path>`, or `<name>: <url>`. For **external state** without a SHA to pin (live catalogue probes, SaaS API responses), append `HH:MM UTC` when intra-day drift matters. The SHA already pins the exact code state for `<app>@<shortsha>` variants — never add time-of-day there. Skip the stamp entirely for facts stable by design (project name, repo URL, high-level stack).
- **Cross-link.** Link body files to the `projects/` items that produced them, and vice versa.
- **Don't duplicate app internals.** Single-app details belong in that app's own `CLAUDE.md`. `knowledge/internal/<app>.md` files carry conception-side knowledge only (sandbox-testing recipes, rename history, cross-project gotchas, cross-app invariants).
- **Don't create pointer-only per-app stubs.** If there is no conception-side knowledge to record for an app, the `internal/index.md` row *is* the body. Add a body file only when the first non-pointer fact surfaces.
- **Prefer narrow-scope slugs over subject-area slugs.** `ci-action-pinning.md` beats `github-actions.md` — subject-area slugs become magnets for unrelated future content and dilute retrieval signal.
- **Bucket-picking rubric** (read rule): intent/rule → `conventions.md`; single app → `internal/<app>.md` (or index row if no body); ecosystem-spanning fact → `topics/<subcategory>/<slug>.md`; third-party → `external/<system>.md`.
- **Durable only.** Project-specific plans, incident reports, and in-flight work live under `projects/`, never here.

## When to create vs. extend

- **Durable team rule surfaced in session** → `knowledge/conventions.md` (root-level exception). Structure: claim (H3) + **Why** + **How to apply**. No stamp (stable by design).
- **New third-party service** → `external/<system>.md`. Filename is the canonical lowercase name.
- **New shared self-hosted service** (used by more than one app) → `internal/<service>.md`.
- **New cross-cutting topic** → `topics/<subcategory>/<slug>.md` with a short hyphen-separated slug (`ops/`, `security/`, or `testing/`).
- **New app** → add a row to `internal/index.md`. Create `internal/<app>.md` only if there is conception-side knowledge to record (sandbox recipe, cross-project gotcha, rename history, cross-app invariant). App internals belong in that app's own `CLAUDE.md`, not in `knowledge/`.
- **Single-app detail** → belongs in that app's `CLAUDE.md`, not under `knowledge/`.

## Index tree contract

Every `knowledge/**/index.md`:

- Lists every immediate `.md` file (except itself) and every immediate subdirectory.
- Entry shape: link, italic one-line description, backticked keyword tag list.
- Hand-written sections (intro, group headings, root-level read/edit rules) are preserved verbatim.
- Curated descriptions and tag sets survive across `/knowledge index` runs.

Full index contract + regeneration procedure lives in [index.md](index.md).

## Stamp refresh

`**Verified:**` stamps older than one month are suspect. `/knowledge verify` produces a punch-list; the user re-reads the current state of the referenced app and decides to refresh or remove each stale claim. The skill never auto-bumps — that would be lying about freshness.

$ARGUMENTS
