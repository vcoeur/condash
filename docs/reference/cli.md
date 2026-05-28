---
title: CLI · condash reference
description: The condash command-line surface — list projects, search, manage worktrees, install skills, the CLI companion to the desktop dashboard.
---

# CLI

> **Audience.** Daily user and Developer.

`condash` is the command-line companion to the dashboard. A single binary on PATH dispatches both modes: bare `condash` (no args, or `condash gui`) launches the packaged Electron GUI; `condash <noun> <verb> [args]` runs the bundled CLI script with no window — output goes to stdout / stderr.

```
condash <noun> <verb> [args] [--flags]
```

The CLI exists because skills (`/projects`, `/knowledge`, `/tidy`) and shell scripts need a programmatic surface that shares condash's parser, validator, and indexer — without re-implementing them in `bash + grep + sed`.

## At a glance

| Invocation | What it does |
|---|---|
| `condash` | Launch the packaged Electron GUI against the saved conception tree |
| `condash --help` | Print the top-level CLI help |
| `condash --version` | Print the CLI version |
| `condash <noun> <verb>` | Run a CLI verb against the resolved conception path |

For running condash from a source clone (`make install`, `make dev`, `make package`), see [Dev launch](../guides/dev-launch.md).

## How dispatch works

One binary, one launcher: the `condash` entry on PATH inspects its argv. With no positional argument (or with the literal `gui` first), it boots the Electron GUI. With a known CLI noun (`projects`, `knowledge`, …) first, it runs the bundled CLI script in plain-Node mode (no Chromium, no window). An unknown first positional reports an unknown noun and exits with code 2 (usage).

CLI nouns:

```
projects   knowledge   search   repos   applications   worktrees   audit   dirty   skills   config   help
```

A typo (`condash projct list`) reports an unknown noun and exits with code 2 (usage).

## Universal flags

Available on every noun:

| Flag | Meaning |
|---|---|
| `--conception <path>` | Override the conception root for this invocation only |
| `--json` | Emit a single JSON envelope on stdout |
| `--ndjson` | Emit one JSON object per line (streaming-friendly) |
| `--quiet`, `-q` | Suppress diagnostics on stderr |
| `--no-color` | Disable ANSI styling |
| `--help`, `-h` | Show help for this noun / verb |
| `--version`, `-v` | Show version |

`--json` and `--ndjson` are mutually exclusive. When neither is set, stdout is human-readable text.

## Exit codes

```
0  ok
1  runtime
2  usage
3  validation
4  not-found
5  no-conception
6  ambiguous
```

Code 5 means the CLI could not resolve a conception path — pass `--conception <path>` or set `lastConceptionPath` via `condash config set lastConceptionPath <path>`.

## Conception-path resolution

The CLI honours the same chain as the GUI, minus the folder picker:

1. `--conception <path>` flag.
2. `CONDASH_CONCEPTION_PATH` environment variable (legacy alias `CONDASH_CONCEPTION` still accepted).
3. `CLAUDE_PROJECT_DIR` environment variable (back-compat for Claude Code sessions).
4. Walk-up from the current working directory looking for `.condash/settings.json`, `condash.json`, or `configuration.json` next to a `projects/` directory.
5. `lastConceptionPath` in `${XDG_CONFIG_HOME:-~/.config}/condash/settings.json` (or platform equivalent).
6. Hard error (exit 5).

`condash config conception-path` prints the currently resolved conception path. To change it, use `condash config set lastConceptionPath <path>`.

## Nouns

### `projects`

Item lifecycle and reads.

| Verb | What it does |
|---|---|
| `list` | List items, optionally filtered by `--status`, `--kind`, `--apps`, `--branch`, `--sort` |
| `read <slug>` | Read one item by slug or path |
| `resolve <slug>` | Resolve a slug to its absolute path |
| `search <query>` | Full-text search across items, optional `--status` / `--kind` / `--limit` |
| `validate [<slug>]` | Validate header fields against the schema; pass `--all` for the whole tree, or `--path <readme>` to check one file outside the resolved conception |
| `status get <slug>` / `status set <slug> <new-status>` | Read or change the `status` field |
| `close <slug>` | Set status to `done` (or `--status <name>`) and append a `Closed.` timeline entry |
| `reopen <slug>` | Move `done` back to `now` (or `--status <s>`) and append a `Reopened.` timeline entry |
| `backfill-closed [--dry-run]` | Append a `Closed.` timeline entry to legacy `done` items missing one |
| `index [--dry-run] [--rewrite-aggregated]` | Regenerate every `projects/**/index.md` from the on-disk tree; clear `projects/.index-dirty` |
| `create --kind <k> --slug <s> --title "<t>" --apps "<a>" [--status <s>]` | Create a new project / incident / document folder + README from the canonical template. `--status` accepts `now \| review \| later \| backlog` (default `now`); `done` is rejected — use `condash projects close` to flip status to done. Incidents add `--severity` + `--severity-impact` + `--environment` |
| `scan-promotions <slug>` | Walk a closed item's notes for "always / never / next time / use X" cues that suggest a knowledge promotion; print suggestions |
| `rewrite-headers [--dry-run]` | One-shot migration of legacy bold-prose headers to YAML frontmatter; idempotent (already-YAML files are no-ops). Skips any README whose body has unexpected content between the meta block and the first `##` heading |

Slug forms accepted:

- Full dated: `2026-04-17-foo` — exact folder name, minus the month dir.
- Short: `foo` — any part of the slug after the date prefix.
- Month-qualified: `2026-04/2026-04-17-foo`.

### `knowledge`

Knowledge-tree operations.

| Verb | What it does |
|---|---|
| `tree` | Render the knowledge index as a tree, depth-limited via `--depth` |
| `verify` | Audit verification stamps (`**Verified:** YYYY-MM-DD`) and report stale ones |
| `retrieve <query>` | Triage walk — find relevant knowledge files for a topic, by `--mode` (`triage`, `grep`, `both`) |
| `stamp <path>` | Add or refresh a verification stamp on a knowledge file, optionally `--where <field>` and `--date <iso>`. `<path>` must resolve inside the conception tree |
| `index [--dry-run] [--rewrite-aggregated]` | Regenerate every `knowledge/**/index.md` from the on-disk tree; clear `knowledge/.index-dirty` |

### `search`

Cross-tree full-text search.

```bash
condash search "session cookie" --scope all
```

`--scope` accepts `all`, `projects`, `knowledge`. Defaults to `all`.

### `repos`

List configured repositories from `.condash/settings.json` (or the legacy `condash.json`).

```bash
condash repos list                       # configured repos
```

### `applications`

The app registry — one canonical `@handle` per app, with its `label` + `path`. The handle is the single reference used in card pills, project README `apps:` lists, the generated AGENTS.md Apps table, the colour hash, and search. Live apps are the `repositories[]` entries; defunct handles that closed projects still reference live in `retired_apps`. Either may carry `aliases` (legacy spellings that resolve to the handle).

| Verb | What it does |
|---|---|
| `list` | List every registered app (live + retired), with handle, label, path |
| `add <handle> --path <p> [--label <l>]` | Register a new live app |
| `set <handle> [--label <l>] [--path <p>]` | Update a registered app |
| `rename <old> <new>` | Rename a handle; records the old as an alias and rewrites every project README `apps:` reference that pointed at it |
| `sync-docs` | Regenerate the Apps table in `AGENTS.md` between the `condash:apps` sentinels from the registry (agent-specific files like CLAUDE.md are virtual agedum renders of AGENTS.md — never written to disk) |
| `validate [--fix]` | Every project README `apps:` value must resolve to a known `@handle` (live or retired) or an existing absolute path; unknown handles exit 3, alias hits are reported with a suggested rewrite. `--fix` canonicalises every resolvable value to its `@handle` (bare names and legacy aliases alike) and leaves only the unresolvable ones for a human |

```bash
condash applications list --json
condash applications validate            # exit 3 on an unresolved reference
condash applications rename fovea fovea-web
```

### `worktrees`

Worktree-centric operations on top of the conception's configured repositories (`.condash/settings.json`, or legacy `condash.json`).

| Verb | What it does |
|---|---|
| `list` | Print every worktree, grouped by primary, with branch + dirty status |
| `check <branch>` | Per-branch state: which items declare it, per-repo `worktree✓`/`branch✓`/`primary-on-branch`/`pinned` flags, missing or orphan dirs |
| `mismatch` | Report worktrees referenced by an item's `branch` field that don't exist on disk (or vice versa) |
| `setup <branch> [--repo <r>...] [--copy-env] [--no-env] [--no-install] [--base <ref>]` | Create the worktree for `<branch>` in every primary (or the listed `--repo` subset). `--copy-env` copies `.env*` from the main checkout; `--no-env` skips env wiring; `--no-install` skips the per-repo `install:` hook; `--base <ref>` branches off `<ref>` instead of the repo's default branch |
| `remove <branch> [--repo <r>...] [--force] [--force-rm]` | Tear down `<branch>` worktrees and (if safe) the local branch. `--force` passes through to `git worktree remove --force` (deletes even if dirty); `--force-rm` implies `--force` and `rm -rf`'s the leftover dir if git deregistered the worktree but left files behind (typical with `node_modules`). Without `--force-rm`, half-removed entries are reported under `partiallyRemoved[]` so the caller can distinguish them from genuinely protected repos |

### `audit`

Tree-wide health checks. Bundles the same passes the GUI exposes via the gear modal's "Audit" button.

```bash
condash audit                       # run every check
condash audit --include lfs,binaries
```

| Check | What it flags |
|---|---|
| `lfs` | Files that should probably live in Git LFS but are tracked as blobs |
| `binaries` | Binary files (PDF, .docx, images > size threshold) that may need migrating |
| `cross-repo` | Cross-repo wikilinks or relative paths that escape the conception |
| `worktrees` | Same shape as `worktrees mismatch` — items declaring a `branch` with no on-disk worktree, or vice versa |
| `index` | `index.md` files out of sync with the on-disk tree |
| `knowledge-recheck` | Projects with a deferred knowledge promotion (a `[knowledge-recheck:pending]` timeline marker) never resolved by a later `[knowledge-recheck:done]`. Checked across all statuses, `done` included |

`--include <list>` restricts to a comma-separated subset.

Each issue in `--json` mode carries a `fix` object: `{ action, autoFix, ...payload }`. `autoFix: true` flags issues a wrapping skill (e.g. `/tidy`) can mechanically apply once batched confirmation is given; `autoFix: false` flags items that need human judgment. The same shape is shared with `condash knowledge verify --json`'s `issues[]` array, so triage skills consume audit + verify uniformly.

### `dirty`

Read or touch the dirty-index sentinels (`projects/.index-dirty`, `knowledge/.index-dirty`).

| Verb | What it does |
|---|---|
| `list` | Show which trees have a dirty marker |
| `touch <tree>` | Mark a tree dirty — `<tree>` is `projects` or `knowledge` |
| `clear <tree\|all>` | Clear one tree's marker, or all of them |

The skills (`/projects index`, `/knowledge index`) clear these after they regenerate.

### `skills`

Install (or refresh) what condash ships into a conception. condash does exactly two things with agent config:

- **Ship skill sources** under `<conception>/.agents/skills/<name>/` — `SKILL.md` plus any task `.md` files and an optional `SKILL.<harness>.md` overlay, placed verbatim with refuse-on-edit. condash does **not** compile skills to per-harness directories; the harness launcher renders them per agent at run time.
- **Maintain the `AGENTS.md` marker region** at the conception root — regenerate everything from line 1 through `<!-- end condash agents -->`, preserve the `## Specifics` tail verbatim.

condash no longer ships any top-level file — `.gitignore` was dropped after v4.0.1, so the conception's `.gitignore` is entirely user-owned.

| Verb | What it does |
|---|---|
| `list` | Print every shipped skill, with install status |
| `install [<skill\|AGENTS.md>…]` | Copy shipped skill sources into `.agents/skills/` and regenerate the `AGENTS.md` head. With no positionals, installs everything. Refuses on locally-edited sources without `--force` |
| `status` | Per-skill install state (tracked, edited, missing on source) |
| `validate [<skill>…]` | Lint shipped skills — each must have a `SKILL.md` carrying a `description` |

Install flags: `--dest <path>` (retarget the install dir; default the resolved conception or cwd), `--force` (override refuse-on-edit), `--diff` (show a unified diff per refused item), `--dry-run` (report without writing), `--prune` (drop manifest entries whose shipped source has been removed).

Skill sources flow through one manifest at `.agents/.condash-skills.json` (v3 schema: `skills.<name>.source` per source file; a `files.<path>` namespace is retained only to reconcile legacy top-level entries such as a `.gitignore` shipped by condash ≤ 4.0.1), tracking the shipped version and SHA256 per file so a re-install can detect local edits. A per-skill entry left by an earlier schema (one with no `source` map) is re-seeded on read, so upgrading condash never crashes the install. `AGENTS.md` is deterministic (the marker is the boundary) and not manifest-tracked.

### `config`

Read or change condash configuration.

| Verb | What it does |
|---|---|
| `conception-path` | Print the resolved conception path |
| `path` | Print both config file paths (`settings.json` + `.condash/settings.json`) |
| `list [--global\|--effective]` | Print every key. Default reads `.condash/settings.json` (with legacy `condash.json` / `configuration.json` as read fallbacks); `--global` reads `settings.json`; `--effective` shows the merged view (conception ⊕ global) |
| `get <key> [--global\|--effective]` | Print one key's value, dot-separated path (`terminal.shell`). Same flag axis as `list` |
| `set <key> <value> [--global]` | Write a key. Default writes `.condash/settings.json`; `--global` writes the global `settings.json` |

`config conception-path` is the only verb that does not need an existing conception path — it prints the resolved one.

### `help`

`condash help` prints the top-level help. `condash help <noun>` re-dispatches to the noun's `--help` path so there's only one source of help text per noun. `condash <noun> help <verb>` is the per-verb alias — equivalent to `condash <noun> <verb> --help`.

Per-verb help is always printable: `condash <noun> <verb> --help` short-circuits before any required-flag or positional check, so you can read the usage without filling in arguments.

### Unknown-flag suggestions

When you mistype a flag, condash reports `Unknown flag: --foo (did you mean --bar?)` if a valid flag for the same noun is within Levenshtein distance ≤ 2. The suggestion pool is the union of every flag known to the noun (across its verbs), so a typo of a sibling-verb flag still gets surfaced. The check runs **before** required-flag validation — so `condash projects create --app foo` reports the typo of `--apps`, not "missing --apps".

## Output modes

Default output is human-readable text aligned for a terminal. `--json` emits a single envelope:

```json
{
  "ok": true,
  "data": [/* … */],
  "warnings": []
}
```

`--ndjson` emits one object per line — useful for piping into `jq`:

```bash
condash projects list --ndjson | jq 'select(.status == "now")'
```

When neither is set and stdout is a TTY, ANSI styling is on. When stdout is piped, styling is off automatically (or override with `--no-color`).

## Worked examples

```bash
# What's currently active?
condash projects list --status now,review

# All items for one app, sorted by date.
condash projects list --apps notes.vcoeur.com --sort date

# Resolve a slug, then open the README in $EDITOR.
$EDITOR "$(condash projects resolve fuzzy-search-v2)"/README.md

# Validate every item in the tree.
condash projects validate --all

# Search across both trees for a phrase.
condash search "session cookie" --scope all --limit 20

# Update shipped skills after upgrading condash.
condash skills install

# Pipe to jq.
condash projects list --json | jq '.data[] | select(.kind == "incident")'
```

## What's not in the CLI

- **Headless GUI mode.** The CLI never opens a window. There's no embedded HTTP server and no browser-friendly URL to point Playwright at.
- **A daemon / background watcher.** The CLI is one-shot per invocation. The chokidar watcher runs only when the GUI is open.
- **Step toggles and note edits.** Status changes (`status set`, `close`, `reopen`), creation (`create`), and timeline backfills (`backfill-closed`) are wired into the CLI. Step toggles, note bodies, and config-file edits stay GUI-only — use the [`/projects` skill](skill.md) from a Claude Code session for anything richer.
- **A multi-user / server mode.** condash is single-user on purpose — see [Non-goals](../explanation/non-goals.md).

## See also

- [Configuration files](config.md) — the JSON schemas the CLI shares with the GUI.
- [Environment variables](env.md) — what the binary reads from the environment.
- [Management skill](skill.md) — Claude Code skills that wrap the CLI.
