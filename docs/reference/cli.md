---
title: CLI · condash reference
description: The condash-cli command-line surface — list projects, search, manage worktrees, install skills, the CLI companion to the desktop dashboard.
---

# CLI

> **Audience.** Daily user and Developer.

`condash-cli` is the command-line companion to the dashboard. From v2.14.0 the GUI launcher (`condash`) and the CLI launcher (`condash-cli`) are two separate entries on PATH. The .deb / AppImage / DMG / NSIS installers drop both — same packaged Electron binary underneath, different launchers. `condash-cli` runs the binary in plain-Node mode (`ELECTRON_RUN_AS_NODE=1`) against the bundled CLI script. No Chromium boots, no window opens, output goes to stdout / stderr.

```
condash-cli <noun> <verb> [args] [--flags]
```

The CLI exists because skills (`/projects`, `/knowledge`, `/tidy`) and shell scripts need a programmatic surface that shares condash's parser, validator, and indexer — without re-implementing them in `bash + grep + sed`.

## At a glance

| Invocation | What it does |
|---|---|
| `condash` | Launch the packaged Electron GUI against the saved conception tree |
| `condash-cli --help` | Print the top-level CLI help |
| `condash-cli --version` | Print the CLI version |
| `condash-cli <noun> <verb>` | Run a CLI verb against the resolved conception path |
| `make dev` (from source) | Watch mode: tsc + vite + Electron with `--no-sandbox` |
| `make package` (from source) | Per-OS installers under `release/` via electron-builder |

## How dispatch works

The two launchers are physically separate scripts. `condash` always boots the Electron GUI; if it sees a CLI noun (`projects`, `knowledge`, …) on its argv it errors with a hint to use `condash-cli` instead. `condash-cli` always runs the bundled CLI script under plain Node — it never starts Chromium.

CLI nouns:

```
projects   knowledge   search   repos   worktrees   audit   dirty   skills   templates   config   help
```

A typo (`condash-cli projct list`) reports an unknown noun and exits with code 2 (usage).

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

Code 5 means the CLI could not resolve a conception path — pass `--conception <path>` or set one with `condash-cli config conception-path <path>`.

## Conception-path resolution

The CLI honours the same chain as the GUI, minus the folder picker:

1. `--conception <path>` flag.
2. `conceptionPath` in `${XDG_CONFIG_HOME:-~/.config}/condash/settings.json` (or platform equivalent).
3. Hard error (exit 5).

`condash-cli config conception-path` and `condash-cli config conception-path <path>` read or write the saved value.

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
| `status get <slug>` / `status set <slug> <new-status>` | Read or change the `**Status**` field |
| `close <slug>` | Set status to `done` (or `--status <name>`) and append a `Closed.` timeline entry |
| `reopen <slug>` | Move `done` back to `now` (or `--status <s>`) and append a `Reopened.` timeline entry |
| `backfill-closed [--dry-run]` | Append a `Closed.` timeline entry to legacy `done` items missing one |
| `index [--dry-run] [--rewrite-aggregated]` | Regenerate every `projects/**/index.md` from the on-disk tree; clear `projects/.index-dirty` |
| `create --kind <k> --slug <s> --title "<t>" --apps "<a>"` | Create a new project / incident / document folder + README from the canonical template. Incidents add `--severity` + `--severity-impact` + `--environment` |
| `scan-promotions [--limit N]` | Walk closed items for "always / never / next time / use X" cues that suggest a knowledge promotion; print suggestions |
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
| `retrieve <query>` | Triage walk — find relevant knowledge files for a topic, by `--mode` (`names`, `bodies`, `both`) |
| `stamp <path>` | Add or refresh a verification stamp on a knowledge file, optionally `--where <field>` and `--date <iso>`. `<path>` must resolve inside the conception tree |
| `index [--dry-run] [--rewrite-aggregated]` | Regenerate every `knowledge/**/index.md` from the on-disk tree; clear `knowledge/.index-dirty` |

### `search`

Cross-tree full-text search.

```bash
condash-cli search "session cookie" --scope all
```

`--scope` accepts `all`, `projects`, `knowledge`. Defaults to `all`.

### `repos`

List configured repositories from `configuration.json`.

```bash
condash-cli repos list                       # primary + secondary, no worktrees
condash-cli repos list --include-worktrees   # add worktrees in <worktrees_path>/
```

### `worktrees`

Worktree-centric operations on top of `configuration.json`'s repositories. Both `repos list --include-worktrees` and these verbs share the same per-repo dirty/upstream cache.

| Verb | What it does |
|---|---|
| `list` | Print every worktree, grouped by primary, with branch + dirty status |
| `check <branch>` | Per-branch state: which items declare it, per-repo `worktree✓`/`branch✓`/`primary-on-branch`/`pinned` flags, missing or orphan dirs |
| `mismatch` | Report worktrees referenced by an item's `**Branch**` field that don't exist on disk (or vice versa) |
| `setup <branch> [--repo <r>...] [--copy-env] [--no-env] [--no-install] [--base <ref>]` | Create the worktree for `<branch>` in every primary (or the listed `--repo` subset). `--copy-env` copies `.env*` from the main checkout; `--no-env` skips env wiring; `--no-install` skips the per-repo `install:` hook; `--base <ref>` branches off `<ref>` instead of the repo's default branch |
| `remove <branch> [--repo <r>...]` | Tear down `<branch>` worktrees and (if safe) the local branch |

### `audit`

Tree-wide health checks. Bundles the same passes the GUI exposes via the gear modal's "Audit" button.

```bash
condash-cli audit                       # run every check
condash-cli audit --include lfs,binaries
```

| Check | What it flags |
|---|---|
| `lfs` | Files that should probably live in Git LFS but are tracked as blobs |
| `binaries` | Binary files (PDF, .docx, images > size threshold) that may need migrating |
| `cross-repo` | Cross-repo wikilinks or relative paths that escape the conception |
| `worktrees` | Same shape as `worktrees mismatch` — items declaring a `**Branch**` with no on-disk worktree, or vice versa |
| `index` | `index.md` files out of sync with the on-disk tree |

`--include <list>` restricts to a comma-separated subset.

Each issue in `--json` mode carries a `fix` object: `{ action, autoFix, ...payload }`. `autoFix: true` flags issues a wrapping skill (e.g. `/tidy`) can mechanically apply once batched confirmation is given; `autoFix: false` flags items that need human judgment. The same shape is shared with `condash-cli knowledge verify --json`'s `issues[]` array, so triage skills consume audit + verify uniformly.

### `dirty`

Read or touch the dirty-index sentinels (`projects/.index-dirty`, `knowledge/.index-dirty`).

| Verb | What it does |
|---|---|
| `list` | Show which trees have a dirty marker |
| `touch <tree>` | Mark a tree dirty — `<tree>` is `projects` or `knowledge` |
| `clear <tree\|all>` | Clear one tree's marker, or all of them |

The skills (`/projects index`, `/knowledge index`) clear these after they regenerate.

### `skills`

Manage condash-shipped Claude Code skills.

| Verb | What it does |
|---|---|
| `list` | Print every skill that ships with this condash version |
| `install [<name>...]` | Copy shipped skill files into `<conception>/.claude/skills/`. With no args, walks each file with diff + per-file confirmation |
| `status` | Compare local skills against the shipped versions and the recorded SHA256 manifest |

The manifest at `.claude/skills/.condash-skills.json` tracks the shipped version and SHA256 per file, so updates can detect local edits.

### `templates`

Manage condash-shipped *partial-file* templates — top-level files where condash owns a marker-delimited region (today: `CLAUDE.md` between `<!-- condash:general:begin -->` and `<!-- condash:general:end -->`). The text outside the markers (notably `## Specific to this conception`) is user-owned and never touched.

| Verb | What it does |
|---|---|
| `list` | Print every template that ships with this condash version, with installed/version status |
| `install [<path>...]` | Update the shipped region inside `<conception>/<path>`. With no args, runs all shipped templates. Refuses on edits without `--force`; `--diff` shows the unified diff |
| `status` | Compare local regions against the shipped versions and the recorded SHA256 (states: `unchanged` / `outdated` / `edited` / `missing` / `missing-markers` / `orphan`) |

The manifest reuses `.claude/skills/.condash-skills.json` (`templates` namespace alongside `skills`). The recorded SHA256 hashes the **content between markers, exclusive of marker lines** — so the user can move the marker pair within the file without invalidating the manifest, as long as the region content stays the same.

### `config`

Read or change condash configuration.

| Verb | What it does |
|---|---|
| `conception-path` | Print the saved conception path |
| `conception-path <path>` | Save a new conception path to `settings.json` |
| `list` | Print every key from `configuration.json` and `settings.json` (merged view) |
| `get <key>` | Print one key's value, dot-separated path (`terminal.shell`) |

`config conception-path` is the only verb that does not need an existing conception path — it sets one.

### `help`

`condash-cli help` prints the top-level help. `condash-cli help <noun>` re-dispatches to the noun's `--help` path so there's only one source of help text per noun.

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
condash-cli projects list --ndjson | jq 'select(.status == "now")'
```

When neither is set and stdout is a TTY, ANSI styling is on. When stdout is piped, styling is off automatically (or override with `--no-color`).

## Worked examples

```bash
# What's currently active?
condash-cli projects list --status now,review

# All items for one app, sorted by date.
condash-cli projects list --apps notes.vcoeur.com --sort date

# Resolve a slug, then open the README in $EDITOR.
$EDITOR "$(condash-cli projects resolve fuzzy-search-v2)"/README.md

# Validate every item in the tree.
condash-cli projects validate --all

# Search across both trees for a phrase.
condash-cli search "session cookie" --scope all --limit 20

# Update shipped skills after upgrading condash.
condash-cli skills install

# Pipe to jq.
condash-cli projects list --json | jq '.data[] | select(.kind == "incident")'
```

## Dev launch

From a clone of the repo:

```bash
make install      # one-off — npm install + electron-rebuild
make dev          # watch: esbuild rebuilds main + cli, vite serves renderer, electron reloads
```

`make dev` runs the Electron build with `--no-sandbox` to avoid per-worktree `chrome-sandbox` ownership fixes. The dev window only loads `localhost:5600` and local `file://` URLs — the threat surface is local-only. Drop `--no-sandbox` from `dev:electron` in `package.json` if you want the sandbox on, then once per worktree:

```bash
sudo chown root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

macOS and Windows are unaffected.

## What's not in the CLI

- **Headless GUI mode.** The CLI never opens a window. There's no embedded HTTP server and no browser-friendly URL to point Playwright at.
- **A daemon / background watcher.** The CLI is one-shot per invocation. The chokidar watcher runs only when the GUI is open.
- **Step toggles and note edits.** Status changes (`status set`, `close`, `reopen`), creation (`create`), and timeline backfills (`backfill-closed`) are wired into the CLI. Step toggles, note bodies, and config-file edits stay GUI-only — use the [`/projects` skill](skill.md) from a Claude Code session for anything richer.
- **A multi-user / server mode.** condash is single-user on purpose — see [Non-goals](../explanation/non-goals.md).

## See also

- [Configuration files](config.md) — the JSON schemas the CLI shares with the GUI.
- [Environment variables](env.md) — what the binary reads from the environment.
- [Management skill](skill.md) — Claude Code skills that wrap the CLI.
