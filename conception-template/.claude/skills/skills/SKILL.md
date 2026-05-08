---
description: Install or update condash-shipped skills and templates in this conception. Wraps `condash-cli skills {status,install}` and `condash-cli templates {status,install}` (the templates verb ships partial-file regions of `CLAUDE.md`). Use after upgrading condash to pull updated content, or to do the first-time install. Walks edited files one-by-one so local customisations don't get clobbered.
---

# /skills — install and update condash-shipped skills and templates

condash ships two kinds of artefacts into a conception tree:

- **Whole-file skills** under `.claude/skills/<name>/` (the same set in this directory).
- **Marker-delimited template regions** in top-level files. Today that's just `CLAUDE.md` — the `<!-- condash:general:begin -->` … `<!-- condash:general:end -->` region carries universal pre-skill rules; the `## Specific to this conception` section that lives **outside** the markers is user-owned and never touched.

This skill is the user-facing wrapper around `condash-cli skills {list,install,status}` **and** `condash-cli templates {list,install,status}` for fetching new versions while keeping local edits you care about.

## When to use

- **First-time install** — fresh conception that doesn't yet have these skills.
- **After `npm install -g condash`** that bumps the version — pull updated skill content.
- **Audit** — "do my local skills + templates match the version condash shipped?".

For a one-off "just install everything, I haven't touched anything" run, `condash-cli skills install` and `condash-cli templates install` directly are faster. This skill earns its keep when there are local edits to triage.

## Trigger

```
/skills [update | install [<name>...] | status]
```

| Action     | Meaning |
|------------|---------|
| `update`   | (default) Audit skills + templates, then walk per-file: auto-apply safe updates, prompt on edited files. |
| `install`  | One-shot install of skills (and templates if any name matches a template path). Forwards to the CLI. |
| `status`   | Read-only audit. Forwards to `condash-cli skills status` and `condash-cli templates status`. |

## Procedure (`/skills update`)

The walk has two passes — skills first (more files, more likely to need triage), then templates. Each pass uses the same five-step shape (audit → auto-apply → walk edited → handle missing/orphan → report). The user-facing report aggregates both at the end.

### 1a. Skills audit

Run `condash-cli skills status --json` and parse `data.items`. Each row has a `state`:

- `unchanged` — local matches manifest matches shipped → ignore.
- `outdated`  — local matches manifest but shipped has new content → safe to overwrite.
- `edited`    — local differs from manifest → may conflict with shipped version.
- `missing`   — manifest knows the file but it's gone from disk.
- `orphan`    — file present on disk but not tracked by manifest.

If the audit reports `(no installed skills)` or returns no rows, fall through to first-time install: ask the user *"No skills are installed yet — run `condash-cli skills install` to install them all? (y / n)"*. On `y`, run that and continue to the templates pass.

### 1b. Templates audit

Run `condash-cli templates status --json` and parse `data.items`. Same `state` vocabulary as skills, plus one extra:

- `missing-markers` — file exists on disk but doesn't carry the `<!-- condash:<region>:begin -->` / `<!-- condash:<region>:end -->` markers, so the CLI has no region to update through.

If `data.items` is empty (or every row is `unchanged`), templates pass is a no-op — move on.

### 2. Auto-apply `outdated`

For every `outdated` row in either pass, the CLI will safely overwrite on a plain re-install (it sees the local hash matches the manifest, so the user hasn't edited — overwriting is contractually safe).

Skills:

```bash
condash-cli skills install <skill-1> <skill-2> ... --json
```

Templates:

```bash
condash-cli templates install <path-1> <path-2> ... --json
```

Parse the response. Report the resulting `updated` arrays to the user as a one-line "updated N file(s) across M skill(s)" / "updated N region(s) across M file(s)".

### 3. Walk `edited` files

For each `edited` row (skills first, then templates), ask the user one question. Show:

- The file path:
  - Skills: `<conception-root>/.claude/skills/<skill>/<relPath>`.
  - Templates: `<conception-root>/<path>` (the region inside it identified by `<region>`).
- The diff between local and shipped. Get it via:

  ```bash
  # skills
  condash-cli skills install <skill> --dest <conception-root> --diff --dry-run
  # templates
  condash-cli templates install <path> --dest <conception-root> --diff --dry-run
  ```

  Then read the `diffs[]` array out of the JSON and present the diff block for this entry.

- The choice:

  > "Local has been edited. **k**eep local / **a**ccept shipped / **s**how full file / s**k**ip?"

  Decisions:
  - **keep local** — do nothing for this entry.
  - **accept shipped** — record this entry. We'll batch-apply at step 4.
  - **show full file** — Read the shipped version (skills: path returned by `condash-cli skills list --json` → `<sourceDir>/<relPath>`; templates: read the relevant region of the shipped `conception-template/CLAUDE.md` from condash's bundle), present, re-ask.
  - **skip** — drop every remaining `edited` row in this skill (or the same template path) from the prompt loop. Useful when the user has heavily customised one and wants to leave it alone.

### 4. Apply `accept shipped` choices

The CLI's `--force` flag operates per skill / per template path, not per file / per region — using it risks overwriting "keep local" files in the same skill. To keep the decision boundary at the file level, **always use the per-file write path**, even when every `edited` row in a skill was "accept shipped":

1. For each accept-shipped skill file: read the shipped content from the path in `condash-cli skills list --json`, then `Write` it to the on-disk path.
2. After all per-file writes, run `condash-cli skills install <skill> --json` (no `--force`) once per touched skill so the manifest gets refreshed — the CLI will see local matches shipped and mark each file `Unchanged`.

For templates the boundary is per-region, not per-file. Today every shipped template has a single region, so `condash-cli templates install <path> --json` (no `--force`) safely refreshes the manifest after the user `Write`s the new region content.

### 5. Handle `missing`, `missing-markers`, and `orphan`

- **`missing`** (skills) — the file vanished but is still in the manifest. Ask: *"Re-install <skill>/<relPath> or remove it from the manifest? (i / r / skip)"*. `i` re-runs `condash-cli skills install <skill>`. `r` is a manual fix the user does — drop the entry from `.condash-skills.json`.
- **`missing`** (templates) — the file vanished but the manifest still tracks it. Ask: *"Re-install <path> (writes the whole shipped file: markers + placeholder specific section) or remove it from the manifest? (i / r / skip)"*. `i` re-runs `condash-cli templates install <path>`. `r` is a manual fix — drop the entry from the `templates` namespace of `.condash-skills.json`.
- **`missing-markers`** (templates only) — the file is on disk but the user removed the markers (perhaps they want full local control). Mention it once, recommend either re-adding the markers manually around the general section or running `condash-cli templates install <path> --force` (which writes the whole shipped file, replacing the user's markerless content). **Do not auto-force.**
- **`orphan`** — entry present but not tracked. Mention it once, recommend running the relevant `install` command to bring the entry under tracking, move on.

### 6. Final report

Summarise what changed across both passes:

```
Skills + templates update report:
  Skills:
    Auto-updated: 3 file(s) across 2 skill(s)
    Accepted shipped (resolved local edits): 2 file(s)
    Kept local: 4 file(s)
    Skipped: knowledge (1 file)
  Templates:
    Auto-updated: 1 region in CLAUDE.md
    Kept local: 0
  Manifest now at version 2.13.0
```

`Manifest now at version` reads from any one entry's `shippedVersion` after the run — they'll all match within a single condash version.

## Procedure (`/skills install`)

Forward to the CLI directly. The first positional that matches a shipped skill name routes to `condash-cli skills`; one matching a shipped template path routes to `condash-cli templates`. With no positionals, install both.

```bash
condash-cli skills install [<name>...] [--force] [--diff] [--dry-run] [--json]
condash-cli templates install [<path>...] [--force] [--diff] [--dry-run] [--json]
```

No editorial layer needed — the CLI's refusal-and-`--force` flow is enough for the "I know what I'm doing, just run it" case.

## Procedure (`/skills status`)

Forward to `condash-cli skills status --json` and `condash-cli templates status --json` and pretty-print both items lists. Useful when the user wants to know "is anything stale?" without committing to a walk.

## Rules

- **Never delete a file** without explicit user confirmation. The CLI doesn't delete either.
- **Never edit `.condash-skills.json` by hand** — the install commands own it. Stale or corrupt manifests should be regenerated by re-running install (the `unchanged` path refreshes the entry in place).
- **Never push past a refused install** with `--force` unless the user said "accept shipped" for that specific file/region. The whole point of the audit is consent per entry.
- **Never auto-force on `missing-markers`** — that overwrites the whole file. Always ask first.
- Bootstrap chicken-and-egg: this skill ships **inside** the same install bundle. After `condash-cli skills install`, this `SKILL.md` is on disk in the user's tree; from that point on `/skills update` can update itself like any other skill (the CLI's hash check still gates each write).

## Why this skill exists

The CLI alone is fine for "all-or-nothing" runs. The skill earns its keep when there are several edited files and the user wants different decisions for each. That triage is editorial — exactly what skills do well and what stuffing more flags into the CLI can't reduce to.

Out of scope (intentionally):

- Creating new skills — that's `/skill-creator`.
- Editing skill or template content — that's plain `Edit`.
- Publishing skills/templates back to condash — that flows through the condash repo's PR pipeline, not this skill.
