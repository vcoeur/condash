# /projects — index (regenerate `projects/index.md` + month indexes)

Regenerate the self-describing index tree under `projects/`. Mirrors the contract of the `knowledge/` index tree.

Trigger: `/projects index`.

## Intent

Every directory in the `projects/` tree has an `index.md` that lists its immediate children:

- `projects/index.md` — tree root. Intro paragraph, kinds summary, read rules, and one entry per `YYYY-MM/` subdirectory.
- `projects/YYYY-MM/index.md` — one entry per item folder in that month.

Each entry has three parts: **link**, **italic one-line description**, **backticked keyword tag list**.

This skill keeps each `index.md` consistent with what is on disk: adds new entries, drops deleted ones, flags suspected renames, and **preserves curated descriptions and tags** for entries whose underlying folder is unchanged.

## Entry format

Month-index entries (`projects/YYYY-MM/index.md`):

```markdown
- [`YYYY-MM-DD-slug/`](YYYY-MM-DD-slug/README.md) — *one-line italic description.* `[kind, status, app-1, keyword-…]`
```

Root-index entries (`projects/index.md`):

```markdown
- [`YYYY-MM/`](YYYY-MM/index.md) — *aggregate description of the month's items.* `[kind-1, kind-2, app-…, topic-…]`
```

Rules:

- **Description** — italicised, ≤200 chars. Lifts the load-bearing nouns and constraints from the README (`# Title`, `## Goal` / `## Description` first line, and any `**Apps**` worth citing). Semicolons over sentences. For month entries, summarise the subtree in one line.
- **Keyword tags** — 3–8 lowercase hyphenated terms, comma-separated inside backticks.
  - Always include the `**Kind**` (one of `project`, `incident`, `document`).
  - Always include the `**Status**` (one of `now`, `review`, `later`, `backlog`, `done`).
  - Then app slugs and distinctive concept words. Skip terms already obvious from the folder name.
  - For month entries, aggregate the distinctive tags across the month's items (not just the month number).

## Item validation (pre-pass)

Before regenerating any index, walk every `projects/YYYY-MM/YYYY-MM-DD-slug/` folder and parse its `README.md` header. Warn (do not block) on any of:

- `**Date**` ≠ the `YYYY-MM-DD` prefix of the folder name.
- `**Status**` not in `{now, review, later, backlog, done}`.
- `**Kind**` not in `{project, incident, document}`.
- Folder name does not match `^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$`.

Warnings are reported in a dedicated "Item validation" block in §5; they never block the index write. Fix is manual — the user edits the header (or `git mv`s the folder when Date/slug drift).

## Procedure

### 1 — Walk the tree

```bash
find ${CLAUDE_PROJECT_DIR}/projects -mindepth 1 -maxdepth 1 -type d
```

Process **month directories first** (leaves), then the root `projects/index.md` last so its aggregate descriptions can lift from the freshly-written month indexes.

### 2 — For each month directory `M = projects/YYYY-MM`

a. **Enumerate items**: `find M -mindepth 1 -maxdepth 1 -type d` for item folders. Skip any non-item entries (none expected).

b. **Read existing `M/index.md`** if present. Parse the bullet list under `## Items`. Preserve every hand-written section verbatim (intro paragraph, any group headings).

c. **Diff the list against the actual items on disk** and apply:

   - **Existing entry, folder still present** → keep the bullet verbatim. Do not touch description or keywords. This is the idempotence guarantee.
   - **Existing entry, folder gone** → drop the bullet. Report it.
   - **New folder, no entry** → read the folder's `README.md` header and first section body; derive description + keyword tags using the rules above (kind + status always first). The user refines the draft on next read; no marker is needed.
   - **Suspected rename** (entry's folder name gone, similar new folder present) → flag, ask the user. Never silently rewrite.

d. **Write `M/index.md`** with the updated bullet list.

### 3 — Root index (`projects/index.md`)

Same diff logic against the list of month directories. Each month's entry description and keyword set should aggregate across the items in that month. When a month's items change, flag the root entry for review — do not auto-rewrite the curated aggregate.

### 4 — Sanity checks

- Every directory at every depth has an `index.md`.
- Every link in every `index.md` resolves.
- Every item folder is listed in exactly one parent index.
- Every month subdirectory is listed in the root index.
- Every entry has all three parts. Missing parts → flag.

### 5 — Clear the dirty marker

After all index writes succeed, `rm -f projects/.index-dirty` to signal the tree is in sync.

### 6 — Report

In order:

- Indexes created.
- Indexes updated (with entries added / dropped, and "root flagged for review" markers).
- New entries drafted from the README (user refines on next read).
- Suspected renames awaiting confirmation.
- **Item validation** — warnings from the pre-pass (bad Date / Status / Kind / folder name). One line per warning: `<folder>: <what's wrong>`.
- Other inconsistencies (missing tags, dangling link, etc.) flagged but not fixed.

## When the index needs updating

`M/index.md` is stale whenever any of the following happens:

- An item folder is added to, removed from, or renamed inside `M`.
- An item's `**Kind**` or `**Status**` changes (those feed the tag list).

Editing the body of a note or README does **not** by itself stale the index. If the title or first-section scope changes materially, the user can re-run this skill — it cannot detect content drift behind an unchanged folder name, so the trigger is manual.

## Idempotence and curated edits

- **Same tree contents → zero diffs.** Existing entries are preserved verbatim.
- **New item → new entry with auto-drafted description + tags.** User refines on next read.
- **Removed item → entry dropped.** Reported.
- **Material scope change** (item kind flips, app list changes substantially) → user re-runs + manually edits the affected bullet. The skill will not touch it.
- **Rename** → skill flags, user confirms.
- **Curated description or keyword edit** → preserved across runs. Edit `M/index.md` directly; do not edit the README expecting the index to follow.

## When not to run

- If `git status --porcelain projects/` shows uncommitted changes to an `index.md`, ask the user before overwriting.
- Right after a migration — let the user run it explicitly; a full rewrite of every index deserves an intentional trigger.

## Relation to `/knowledge index`

Same idempotence contract, same entry format. The two skills are deliberately parallel — a reader who has walked `knowledge/` should feel at home walking `projects/` without relearning the shape.
