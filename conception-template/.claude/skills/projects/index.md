# /projects — index (regenerate `projects/index.md` + month indexes)

Regenerate the self-describing index tree under `projects/`. The CLI owns the walk, the diff, the idempotence guarantee, and the atomic writes — the skill just runs it and surfaces the report.

Trigger: `/projects index`.

## Procedure

1. **Run:**

   ```bash
   condash projects index --json
   ```

   Pass `--dry-run` to inspect without writing.

2. **Surface the report sections** to the user:

   - `data.created[]` — index files created from scratch.
   - `data.updated[]` — index files rewritten. Each row carries `added[]`, `dropped[]`, `tagsAdded[]` (subdir bullets that gained aggregate tags from descendants).
   - `data.unchanged` — count of indexes with zero diff (proves idempotence).
   - `data.flaggedRenames[]` — bullets whose target disappeared while a similar new on-disk entry appeared. **Ask the user** before treating any as a rename; the engine never silently rewrites.
   - `data.overTagDropped[]` — surplus aggregated tags the engine had to drop to fit the 8-tag cap. Each row carries `indexPath`, `entry`, and `dropped[]`. Surface for hand-pruning the parent's curated tag set.
   - `data.validationWarnings[]` — header drift (Status / Kind / Date / folder name / Apps). One line per warning. Fix is manual: edit the README header or `git mv` the folder.
   - `data.dirtyClear` — whether the `.index-dirty` marker was cleared.

3. **Surface curated description rewrites.** When a subdir's subtree changed materially, the engine flags the parent's italic description as "may need a refresh". This currently lands as part of `data.updated[].tagsAdded`; if you spot heavy churn there, suggest the user re-read and refine the parent's description in the index.md directly.

## Contract recap

- **Same tree contents → zero diff.** Existing entries kept verbatim.
- **New child → drafted entry.** User refines on next read.
- **Removed child → bullet dropped.** Reported.
- **Curated descriptions and tags survive across runs** — to change them, edit the index directly.
- **Subdir tags grow monotonically.** The 3–8 target is for hand-pruning, not enforcement.

## When *not* to run

- If `git status --porcelain projects/` shows uncommitted changes to an `index.md`, ask the user before overwriting.

## Relation to `/knowledge index`

Same engine, same contract, parallel commands. A reader who has walked one tree should feel at home walking the other without relearning the shape.
