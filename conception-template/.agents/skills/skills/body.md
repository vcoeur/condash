# /skills — install and update condash-shipped artefacts

condash ships two kinds of artefacts into a conception tree:

- **Whole-file agent skills** under `.agents/skills/<name>/` — source-of-truth
  for the skills compiled into `.claude/skills/` and `.kimi/skills/`.
- **Top-level files** at the conception root. Some are written whole
  (`AGENTS.md`, `.gitignore`); some carry a heading-delimited region inside
  a larger user-owned file (e.g. `AGENTS.md`'s `## General` section is
  shipped, `## Specifics` is user-owned).

Both kinds flow through a single CLI surface — `condash skills {list,status,install}` —
and a single manifest namespace. This skill is the user-facing wrapper for
fetching new versions while keeping local edits you care about.

## When to use

- **First-time install** — fresh conception that hasn't run condash yet.
- **After `npm install -g condash`** that bumps the version — pull updated
  shipped content.
- **Audit** — "do my local files match the version condash shipped?".

For a one-off "just install everything, I haven't touched anything" run,
`condash skills install` directly is faster. This skill earns its keep when
there are local edits to triage.

## Trigger

```
/skills [update | install [<name-or-path>...] | status]
```

| Action     | Meaning |
|------------|---------|
| `update`   | (default) Audit shipped artefacts, then walk per-item: auto-apply safe updates, prompt on edited items. |
| `install`  | One-shot install. Forwards to the CLI. |
| `status`   | Read-only audit. Forwards to `condash skills status`. |

`<name-or-path>` accepts either a shipped skill name (`knowledge`, `pr`,
`projects`, `skills`, `tidy`, …) or a top-level destination path
(`AGENTS.md`, `.gitignore`, …). No positionals = everything.

## Procedure (`/skills update`)

### 1. Audit

Run `condash skills status --json` and parse `data.items` (skill source files)
and `data.files` (top-level files). Each row carries a `state`:

- `unchanged`       — local matches manifest matches shipped → ignore.
- `outdated`        — local matches manifest but shipped has new content → safe to overwrite.
- `edited`          — local differs from manifest → may conflict with shipped version.
- `missing`         — manifest knows the item but it's gone from disk.
- `orphan`          — item present on disk but not tracked by manifest.
- `missing-heading` — region-style item: file exists but doesn't carry the expected `## <region>` heading (or carries it more than once).
- `source-missing`  — manifest tracks the item but the shipped source has been removed from the bundle (a previous condash version installed it; the current one no longer ships it).

If both arrays are empty, fall through to first-time install: ask the user
*"Nothing is installed yet — run `condash skills install` to install
everything? (y / n)"*. On `y`, run it and stop.

### 2. Auto-apply `outdated`

For every `outdated` row, the CLI will safely overwrite on a plain
re-install (it sees the local hash matches the manifest, so the user hasn't
edited — overwriting is contractually safe).

```bash
condash skills install <item-1> <item-2> ... --json
```

`<item>` is whichever identifier the row carries — a skill name for
skill-tree rows, a destination path for top-level-file rows. Parse the
response and report the resulting counts to the user as a one-line
"updated N item(s)".

### 3. Walk `edited` items

For each `edited` row ask the user one question. Show:

- The on-disk path (skill files resolve to
  `<conception-root>/.agents/skills/<skill>/<relPath>`; top-level files
  resolve to `<conception-root>/<path>`; region-style entries identify the
  region inside the file as well).
- The diff between local and shipped:

  ```bash
  condash skills install <item> --dest <conception-root> --diff --dry-run
  ```

  Then read the `diffs[]` array out of the JSON and present the diff block
  for this entry.

- The choice:

  > "Local has been edited. **k**eep local / **a**ccept shipped / **s**how full file / s**k**ip?"

  Decisions:
  - **keep local** — do nothing for this entry.
  - **accept shipped** — record the entry. Batch-apply at step 4.
  - **show full file** — Read the shipped content from the path returned in
    `condash skills list --json`, present, re-ask.
  - **skip** — drop every remaining `edited` row in this skill (or the
    same top-level path) from the prompt loop. Useful when the user has
    heavily customised one and wants to leave it alone.

### 4. Apply `accept shipped` choices

The CLI's `--force` flag operates per skill / per top-level path, not per
file / per region — using it risks overwriting "keep local" files in the
same group. To keep the decision boundary at the item level, **always use
the per-file write path**, even when every `edited` row in a group was
"accept shipped":

1. For each accept-shipped item: read the shipped content from the path in
   `condash skills list --json`, then `Write` it to the on-disk path.
2. After all per-file writes, run `condash skills install <group> --json`
   (no `--force`) once per touched group so the manifest gets refreshed —
   the CLI will see local matches shipped and mark each entry `Unchanged`.

For region-style top-level files, the boundary is per-region. Every shipped
file with regions has a single region today, so `condash skills install
<path> --json` (no `--force`) safely refreshes the manifest after the user
`Write`s the new region content.

### 5. Handle `missing`, `missing-heading`, `orphan`, `source-missing`

- **`missing`** — the item vanished but is still in the manifest. Ask:
  *"Re-install or remove from the manifest? (i / r / skip)"*.
  - `i` re-runs `condash skills install <item>`.
  - `r` is a manual fix the user does — drop the entry from
    `.condash-skills.json`. (For top-level files, the `r` re-install path
    writes the whole shipped file: H1 + body + any placeholder region
    contract.)
- **`missing-heading`** (region-style top-level files only) — the file is
  on disk but the expected `## <region>` heading is absent or duplicated.
  Mention it once and recommend either re-adding (or de-duplicating) the
  heading manually or running `condash skills install <path> --force`
  (which writes the whole shipped file, replacing the user's content).
  **Do not auto-force.**
- **`orphan`** — entry present on disk but not tracked by the manifest.
  Mention it once, recommend running `condash skills install <item>` to
  bring it under tracking, move on.
- **`source-missing`** — the manifest tracks the item but the shipped
  source is gone from the bundle (typically: a previous condash version
  installed something the current version no longer ships). Mention it
  once and recommend running `condash skills install --prune` to drop
  every `source-missing` entry from the manifest in one pass. **Do not
  auto-prune.**

### 6. Final report

Summarise what changed:

```
Skills update report:
  Auto-updated: 3 file(s) across 2 skill(s) + 1 top-level file
  Accepted shipped (resolved local edits): 2 file(s)
  Kept local: 4 file(s)
  Skipped: knowledge (1 file)
  Source-missing: .gitignore (recommend --prune)
  Manifest now at version 3.1.0
```

`Manifest now at version` reads from any one entry's `shippedVersion` after
the run — they'll all match within a single condash version.

## Procedure (`/skills install`)

Forward to the CLI directly:

```bash
condash skills install [<name-or-path>...] [--force] [--diff] [--dry-run] [--prune] [--json]
```

No editorial layer needed — the CLI's refusal-and-`--force` flow is enough
for the "I know what I'm doing, just run it" case.

## Procedure (`/skills status`)

Forward to `condash skills status --json` and pretty-print `data.items` +
`data.files`. Useful when the user wants to know "is anything stale?"
without committing to a walk.

## Rules

- **Never delete a file** without explicit user confirmation. The CLI
  doesn't delete either.
- **Never edit `.condash-skills.json` by hand** — `condash skills install`
  owns it. Stale or corrupt manifests should be regenerated by re-running
  install (the `unchanged` path refreshes the entry in place). Exception:
  the user-driven `r` (remove) branch for `missing` entries.
- **Never push past a refused install** with `--force` unless the user said
  "accept shipped" for that specific item. The whole point of the audit is
  consent per entry.
- **Never auto-force on `missing-heading`** — that overwrites the whole
  file. Always ask first.
- **Never auto-prune on `source-missing`** — flag and recommend, but let
  the user invoke `--prune` explicitly.
- Bootstrap chicken-and-egg: this skill ships **inside** the same install
  bundle. After `condash skills install`, this `body.md` is on disk in the
  user's tree; from that point on `/skills update` can update itself like
  any other shipped artefact (the CLI's hash check still gates each write).

## Why this skill exists

The CLI alone is fine for "all-or-nothing" runs. The skill earns its keep
when there are several edited items and the user wants different decisions
for each. That triage is editorial — exactly what skills do well and what
stuffing more flags into the CLI can't reduce to.

Out of scope (intentionally):

- Creating new skills — that's `/skill-creator`.
- Editing skill content — that's plain `Edit`.
- Publishing skills back to condash — flows through the condash repo's PR
  pipeline, not this skill.
