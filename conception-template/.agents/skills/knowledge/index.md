# /knowledge — index (regenerate `knowledge/**/index.md`)

Refresh the recursive tree of `knowledge/**/index.md` files so every directory at every depth has an index listing the files and subdirectories immediately inside it, each entry carrying a link, a one-line description, and keyword tags.

The CLI owns the walk, the diff, the idempotence guarantee, and the atomic writes — the skill just runs it and surfaces the report.

Trigger: `/knowledge index`.

## Procedure

1. **Run:**

   ```bash
   condash knowledge index --json
   ```

   Pass `--dry-run` to inspect without writing.

2. **Surface the report sections** to the user:

   - `data.created[]` — index files created from scratch.
   - `data.updated[]` — index files rewritten. Each row carries `added[]`, `dropped[]`, `tagsAdded[]` (subdir bullets that gained aggregate tags from descendants).
   - `data.unchanged` — count of indexes with zero diff (proves idempotence).
   - `data.flaggedRenames[]` — bullets whose target disappeared while a similar new on-disk entry appeared. **Ask the user** before treating any as a rename.
   - `data.overTagDropped[]` — surplus aggregated tags the engine had to drop to fit the 8-tag cap. Each row carries `indexPath`, `entry`, and `dropped[]`. Surface for hand-pruning the parent's curated tag set.
   - `data.dirtyClear` — whether the `.index-dirty` marker was cleared.

## Contract recap

- **Same tree contents → zero diff.** Existing entries kept verbatim across runs.
- **New file → drafted entry with auto-extracted description + keywords.** User refines on next read.
- **Removed file → bullet dropped.** Reported.
- **Curated descriptions and tags survive across runs** — to change them, edit the index directly.
- **Subdir tag sets grow monotonically.** Pruning stays manual.
- **Renames are flagged, never silently rewritten.**

## Description style

Italicised, ≤200 chars, semicolons over full sentences, load-bearing keywords first. Never invent facts not in the body.

## Keyword style

Lowercase, hyphenated, 3–8 per entry, comma-separated inside backticks. Pick terms a future search would use, not synonyms of the filename.

## When *not* to run

- If `git status --porcelain knowledge/` shows uncommitted changes to an `index.md`, ask the user before overwriting.

## Related

- `/projects index` — same engine, parallel command.
- [`knowledge/index.md`](../../../knowledge/index.md) — the read rules and triage workflow this skill exists to support.
