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

The CLI exists because skills (`/projects`, `/knowledge`) and shell scripts need a programmatic surface that shares condash's parser, validator, and indexer — without re-implementing them in `bash + grep + sed`.

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
projects   knowledge   search   repos   applications   worktrees   audit   dirty   sync   logs   skills   mdx   config   help
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
| `activity [--begin <YYYY-MM-DD>] [--end <YYYY-MM-DD>] [--format md]` | Generic project-tree activity over a date range (default: last 7 days): every `## Timeline` beat parsed into items + dated events + day/week/month/app indices. `--json` is the reusable data layer for digest tooling and dashboards; plain output is a one-look summary; `--format md` emits a no-frills markdown digest |
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
| `check-knowledge <slug> [--record]` | Signal whether a `done` project still needs a knowledge-promotion check (read-only). `--record` appends the dated `Checked knowledge promotion` marker after a real review (the mechanical recorder the `/knowledge` skill calls — never hand-typed). No mass/backfill writer: the marker is only ever written for a project that was actually reviewed |
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

`--scope` accepts `all`, `projects`, `knowledge`, `resources`, `skills`, `logs`. Defaults to `all`, which forwards the four indexed markdown scopes (projects, knowledge, resources, skills) — terminal-session logs are disk-scanned and only searched under the explicit `--scope logs`. `--limit <n>` caps the hit count.

### `repos`

List configured repositories from `.condash/settings.json` (or the legacy `condash.json`).

```bash
condash repos list                       # configured repos
```

### `applications`

The app registry — one canonical `#handle` per app, with its `label` + `path`. The handle is the single reference used in card pills, project README `apps:` lists, the generated AGENTS.md Apps table, the colour hash, and search. Live apps are the `repositories[]` entries — **submodules included**: a `submodules[]` entry is a first-class app whose handle resolves everywhere a handle is expected, carrying its parent's handle in `parent`. Defunct handles that closed projects still reference live in `retired_apps`. Either may carry `aliases` (legacy spellings that resolve to the handle).

| Verb | What it does |
|---|---|
| `list` | List every registered app (live + retired), with handle, label, path; submodules render indented under their parent (`↳ #child`) |
| `add <handle> --path <p> [--label <l>]` | Register a new live app |
| `set <handle> [--label <l>] [--path <p>]` | Update a registered app |
| `rename <old> <new>` | Rename a handle; records the old as an alias and rewrites every project README `apps:` reference that pointed at it |
| `sync-docs` | Regenerate the Apps table in `AGENTS.md` between the `condash:apps` sentinels from the registry; submodule rows render right after their parent with a `↳`-prefixed App cell (agent-specific files like CLAUDE.md are virtual agedum renders of AGENTS.md — never written to disk) |
| `validate [--fix]` | Every project README `apps:` value must resolve to a known `#handle` (live or retired) or an existing absolute path; unknown handles exit 3, alias hits are reported with a suggested rewrite. `--fix` canonicalises every resolvable value to its `#handle` (bare names and legacy aliases alike) and leaves only the unresolvable ones for a human |

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
| `setup <branch> [--repo <r>...] [--copy-env] [--no-env] [--no-install] [--base <ref>]` | Create the worktree for `<branch>` in every primary (or the listed `--repo` subset). `--copy-env` copies `.env*` from the main checkout; `--no-env` skips env wiring; `--no-install` skips the per-repo `install:` hook; `--base <ref>` branches off `<ref>` instead of the repo's default branch. Exit code: 1 (runtime) when any per-repo `install:` command fails; blocked repos (pinned, primary-on-branch) are expected outcomes reported under `blocked` and do **not** affect the exit code |
| `remove <branch> [--repo <r>...] [--force] [--force-rm]` | Tear down `<branch>` worktrees and (if safe) the local branch. `--force` passes through to `git worktree remove --force` (deletes even if dirty); `--force-rm` implies `--force` and `rm -rf`'s the leftover dir if git deregistered the worktree but left files behind (typical with `node_modules`). Without `--force-rm`, half-removed entries are reported under `partiallyRemoved[]` so the caller can distinguish them from genuinely protected repos |

A declaring item's `apps:` tokens and explicit `--repo` values resolve to a repo by its `#handle`, its directory name, or a configured alias — so a repo whose handle differs from its directory (e.g. `#vcoeur` → `vcoeur.com`) is matched either way. The worktree directory is always named after the canonical directory name, so every spelling lands on the same `<worktrees_path>/<branch>/<dir>/`.

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
| `index` | Structural `index.md` problems under `knowledge/` — missing index, dangling links, orphan body files |
| `stale-index` | `index.md` files under `projects/` or `knowledge/` whose content has drifted from the tree (a regen would rewrite them); autofix re-runs `condash <tree> index` |
| `stale-verification` | Knowledge body files whose `**Verified:**` stamp is older than the freshness threshold (default 30 days). Shares its engine with `condash knowledge verify`, so the GUI audit pane surfaces stale stamps too. Never auto-fixed — a stale stamp means a human must reread the source, not bump the date |
| `knowledge-recheck` | Projects with a deferred knowledge promotion (a `[knowledge-recheck:pending]` timeline marker) never resolved by a later `[knowledge-recheck:done]`. Checked across all statuses, `done` included |
| `knowledge-check` | `done` projects whose last timeline entry isn't `Checked knowledge promotion` — the promotion review is missing or stale. Resolve by doing the real `/knowledge` review, then `projects check-knowledge <slug> --record`. Legacy done projects stay flagged until actually reviewed (no backfill shortcut) |

`--include <list>` restricts to a comma-separated subset (or `all`).

Each issue in `--json` mode carries a `fix` object: `{ action, autoFix, ...payload }`. `autoFix: true` flags issues a wrapping skill (e.g. `/knowledge verify`) can mechanically apply once batched confirmation is given; `autoFix: false` flags items that need human judgment. The same shape is shared with `condash knowledge verify --json`'s `issues[]` array, so triage skills consume audit + verify uniformly.

### `dirty`

Read or touch the dirty-index sentinels (`projects/.index-dirty`, `knowledge/.index-dirty`).

| Verb | What it does |
|---|---|
| `list` | Show which trees have a dirty marker |
| `touch <tree>` | Mark a tree dirty — `<tree>` is `projects` or `knowledge` |
| `clear <tree\|all>` | Clear one tree's marker, or all of them |

The skills (`/projects index`, `/knowledge index`) clear these after they regenerate.

### `sync`

The conception's **single writer** to git. When several agent sessions work in one checkout, each on its own item, and each commits its own work, they corrupt each other three ways:

1. **The git index is shared process-wide.** Session A runs `git add`, session B runs `git commit` a second later, and B's commit carries A's staged files. Path-scoping B's commit doesn't help — the pathspec scopes what is matched, not what is committed out of the index.
2. **`index.md` files are fan-in.** `projects/index.md` and `projects/<YYYY-MM>/index.md` are regenerated from every item's front-matter, so whoever commits one commits every other session's status flips. No session considers them theirs, so they sit dirty.
3. **Pushes race.** Concurrent pushes reject non-fast-forward, and the reflex `git pull --rebase` rewrites the working tree under a session that is mid-edit.

A conception has one author and no CI, so if exactly one process ever commits, all three dissolve at once: one writer means no index race, the writer owns `index.md` and regenerates it before committing, and nothing else writes the remote so every push is a fast-forward.

| Verb | What it does |
|---|---|
| `run [--dry-run] [--no-push] [--quiet-period <secs>]` | The sweeper. The default verb — bare `condash sync` runs it |
| `commit <item> --message "<subject>" [--dry-run] [--no-push]` | Manual milestone commit for one item, under the same lock |

`run`, in order:

1. Takes an exclusive, **non-blocking** lock at `<git-dir>/condash-sync.lock`. If held, exits 0 — the next tick picks the work up.
2. Refuses (exit 3) mid-merge, mid-rebase, mid-cherry-pick, mid-revert, or with a conflicted tree.
3. Considers **every tracked, non-gitignored change** in the tree. `git status` already omits gitignored paths, so the per-harness *generated* views (`.claude/*`, `.pi/*`, `CLAUDE.md`, `.kimi/`, …), `resources/local/`, `projects/**/local/`, and the `.index-dirty` sentinels never even reach the sweeper. Everything that remains gets a committer: item and `knowledge/` paths as today, and anything outside those two trees — root `AGENTS.md`, `.agents/**`, config files (`opencode.json`, `.claude/settings.json`, …), `resources/`, `tasks/` — swept into one `meta: sync` commit. That is the point: once a checkout adopts "`sync` is the only committer," any file the sweeper skipped would have *no* committer at all, so it skips nothing but the gitignored. A malformed path *inside* a tree (say `projects/stray.md`) is the one exception — reported `unresolved`, never committed, because a misplaced file is a mistake worth surfacing.
4. **Skips any path whose mtime is younger than the quiet period** (default 90 s). A session mid-write is left alone and swept next tick — the property that makes `run` safe on a timer while sessions are live. `--quiet-period 0` disables it.
5. Regenerates the indexes if either `.index-dirty` marker is present — **unless step 4 held an item or knowledge path back**. An index is fan-in over every item, so regenerating one while an item is still mid-write would commit a `projects/index.md` whose bullets point at a directory the sweep deliberately didn't commit. When that happens the whole index step is deferred, the marker stays set, and the next settled tick does it. (Only quiet-period skips defer, and only *tree* ones — a mid-write `AGENTS.md` is never referenced by an index, and an `unresolved` path never becomes eligible, so neither may wedge the indexes forever.)
6. Groups eligible paths: one commit per item (`<YYYY-MM-DD-slug>: sync`), one for knowledge (`knowledge: sync`), one for every non-tree change (`meta: sync`), one for the regenerated indexes (`indexes: sync`) — the index commit always lands after the item commits it refers to. One exception to the item subject: a sweep that introduces the item README's `Closed.` timeline entry (comparing HEAD to the worktree) is that item's **close**, and gets a synthesized `Close <slug>. Outcome: <summary>.` milestone subject — the summary comes from the closing entry itself, so closing an item is write-files-only.
7. Pushes, when the branch ends up ahead of its upstream.

`commit` takes the same lock and commits just that item's paths under a caller-chosen subject line, and cannot race the sweeper. Two differences from `run`: no quiet period applies, and a held lock is an error (exit 3) rather than a silent skip — a milestone that quietly did nothing is worse than one that says so. There is no `-m` short flag; condash's short flags are boolean-only. It is a **manual escape hatch for humans**: agents never run sync verbs — the sweeper synthesizes the close milestone subject on its own when it sweeps the closing entry.

A rejected push is a **warning, not a failure** (exit stays 0, `pushError` is set in `--json`). The commits are local, and the next `run` retries because the push condition is "ahead of upstream", not "we just committed". `sync` never rebases and never force-pushes — that would be contention mechanism 3.

Paths under `projects/` or `knowledge/` that match no known shape (say `projects/stray.md`) are reported under `skipped[]` with reason `unresolved` and are never committed. Every other tracked, non-gitignored change is committed — under its item, `knowledge`, or `meta`. To keep a file out of sync, gitignore it.

**The CLI has no scheduler** — `sync run` is the deliverable, and headless scheduling is the operator's business. A `systemd --user` timer:

```ini
# ~/.config/systemd/user/condash-sync.service
[Service]
Type=oneshot
ExecStart=%h/.local/bin/condash sync run --conception %h/src/vcoeur/conception

# ~/.config/systemd/user/condash-sync.timer
[Timer]
OnBootSec=2min
OnUnitActiveSec=2min

[Install]
WantedBy=timers.target
```

**The GUI does have one** — an opt-in auto-commit engine that runs `sync run` on a timer while a conception is open (**Settings → Auto-commit**, off by default). It's the same sweep with the same safety; it just needs the app running. Use the timer above when you want commits to happen headless too. See [`autoSync`](config.md#auto-commit) in the config reference.

### `logs`

Navigate the per-conception terminal-session logs that the GUI writes under `.condash/logs/YYYY/MM/DD/HHMMSS-<sid>.txt` (a `# condash:` JSON header line, the rendered xterm buffer, and — once the pty exits — a `# condash:` footer line). The noun is **read-only**: it never deletes a log (deletion stays a Logs-pane affordance). Logging is opt-in (`terminal.logging.enabled`), so the tree is empty until you turn it on.

| Verb | What it does |
|---|---|
| `days [--month YYYY-MM] [--year YYYY]` | List days that hold sessions (newest first) with session count + size. The default verb — bare `condash logs` runs it |
| `list [<day>] [filters]` | List sessions, newest spawn-time first |
| `read <sid\|day/sid\|path> [selector]` | Output a session transcript |
| `tail [--sid s,s] [--repo n] [--lines n] [--all]` | Last lines (default 20) of the active tabs |

`list` filters: `--since <when>` / `--until <when>` (by spawn time), `--modified-since <when>` (by file mtime — catches a long-running session that spawned earlier but is still being written), `--repo <name>`, `--active` (only sessions with no footer — still running), `--sid <prefix>`, `--limit <n>`. A `<when>` is an ISO date (`2026-05-30`) or datetime (`2026-05-30T14:00`), a relative span (`30m`, `2h`, `3d`, `1w` — ago from now), or `today` / `yesterday`.

Every `list` row and `read` result carries a **`kind`**: `transcript` (the in-band OSC agent transcript — append-only, so a `--from-byte` cursor advanced to `nextByte` is reliable and lands on a message boundary) or `grid` (a rendered xterm-buffer snapshot — a plain shell's scrollback or an alternate-screen TUI's repainted frame, where an arbitrary byte-offset diff can be noisy). The writer stamps `kind` in the header; logs written before the field fall back to a first-line heuristic.

`read` selectors are mutually exclusive: `--head <n>`, `--tail <n>`, `--lines <a-b>` (inclusive 1-based; also `a-` to end, or `a` for one line), `--from-byte <n>` (raw bytes from offset `n` to EOF — the stateless "what changed since I last looked" cursor; the JSON `nextByte` is the offset to store for next time, and `rotated: true` flags a janitor-trimmed file), `--meta` (only the parsed header/footer). `--with-meta` keeps the `# condash:` lines in the body. `--redact` masks obvious secret shapes (provider API keys, bearer tokens, JWTs, secret-named assignments, PEM private keys) in the emitted body — do the masking once here rather than in every consumer that ships a slice off-machine. A bare `<sid>` is prefix-matched across days, newest first — an ambiguous prefix exits 6.

`tail` is the "what's live right now" glance: it prints the last lines of every **active** session (no footer). `--all` includes ended sessions; `--sid` / `--repo` narrow the set; `--redact` masks secrets as on `read`.

```
condash logs list --since today --active
condash logs read t-a1b2c3d4 --tail 40
condash logs read t-a1b2 --from-byte 31044 --json    # delta since the stored cursor
condash logs read t-a1b2 --from-byte 31044 --redact  # … with secrets masked
condash logs tail --repo condash
```

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

### `mdx`

Plan/review MDX documents (`plan.mdx` notes authored by the `/visual-plan` and
`/visual-review` skills — see the [plan documents guide](../guides/plan-documents.md)).

| Verb | Behaviour |
|------|-----------|
| `check <path>` | Validate a `.mdx` file (or a folder holding `plan.mdx`) against the block schemas the in-app viewer renders. Errors exit 3 (validation) with per-issue line numbers; unsupported `canvas.mdx` / `prototype.mdx` siblings warn |
| `blocks` | Print the block-vocabulary reference generated from the registry — the same content the `visual-plan` skill ships as `references/blocks.md` (drift-tested) |

The parser, the zod schemas, the viewer, and this verb are one code path
(`src/shared/plan-blocks/`), so a green `check` means the document parses and
matches the viewer by construction. It does not guarantee visible content —
`check` warns on a block with an empty payload (an unfolded diagram, an empty
`code`/`diff`, a wireframe with no html).

### `config`

Read or change condash configuration.

| Verb | What it does |
|---|---|
| `conception-path` | Print the resolved conception path |
| `path` | Print both config file paths (`settings.json` + `.condash/settings.json`) |
| `list [--global\|--effective]` | Print every key. Default reads `.condash/settings.json` (with legacy `condash.json` / `configuration.json` as read fallbacks); `--global` reads `settings.json`; `--effective` shows the merged view (conception ⊕ global) |
| `get <key> [--global\|--effective]` | Print one key's value, dot-separated path (`terminal.shell`). Same flag axis as `list` |
| `set <key> <value> [--global]` | Write a key. Default writes `.condash/settings.json`; `--global` writes the global `settings.json` |
| `migrate` | Copy legacy `condash.json` / `configuration.json` content into `.condash/settings.json`, tombstone the source, and gitignore `.condash/` (the same auto-migration the GUI runs on first open) |

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
