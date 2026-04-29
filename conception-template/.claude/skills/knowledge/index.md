# /knowledge — index (regenerate `knowledge/**/index.md`)

Refresh the recursive tree of `knowledge/**/index.md` files so every directory at every depth has an index listing the files and subdirectories immediately inside it, each entry carrying a link, a one-line description, and keyword tags.

Trigger: `/knowledge index`.

## Intent

`knowledge/` is a tree of directories. Every directory — root, subdir, sub-subdir, at any depth — has an `index.md` that lists, with one entry each:

- every immediate `.md` file in that directory (excluding `index.md` itself), and
- every immediate subdirectory.

Each entry has three parts: **link**, **one-line description**, **keyword tags**. The indexes form a triage tree: a future Claude session walks down from `knowledge/index.md`, reads only `index.md` files at each level, and picks the right body file by matching the user's query against descriptions + keyword tags — opening a body file only when its index entry matches.

This skill keeps each `index.md` consistent with what is actually on disk: adds new entries, drops deleted ones, flags renames, and **preserves curated descriptions and tags** for entries whose underlying file is unchanged.

The authoritative read / edit rules and the triage workflow live in [`knowledge/index.md`](../../../knowledge/index.md) and in this skill's [SKILL.md](SKILL.md) — do not restate them here, and do not rewrite that policy when indexing.

## Entry format

Each entry is a single bullet line with three parts:

```markdown
- [`filename.md`](filename.md) — *one-line italic description.* `[keyword-1, keyword-2, …]`
- [`subdir/`](subdir/index.md) — *one-line italic description of what the subdir contains.* `[aggregate-keyword-1, …]`
```

- **Description** — italicised, ≤200 chars. Lifts the load-bearing nouns and constraints from the body file. Semicolons over full sentences. For a subdir entry, summarise what the subtree covers (the curated wording in the parent index is preferred over auto-extraction from the subdir intro).
- **Keywords** — 3–8 lowercase hyphenated tags inside backticks, comma-separated. The set must answer "what query terms should land on this file?". Include: app/service names, distinctive concepts, central file/route names, error symptoms, framework features. Skip terms already obvious from the filename. For a subdir entry, aggregate the distinctive keywords across the subtree (do not just repeat the directory name).

## Procedure

### 1 — Walk the tree

`find ~/src/vcoeur/conception/knowledge -type d` to list every directory at any depth. Process **leaves first** so a parent index, when it lifts a subdir summary, sees the subdir's freshly-written `index.md`.

### 2 — For each directory `D`

a. **Enumerate immediate children**:
   - `Glob D/*.md` (drop `index.md`).
   - `find D -mindepth 1 -maxdepth 1 -type d` for subdirectories.

b. **Read existing `D/index.md`** if present. Parse the current entry list (the bullet block under `## Current files` or, at the root, `## Structure`), keeping any group headings in place. Preserve every hand-written section verbatim: purpose paragraph, "what each file must cover", "when to add", "when *not* to add", group headings, and — at the root — `## Read rules` and `## Edit rules`.

   **Root body files**: at `knowledge/` specifically, root-level body files (currently only `conventions.md`) are listed in a `## Root body files` section above the subdir block. Treat those entries with the same rules as any other body-file entry.

c. **Diff** the current entry list against the actual children and apply:

   - **Existing entry, file/subdir still present** → keep the bullet verbatim. Do not touch description or keywords. (This is the idempotence guarantee for unchanged files.)
   - **Existing entry, file/subdir gone** → drop the bullet. Report it.
   - **New child, no entry** → draft a new bullet:
     - For a file: read its first ~40 lines, derive description + keywords using the rules above. The user refines the draft on next read.
     - For a subdir: read its just-written `index.md`'s intro and aggregate distinctive keywords across its listed entries.
   - **Suspected rename** (entry's filename gone, similar new file present) → flag, ask the user. Never silently rewrite.

d. **Write `D/index.md`** with the updated entry list. New entries land under the obvious group heading, or under `### Uncategorised` if no group fits (and flag in the report).

### 3 — Propagate upward

If `D`'s entry list changed (add/drop), the parent index's entry for `D` may now be out of date — its description and aggregate keywords were chosen for the prior subtree shape. Flag the parent index for review. Do not auto-rewrite the parent's curated subdir summary; let the user refine.

### 4 — Sanity checks

- Every directory under `knowledge/` has an `index.md`.
- Every link in every `index.md` resolves.
- Every body `.md` is listed in exactly one parent index.
- Every subdirectory is listed in exactly one parent index.
- Every entry has all three parts (link, italic description, backticked keyword list). Missing parts → flag.

### 4.5 — Clear the dirty marker

After all index writes succeed, `rm -f knowledge/.index-dirty` to signal the tree is in sync.

### 5 — Report

In this order:

- Indexes created.
- Indexes updated (with lines added / dropped, and "parent flagged for review" markers).
- New entries drafted from the body file (user refines on next read).
- Suspected renames awaiting confirmation.
- Other inconsistencies flagged but not fixed (missing description or keywords, dangling link, uncategorised placement).

## When the index needs updating

The index for directory `D` is **stale** whenever any of the following happens:

- A `.md` file is added to, removed from, or renamed inside `D`.
- A subdirectory is added to or removed from `D`.
- A file is added to or removed from **anywhere in a subtree of `D`** — because the parent's subdir-entry keyword aggregate may no longer cover the subtree.

Editing the *body* of an existing file does **not** by itself stale the index. But if the body edit changes the file's scope (new section, dropped section, renamed concept), the user should re-run this skill — the skill cannot detect content drift behind an unchanged filename, so the trigger is manual.

## How to keep entries accurate over time

- **Same tree contents → zero diffs.** Existing entries are preserved verbatim across runs. This is the explicit idempotence contract.
- **New file → new entry with auto-drafted description + keywords.** User refines on next read.
- **Removed file → bullet dropped.** Reported.
- **Material body change** (scope, headings, name of central concept) → the user re-runs the skill and manually edits the affected entry. The skill will not touch it on its own.
- **Rename** → skill flags, user confirms.
- **Curated edit to a description or keyword set** → the skill preserves it on subsequent runs. Edit `D/index.md` directly; do not edit the body file expecting the index to follow.

## Conventions

- **Description style** — italicised, terse, ≤200 chars; semicolons over full sentences; load-bearing keywords first. Never invent facts not in the body.
- **Keyword style** — lowercase, hyphenated, 3–8 per entry, comma-separated inside backticks. Pick terms a future search would use, not synonyms of the filename.
- **Preserve policy prose and curated entries.** Hand-written sections and bullet text are authoritative. The skill only mutates the entry *list* (add/drop), never existing bullet *text*.
- **Do not move or rename body files.** Only `index.md` files are edited. Miscategorised body files → flag.
- **Do not invent groupings.** Keep existing group headings; new entries go under the obvious fit or under `### Uncategorised` (and are flagged).

## When *not* to run

- If `git status --porcelain knowledge/` shows uncommitted changes to an `index.md`, ask the user before overwriting it.
- After only a body edit with no structural change — unless the user wants the description/keywords refreshed, which is a manual edit on the affected bullet.

## Related

- [`knowledge/index.md`](../../../knowledge/index.md) — read rules and the keyword-driven triage workflow that this skill exists to support.
- `/projects index` runs the parallel regeneration over `projects/index.md` + `projects/YYYY-MM/index.md`. Same idempotence contract, same entry format.
