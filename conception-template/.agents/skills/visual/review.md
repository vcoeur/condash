# Review posture — from a landed diff

Read before authoring a `kind: review` note. A review is a visual note built
**from** a diff, not toward one: it describes a change that already exists, at a
higher altitude than line-by-line review. Schema, API, file, and architecture
changes become the same `data-model`, `api-endpoint`, `file-tree`, and `diagram`
blocks a forward plan would use — only now they summarize work that landed. The
general dialect, block vocabulary, wireframe bar, and open-questions form are in
[`SKILL.md`](SKILL.md), [`blocks.md`](blocks.md), and [`wireframe.md`](wireframe.md);
this file is the review-specific delta.

## Scope: the whole work unit is the worktree

The unit a review covers is the project item's **worktree branch**, which may
span several app repos: every repo at `<worktrees_path>/<branch>/<repo>/` (the
union of the item's `apps:` — `condash worktrees check <branch> --json` lists
them). Gather each repo's diff against its base
(`git -C <worktrees_path>/<branch>/<repo> diff <base>...HEAD`, default base
`main`; include uncommitted work when it belongs to the item) and review the
union — follow-up fixes, tests, and doc updates included, not just the most
recent commit or a single PR. When the branch spans repos, group the review by
app: lead each repo's section with a `### <#handle>` heading, and give each repo
its own `file-tree` and key-change tabs; cross-repo contract changes (a server
field + its client consumer) sit together in one `data-model`/`api-endpoint`
section so the reviewer sees the pair. Exclude unrelated pre-existing dirty
work. If the scope is genuinely ambiguous, state the assumption in the review's
opening prose or ask one concise question first. When updating a review after
feedback, keep covering the whole work unit plus the correction — never narrow a
broad review to only the latest fix.

## Canonical shape and budgets

One skeleton, top to bottom:

1. **UI-impact headline** — wireframes first, when the diff changed rendered UI.
2. **Short outcome narrative** (prose): what changed and why, 1–3 paragraphs.
3. **`data-model` / `api-endpoint` blocks** for schema and contract changes.
4. **`file-tree`** of the changed files with per-file `change` flags.
5. **`### Key changes`** — one horizontal `tabs` block of `diff` /
   `annotated-code`, one file per tab.

Budgets that keep it reviewable: 3–8 key-change tabs; under ~150 lines per tab
(summarize the rest of a long file instead of dumping it); title ≤ ~70
characters. Lean is not thin: a one-wireframe-one-sentence review of a 40-file
change under-serves the reviewer as much as boilerplate prose over-serves them.
Before authoring, inventory the changed surfaces (routes, components, dialogs,
role/empty/error states, shared abstractions) and either represent each
meaningful one with a block or intentionally omit it as tiny.

Do not add boilerplate: no disclaimer prose, no "this review is an aid", no
restating the file count the `file-tree` already carries. Prose earns its place
only when it tells the reviewer something the blocks cannot: the objective, a
real compatibility risk, a decision visible in the diff.

## Diff → block mapping

Read [`blocks.md`](blocks.md) for exact tags and props; never author from
memory.

- **Schema / migration change** → `data-model` with per-field
  `change: added|modified|removed|renamed` and `was` for prior types — grounded
  in the real migration diff. Reach for a `diff` of the literal SQL only when
  the exact statement matters.
- **API / route change** → `api-endpoint` with the post-change method, path,
  params, request, responses; `change` flags on changed params, `deprecated` on
  removed routes. Each request/response example is ONE parseable JSON value.
  Keep endpoints in normal document flow.
- **Compatibility-sensitive change** → a short prose note beside the block,
  naming the changed field/endpoint and whether it is breaking.
- **Any meaningful code hunk** → `diff` with `mode: "split"` (default for
  review; `unified` only for a narrow standalone hunk), real before/after text,
  `filename`/`language`, and a few high-signal `annotations` anchored to the
  after-side lines (`side: "before"` for removed lines). Group the key files
  under a `### Key changes` heading in ONE horizontal `tabs` block, one file
  per tab.
- **Brand-new file** → `annotated-code` rather than a one-sided diff: the real
  new code with notes anchored to the lines that matter.
- **Files added / removed / renamed** → `file-tree` with `change` flags and
  short `note`s; a `snippet` only when it tells the reviewer something the path
  does not.
- **Rendered UI / interaction change** → wireframe blocks showing the visible
  delta BEFORE the reader reaches code: `columns` with `Before`/`After` labels
  when comparison clarifies, after-only when purely additive, a state sequence
  for flows. Read [`wireframe.md`](wireframe.md) first — always.
- **Architecture / data-flow shift** → `diagram` (html/css with `.diagram-*`
  primitives) as before/after panels or layers, or `mermaid` for a quick graph.
  Never use a diagram as a stand-in for rendered UI.
- **CLI / command-surface change** → there is no endpoint block for a command:
  summarize new or changed verbs in a `table` (command, effect, exit code) or a
  `code` block of real invocations, with a short prose note. `api-endpoint` is
  for an HTTP method/path, not a CLI.
- **Outcome narrative** → prose; the one place the model writes freely.

## Grounding rule

Structured blocks are true by construction ONLY if derived from the actual
changed lines: real paths, real fields, real method/path, real before/after
text — never inferred, rounded, or invented. The model writes only the prose. A
confidently wrong review is dangerous: a reviewer who trusts the summary skips
the very line the summary got wrong. When the diff does not contain a fact,
leave it out; mark anything inferred as inferred.

Build code-bearing blocks (`diff`, `annotated-code`, and the code nested in a
`tabs` block) from the real file text — copy the exact changed lines and encode
multi-line code as JSON string attributes; never retype code from memory.
Inside `tabs`, each child is the runtime `{ id, type, data }` shape, not a
`<Diff>` / `<AnnotatedCode>` tag.

**Never transcribe secrets.** A diff can contain keys, tokens, webhook URLs, or
`.env` values — redact them (`sk-•••`, `<redacted>`) in every block, caption,
and note.
