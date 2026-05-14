---
title: CLI · condash reference
description: The condash command-line surface — list projects, search, manage worktrees, install skills, the CLI companion to the desktop dashboard.
---

# CLI

> **Audience.** Daily user and Developer.

`condash` is the command-line companion to the dashboard. From v2.14.0 the GUI launcher (`condash`) and the CLI launcher (`condash`) are two separate entries on PATH. The .deb / AppImage / DMG / NSIS installers drop both — same packaged Electron binary underneath, different launchers. `condash` runs the binary in plain-Node mode (`ELECTRON_RUN_AS_NODE=1`) against the bundled CLI script. No Chromium boots, no window opens, output goes to stdout / stderr.

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
| `make dev` (from source) | Watch mode: tsc + vite + Electron with `--no-sandbox` |
| `make package` (from source) | Per-OS installers under `release/` via electron-builder |

## How dispatch works

The two launchers are physically separate scripts. `condash` always boots the Electron GUI; if it sees a CLI noun (`projects`, `knowledge`, …) on its argv it errors with a hint to use `condash` instead. `condash` always runs the bundled CLI script under plain Node — it never starts Chromium.

CLI nouns:

```
projects   knowledge   search   repos   worktrees   audit   dirty   skills   templates   config   help
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

Code 5 means the CLI could not resolve a conception path — pass `--conception <path>` or set one with `condash config conception-path <path>`.

## Conception-path resolution

The CLI honours the same chain as the GUI, minus the folder picker:

1. `--conception <path>` flag.
2. `conceptionPath` in `${XDG_CONFIG_HOME:-~/.config}/condash/settings.json` (or platform equivalent).
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
| `validate [<slug>]` | Validate header fields against the schema; pass `--all` for the whole tree, or `--path <readme>` to check one file outside the resolved conception |
| `status get <slug>` / `status set <slug> <new-status>` | Read or change the `status` field |
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
condash search "session cookie" --scope all
```

`--scope` accepts `all`, `projects`, `knowledge`. Defaults to `all`.

### `repos`

List configured repositories from `condash.json`.

```bash
condash repos list                       # configured repos, no worktrees
condash repos list --include-worktrees   # add worktrees in <worktrees_path>/
```

### `worktrees`

Worktree-centric operations on top of `condash.json`'s repositories. Both `repos list --include-worktrees` and these verbs share the same per-repo dirty/upstream cache.

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

Manage Claude Code + Kimi skills. Two scopes:

- **Repo scope (default)** — installs the skills condash itself ships into a conception. Sources go to `<conception>/.agents/skills/<name>/`; compiled outputs to `<conception>/.claude/skills/<name>/` and `<conception>/.kimi/skills/<name>/`.
- **User scope (`--user`)** — compiles skillspecs the user already owns at `~/.config/agents/skills/<name>/` into `~/.claude/skills/<name>/` + `~/.kimi/skills/<name>/`. Used by the ClaudeConfig sync flow that mirrors versioned user skills out to live.

| Verb | Default scope | With `--user` |
|---|---|---|
| `list` | Print every skill condash ships | List user skillspecs under `~/.config/agents/skills/`, with host-filter status |
| `install [<name>…]` | Copy shipped sources into the conception's `.agents/skills/`, then compile to `.claude/skills/` + `.kimi/skills/`. Refuses on local edits without `--force` | Compile user sources to `~/.claude/skills/` + `~/.kimi/skills/`. No source-copy pass; outputs always regenerated; no manifest |
| `status` | Compare sources against the recorded SHA256 manifest | Compare each compiled output against a fresh in-memory compile: `ok` / `stale` / `missing` / `skipped` |
| `validate [<name>…]` | Lint each shipped skillspec | Lint each user skillspec |

`--user` is incompatible with `--dest`. The user-source root, target roots, and host-label file are env-overridable for tests (`CONDASH_USER_SKILLS_ROOT`, `CONDASH_USER_CLAUDE_ROOT`, `CONDASH_USER_KIMI_ROOT`, `CONDASH_USER_HOST_FILE`).

A user skillspec's `spec.yaml` may carry a `hosts:` list — e.g. `hosts: [vcoeur]`. When present, condash reads the current host label from `~/.claude/.host` and skips any skill whose `hosts:` does not include that label. Absent `hosts:` means install everywhere. This replaces the multi-host filter previously enforced by ClaudeConfig's `/sync-config`.

The manifest at `.claude/skills/.condash-skills.json` (repo scope only) tracks the shipped version and SHA256 per file, so updates can detect local edits.

### `templates`

Manage condash-shipped *partial-file* templates — top-level files where condash owns the body of one heading-delimited section. Two shipped today:

- `CLAUDE.md` — `## General` (markdown H2). Text outside that section (H1, intro paragraph, and the user-owned `## Specifics`) is never touched.
- `.gitignore` — `# General` (gitignore comment style). Patterns under `# Specifics` are never touched.

| Verb | What it does |
|---|---|
| `list` | Print every template that ships with this condash version, with installed/version status |
| `install [<path>...]` | Update the shipped region inside `<conception>/<path>`. With no args, runs all shipped templates. Refuses on edits without `--force`; `--diff` shows the unified diff |
| `status` | Compare local regions against the shipped versions and the recorded SHA256 (states: `unchanged` / `outdated` / `edited` / `missing` / `missing-heading` / `orphan`) |

The manifest reuses `.claude/skills/.condash-skills.json` (`templates` namespace alongside `skills`). The recorded SHA256 hashes the **body of the section, exclusive of the heading line and the trailing blank line before the next heading** — so the user can reorder content above or below the section without invalidating the manifest. Manifests written by older condash versions used `region: "condash:general"` (the HTML-comment-marker namespace); they migrate transparently to `region: "General"` on the next install.

For `.gitignore`, the heading style is gitignore-comment (`# General` / `# Specifics`) — every comment line shares the `#` prefix with the section markers, so the parser uses a fixed sibling list (`Specifics`) to detect the body end rather than treating any `# …` line as a heading. The match is whole-line, case- and whitespace-sensitive (`# General` only — `# General — shipped` or `#General` won't match).

**First-time adoption on an existing conception.** A `.gitignore` predating this change has no `# General` / `# Specifics` markers, so `templates install` reports `missing-heading` and refuses without `--force`. The recommended migration is a one-time hand-edit: wrap your existing patterns under a `# Specifics` heading and let `templates install` write the shipped `# General` block on top. `--force` is the alternative but wipes any custom patterns.

### `config`

Read or change condash configuration.

| Verb | What it does |
|---|---|
| `conception-path` | Print the saved conception path |
| `conception-path <path>` | Save a new conception path to `settings.json` |
| `path` | Print both config file paths (`settings.json` + `condash.json`) |
| `list [--global\|--effective]` | Print every key. Default reads `condash.json`; `--global` reads `settings.json`; `--effective` shows the merged view (conception ⊕ global) |
| `get <key> [--global\|--effective]` | Print one key's value, dot-separated path (`terminal.shell`). Same flag axis as `list` |
| `set <key> <value> [--global]` | Write a key. Default writes `condash.json`; `--global` writes `settings.json` |

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
- **Step toggles and note edits.** Status changes (`status set`, `close`, `reopen`), creation (`create`), and timeline backfills (`backfill-closed`) are wired into the CLI. Step toggles, note bodies, and config-file edits stay GUI-only — use the [`/projects` skill](skill.md) from a Claude Code session for anything richer.
- **A multi-user / server mode.** condash is single-user on purpose — see [Non-goals](../explanation/non-goals.md).

## See also

- [Configuration files](config.md) — the JSON schemas the CLI shares with the GUI.
- [Environment variables](env.md) — what the binary reads from the environment.
- [Management skill](skill.md) — Claude Code skills that wrap the CLI.
