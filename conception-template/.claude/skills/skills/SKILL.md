---
description: Install or update condash-shipped skills in this conception. Wraps `condash skills {status,install}`. Use after upgrading condash to pull updated skill content, or to do the first-time install. Walks edited files one-by-one so local customisations don't get clobbered.
---

# /skills — install and update condash-shipped skills

condash ships a default set of skills (the same ones in this directory) under `conception-template/.claude/skills/`. This skill is the user-facing wrapper around `condash skills {list,install,status}` for fetching new versions while keeping local edits you care about.

## When to use

- **First-time install** — fresh conception that doesn't yet have these skills.
- **After `npm install -g condash`** that bumps the version — pull updated skill content.
- **Audit** — "do my local skills match the version condash shipped?".

For a one-off "just install everything, I haven't touched anything" run, `condash skills install` directly is faster. This skill earns its keep when there are local edits to triage.

## Trigger

```
/skills [update | install [<name>...] | status]
```

| Action     | Meaning |
|------------|---------|
| `update`   | (default) Audit, then walk per-file: auto-apply safe updates, prompt on edited files. |
| `install`  | One-shot install — names default to all. Forwards to `condash skills install`. |
| `status`   | Read-only audit. Forwards to `condash skills status`. |

## Procedure (`/skills update`)

### 1. Audit

Run `condash skills status --json` and parse `data.items`. Each row has a `state`:

- `unchanged` — local matches manifest matches shipped → ignore.
- `outdated`  — local matches manifest but shipped has new content → safe to overwrite.
- `edited`    — local differs from manifest → may conflict with shipped version.
- `missing`   — manifest knows the file but it's gone from disk.
- `orphan`    — file present on disk but not tracked by manifest.

If the audit reports `(no installed skills)` or returns no rows, fall through to first-time install: ask the user *"No skills are installed yet — run `condash skills install` to install them all? (y / n)"*. On `y`, run that and stop.

### 2. Auto-apply `outdated`

For every `outdated` file, the CLI will safely overwrite on a plain re-install (it sees the local hash matches the manifest, so the user hasn't edited — overwriting is contractually safe). Group `outdated` rows by skill name, then run:

```bash
condash skills install <skill-1> <skill-2> ... --json
```

Parse the response. Report the resulting `updated` array to the user as a one-line "updated N file(s) across M skill(s)".

### 3. Walk `edited` files

For each `edited` row, ask the user one question. Show:

- The file path (`<conception-root>/.claude/skills/<skill>/<relPath>`).
- The diff between local and shipped. Get it via:

  ```bash
  condash skills install <skill> --dest <conception-root> --diff --dry-run
  ```

  Then read the `diffs[]` array out of the JSON, find the entry for this file, and present the diff block.

- The choice:

  > "Local has been edited. **k**eep local / **a**ccept shipped / **s**how full file / s**k**ip skill?"

  Decisions:
  - **keep local** — do nothing for this file.
  - **accept shipped** — record this `<skill>/<relPath>` pair. We'll batch-apply at step 4.
  - **show full file** — Read the shipped version (path returned by `condash skills list --json` → `<sourceDir>/<relPath>`), present, re-ask.
  - **skip skill** — drop every remaining `edited` row in this skill from the prompt loop. Useful when the user has heavily customised one skill and wants to leave the whole pack alone.

### 4. Apply `accept shipped` choices

The CLI's `--force` flag operates per skill, not per file — using it risks overwriting "keep local" files in the same skill. To keep the decision boundary at the file level, **always use the per-file write path**, even when every `edited` row in a skill was "accept shipped":

1. For each accept-shipped file: read the shipped content from the path in `condash skills list --json` (`data.skills[].files`-derived; the `sourceDir` is in the JSON), then `Write` it to the on-disk path.
2. After all per-file writes, run `condash skills install <skill> --json` (no `--force`) once per touched skill so the manifest gets refreshed — the CLI will see local matches shipped and mark each file `Unchanged`.

This loses the small efficiency of a single `--force` on whole-skill accepts, and gains correctness: the per-file branching state never has to be tracked across the prompt loop, and `--force` cannot leak into a mixed-decision skill.

### 5. Handle `missing` and `orphan`

- **`missing`** — the file vanished but is still in the manifest. Ask: *"Re-install <skill>/<relPath> or remove it from the manifest? (i / r / skip)"*. `i` re-runs `condash skills install <skill>`. `r` is a manual fix the user does — drop the entry from `.condash-skills.json`.
- **`orphan`** — file present but not tracked. This can happen if someone hand-edited the manifest. Mention it once, recommend running `condash skills install <skill>` to bring the file under tracking, move on.

### 6. Final report

Summarise what changed:

```
Skills update report:
  Auto-updated: 3 file(s) across 2 skill(s)
  Accepted shipped (resolved local edits): 2 file(s)
  Kept local: 4 file(s)
  Skipped: knowledge (1 file)
  Manifest now at version 2.4.0
```

`Manifest now at version` reads from any one entry's `shippedVersion` after the run — they'll all match within a skill that was just installed.

## Procedure (`/skills install`)

Forward to the CLI directly:

```bash
condash skills install [<name>...] [--force] [--diff] [--dry-run] [--json]
```

No editorial layer needed — the CLI's refusal-and-`--force` flow is enough for the "I know what I'm doing, just run it" case.

## Procedure (`/skills status`)

Forward to `condash skills status --json` and pretty-print the items list. Useful when the user wants to know "is anything stale?" without committing to a walk.

## Rules

- **Never delete a file** without explicit user confirmation. The CLI doesn't delete either.
- **Never edit `.condash-skills.json` by hand** — the install command owns it. Stale or corrupt manifests should be regenerated by re-running install (the `unchanged` path refreshes the entry in place).
- **Never push past a refused install** with `--force` unless the user said "accept shipped" for that specific file. The whole point of the audit is consent per file.
- Bootstrap chicken-and-egg: this skill ships **inside** the same install bundle. After `condash skills install`, this `SKILL.md` is on disk in the user's tree; from that point on `/skills update` can update itself like any other skill (the CLI's hash check still gates each write).

## Why this skill exists

The CLI alone is fine for "all-or-nothing" runs. The skill earns its keep when there are several edited files and the user wants different decisions for each. That triage is editorial — exactly what skills do well and what stuffing more flags into the CLI can't reduce to.

Out of scope (intentionally):

- Creating new skills — that's `/skill-creator`.
- Editing skill content — that's plain `Edit`.
- Publishing skills back to condash — that flows through the condash repo's PR pipeline, not this skill.
