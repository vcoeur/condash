---
title: CLI · condash reference
description: The condash command-line surface — list projects, search, manage worktrees, install skills, all from the same binary that runs the GUI.
---

# CLI

> **Audience.** Daily user and Developer.

The same `condash` binary that opens the dashboard also serves a command-line interface. When you invoke it with a known noun, condash short-circuits the GUI and runs the CLI dispatcher instead. No Chromium boots, no window opens, output goes to stdout / stderr.

```
condash <noun> <verb> [args] [--flags]
```

The CLI exists because skills (`/projects`, `/knowledge`) and shell scripts need a programmatic surface that shares condash's parser, validator, and indexer — without re-implementing them in `bash + grep + sed`.

## At a glance

| Invocation | What it does |
|---|---|
| `condash` | Launch the packaged Electron GUI against the saved conception tree |
| `condash --help` | Print the top-level CLI help |
| `condash --version` | Print the CLI version |
| `condash <noun> <verb>` | Run a CLI verb against the resolved conception path |
| `make dev` (from source) | Watch mode: tsc + vite + Electron with `--no-sandbox` |
| `make package` (from source) | Per-OS installers under `release/` via electron-builder |

## How dispatch decides

`src/main/index.ts:isCliInvocation` scans `process.argv` for the first non-flag token. If it matches one of the CLI nouns below, condash exec's the CLI bundle. Otherwise it boots the GUI.

CLI nouns:

```
projects   knowledge   search   repos   worktrees   dirty   skills   config   help
```

Top-level `--help`, `-h`, `--version`, and `-v` always route to the CLI (they print help/version text instead of opening a window).

A typo (`condash projct list`) silently boots the GUI — the dispatcher only knows about exact noun matches.

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

Code 5 means the CLI could not resolve a conception path — pass `--conception <path>` or set one with `condash config conception-path <path>`.

## Conception-path resolution

The CLI honours the same chain as the GUI, minus the folder picker:

1. `--conception <path>` flag.
2. `conception_path` in `${XDG_CONFIG_HOME:-~/.config}/condash/settings.json` (or platform equivalent).
3. Hard error (exit 5).

`condash config conception-path` and `condash config conception-path <path>` read or write the saved value.

## Nouns

### `projects`

Item lifecycle and reads.

| Verb | What it does |
|---|---|
| `list` | List items, optionally filtered by `--status`, `--kind`, `--apps`, `--branch`, `--sort` |
| `read <slug>` | Read one item by slug or path |
| `resolve <slug>` | Resolve a slug to its absolute path |
| `search <query>` | Full-text search across items, optional `--status` / `--kind` / `--limit` |
| `validate [<slug>]` | Validate header fields against the schema; pass `--all` for the whole tree |
| `status get <slug>` / `status set <slug> <new-status>` | Read or change the `**Status**` field |
| `close <slug>` | Set status to `done` (or `--status <name>`) and append a `Closed.` timeline entry |

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
| `stamp <path>` | Add or refresh a verification stamp on a knowledge file, optionally `--where <field>` and `--date <iso>` |

### `search`

Cross-tree full-text search.

```bash
condash search "session cookie" --scope all
```

`--scope` accepts `all`, `projects`, `knowledge`. Defaults to `all`.

### `repos`

List configured repositories from `configuration.json`.

```bash
condash repos list                       # primary + secondary, no worktrees
condash repos list --include-worktrees   # add worktrees in <worktrees_path>/
```

### `worktrees`

Alias for `repos list --include-worktrees`, filtered to worktree entries. Richer surface (per-branch grouping, dirty status) is on the roadmap.

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

`condash help` prints the top-level help. `condash help <noun>` re-dispatches to the noun's `--help` path so there's only one source of help text per noun.

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
- **Mutating items beyond `status set` / `status close`.** Step toggles, note edits, and config edits are GUI-only today. Use the [`/projects` skill](skill.md) from a Claude Code session for anything richer.
- **A multi-user / server mode.** condash is single-user on purpose — see [Non-goals](../explanation/non-goals.md).

## See also

- [Configuration files](config.md) — the JSON schemas the CLI shares with the GUI.
- [Environment variables](env.md) — what the binary reads from the environment.
- [Management skill](skill.md) — Claude Code skills that wrap the CLI.
