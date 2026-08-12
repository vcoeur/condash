# /knowledge — garden (whole-tree audit + improvement pass)

Audit the whole `knowledge/` tree for content-level improvement opportunities — duplicates, files that are really one app's docs, oversized or stub files, index/keyword quality, and stale or broken references — propose ranked changes, and drive user-approved apply batches.

The audit is two-tier: the **existing verbs supply the mechanical signals + coverage data** (the floor), and a **mandatory full read-pass is the audit tier** — the pass is what catches what no verb can. The gardener proposes ranked changes and applies only the batches the user approves; it never auto-applies anything.

Unrelated to nodum's "gardener" (LLM curation jobs) — a different tool, different scope; only the name is shared.

Trigger: `/knowledge garden`.

## Procedure

1. **Run the verbs, read the indexes:**

   ```bash
   condash knowledge tree --json
   condash knowledge verify --json
   condash audit --include all --json
   condash applications list --json
   ```

   Then read every `knowledge/**/index.md`. What each contributes:

   - `condash knowledge tree --json` — the full file list (the coverage checklist's spine). Files carry `relPath`, `path`, `name`, `title`, `kind`, `summary`, `verifiedAt`, `lines`.
   - `condash knowledge verify --json` — returns `{stale[], fresh, unstamped[], maxAge, issues}`: the stamp-gap signal. `stale[]` flags stamps older than the 90-day window, `unstamped[]` names files with no `**Verified:**` line at all.
   - The `index.md` reads — keywords + descriptions per entry: the index-quality signal, plus duplicate hints by shared keywords.
   - `condash audit --include all --json` — tree structure: index orphans/danglers, cross-repo refs, LFS coverage, worktree drift.
   - `condash applications list --json` — the app registry (handles + aliases) for single-app detection.

   All are pure read-only.

2. **Build the coverage checklist** from `tree --json` — one row per body file:

   | Column | Source |
   |---|---|
   | path | `tree --json` (knowledge-relative) |
   | lines | `tree --json` `lines` field (files only, wc -l semantics) |
   | stamped? | `tree --json` `verifiedAt` / `verify --json` `unstamped[]` |
   | stale? | `verify --json` `stale[]` |
   | keywords | the `index.md` entry |
   | handle mentions | the read-pass (look for the handles/aliases from `applications list`) |

   Join key: `tree --json` paths are knowledge-relative (`topics/foo.md`) while `verify --json`
   paths are conception-relative (`knowledge/topics/foo.md`) — strip the `knowledge/` prefix on
   the verify side before crossing the two. For the `stamped?` signal, `verify`'s
   `unstamped[]` is authoritative: `tree --json`'s `verifiedAt` comes from an 8 KB head read
   and can miss a stamp sitting deeper in the file.

   Every file on the list must be read and triaged — nothing is skipped because it had no mechanical signal. The report states `read N/N` (N = the count of body files on the checklist).

3. **Full read-pass.** Read every body file, using the mechanical signals as hints for where to look harder. This is where the semantic findings are authored — "this topic is really app X docs" (no handle mention needed), "this content is rot", "these two merge despite different keywords", "this keyword set is wrong for how people search". On a large tree (say > 60 body files), fan out per top-level bucket (`internal/`, `external/`, `topics/<subcategory>/…`) to fresh parallel sessions, each returning its own findings; the driving session merges them.

4. **Gap assessment.** Note any signal the verbs could not supply. If one exists, **stop** and propose the smallest verb extension to the user before continuing — extend an existing verb before adding a new one (e.g. surface `unstamped` from `verify` if it ever stops doing so), never a whole new noun. No condash code without a proven gap.

5. **Triage every finding** against the bucket-picking rubric and the three-yes durability gate (the core rules in `SKILL.md`): single app → `internal/<app>.md`; ecosystem-spanning → `topics/<subcategory>/<slug>.md`; third-party → `external/<system>.md`; durable team rule → the project's `CLAUDE.md`, not here — and promote/keep only on three yeses (holds beyond this task; applies to more than one app or governs the ecosystem; true regardless of the PR's outcome). A finding is a *candidate*, not a verdict — the skill owns the editorial call.

6. **Write the ranked findings report** as a note in the driving project (e.g. `notes/02-pass-results.md`), one row per finding (class, path, action, origin, confidence — see the taxonomy below). Present the report to the user and get approval before applying anything.

7. **Apply approved batches.** Conception-side edits (body files, indexes, keywords) go direct into the tree. App-doc moves go through that app's worktree. Renames happen only after a reference grep (wikilinks key off the basename — every `[[target]]` must be found first). Deletions only of rot the user approves. Never commit — `condash sync run` (the sweeper) is the conception's only committer.

8. **Verify after each batch:**

   ```bash
   condash knowledge index
   condash knowledge verify
   condash audit --include all
   ```

   Run this trio after every batch, not once at the end — a bad batch surfaces before the next one starts.

## Report taxonomy

One row per finding:

```
{
  class: 'duplicates' | 'single-app' | 'oversized' | 'stub' | 'stale' | 'unverified' | 'index-quality' | 'reference-dangler',
  severity: 'info' | 'warn' | 'error',
  path: string,            // knowledge/ relative
  line?: number,
  detail: string,          // one-line, actionable
  suggestion?: 'move' | 'merge' | 'split' | 'rename' | 'delete' | 'restamp' | 'edit-index',
  target?: string,         // proposed destination (app handle / knowledge path / item path)
  origin: 'verb' | 'read', // where the finding came from
  confidence: number,      // 0..1
}
```

## Findings classes

| Class | Threshold / definition | Suggestion | Severity |
|---|---|---|---|
| `duplicates` | Same-bucket pairs whose slug tokens **and** index keywords overlap (e.g. `sandboxed-npx-npm-cache` / `sandboxed-toolchain-cache` / `setup-uv-enable-cache`). Verb-hinted via shared keywords; confirmed by read. | `merge` | warn |
| `single-app` | A body file that is really one app's docs. Verb-hinted by handle/alias/repo-path mentions and cross-bucket keyword overlap with `internal/<app>.md`; the decisive call is the read — a `topics/*` file full of app jargon without the handle is still single-app. `internal/<app>.md` files over the oversized threshold may hold app-internal content that belongs in the repo's own docs. | `move`, target = app handle | warn |
| `oversized` | Body file > 500 lines. | `split` | info |
| `stub` | Body file ≤ 10 lines — likely merge/delete candidate. | `merge` or `delete` | info |
| `stale` | `knowledge verify` output — stamp older than the 90-day window. | `restamp` (after a re-read) | warn |
| `unverified` | No `**Verified:**` stamp (`verify`'s `unstamped[]`) — rot candidate; `restamp` when a re-read confirms it, else `delete`; the read judges the content. | `restamp` or `delete` | info |
| `index-quality` | Description > 200 chars; keywords empty or identical to slug tokens; keyword absent from the body. | `edit-index` | info |
| `reference-dangler` | Knowledge-body links into `projects/` (transfer markers, cross-links) pointing at paths that don't exist; `**Transferred:**` markers whose target knowledge path no longer exists. Resolve candidate paths via `condash projects` reads. | `edit-index` / `rename` / `delete` | error |

Severity: `error` = broken reference; `warn` = real improvement signal; `info` = heuristic (size, keyword style, unverified).

## Guarantees

- **Never auto-applies anything.** The skill proposes and drives approved batches; the only mutation surface is step 7, and every batch is user-approved first. No stamp is bumped without a re-read — a bumped stamp without one is a lie about freshness.
- **Single-app detection degrades gracefully.** When the applications registry is absent (`applications list` fails or returns nothing), the read-pass still catches app-docs-in-disguise — it just loses the mechanical hints.
- **No new condash code by default.** The skill orchestrates existing verbs; a verb extension is proposed only when the gap assessment proves one is needed.

## Related

- `/knowledge verify` — the mechanical sweep (`verify`'s signals are garden's floor; run garden's own verification trio after each batch).
- `/knowledge update` — add or edit a body file with citation + stamp rules; what approved batch edits land through.
- `/knowledge index` — regenerates `knowledge/**/index.md` trees; the `edit-index` fix and step 8's first command.
- `condash audit --include all` — tree-structure signals (index orphans/danglers, cross-repo refs, LFS, worktree drift).
- `condash applications list` — the app registry that powers single-app detection.
