# CLI overview

`condash` is a single binary that runs as either the desktop dashboard or
a command-line tool against the same conception tree. Invoking it with no
arguments opens the dashboard; passing any other argument dispatches to
the CLI.

```
condash <noun> <verb> [args] [--flags]
```

## Top-level

> The GUI rows below describe the **packaged Electron binary**. The `npm`/`bin` CLI bundle prints this same help but has no `gui` verb — the same binary is a dashboard with no arguments and a CLI otherwise.

| Invocation                          | What it does                                        |
|-------------------------------------|-----------------------------------------------------|
| `condash`                           | Launch the dashboard.                               |
| `condash gui [chromium-switch ...]` | Launch the dashboard with Chromium switches.        |
| `condash --help`                    | Top-level CLI help.                                 |
| `condash --version`                 | Print version.                                      |

## Nouns

### Daily

| Noun | Common verbs |
|---|---|
| `projects` | `list`, `read`, `activity`, `search`, `validate`, `status get/set`, `close`, `check-knowledge`, `reopen`, `index`, `create` |
| `knowledge` | `tree`, `verify`, `retrieve`, `stamp`, `index` |
| `search` | `condash search "<query>" [--scope all\|projects\|knowledge\|resources\|skills\|logs]` |
| `repos` | `list [--include-worktrees]` |
| `applications` | `list`, `add`, `set`, `rename`, `sync-docs`, `validate` (the `#handle` registry) |
| `worktrees` | `list`, `setup <branch>`, `remove <branch>`, `check <branch>`, `mismatch` |
| `audit` | `--include all\|lfs,binaries,cross-repo,worktrees,index,stale-index,stale-verification,check-knowledge-deferred,check-knowledge` |
| `sync` | `run` (executes the sweep), `commit <item> --message "…"` — the single-writer git sweeper for a checkout shared by parallel sessions: fetches first, fast-forwards an ahead-only remote, and refuses to push (never to commit) on divergence. Bare `condash sync` is a dry-run (prints what a sweep would commit, writes nothing); `sync run` executes. Backs the Settings → Auto-commit timer. |
| `logs` | `days` (default), `list [<day>]`, `read <sid\|path>`, `tail` |
| `skills` | `list`, `install`, `status`, `validate` |
| `mdx` | `check <path>`, `blocks` |
| `config` | `conception-path` (prints the resolved path — set it with `set lastConceptionPath <path>`), `path`, `list`, `get <key>`, `set <key> <value>`, `migrate` (`--global` / `--effective` on read verbs) |
| `help` | `condash help <noun>` |

### Maintenance

Hidden from the Daily list above but fully functional. `projects backfill-closed`, `projects rewrite-headers`, and `projects scan-promotions` are one-shot migrations marked `[internal]` in `condash --help`.

| Noun | Common verbs |
|---|---|
| `dirty` | `list`, `touch <tree>`, `clear <tree\|all>` — index-marker internals |

## Universal flags

| Flag | Meaning |
|---|---|
| `--conception <path>` | Override the conception root for this invocation |
| `--json` | Single JSON envelope on stdout |
| `--ndjson` | One JSON object per line |
| `--quiet` / `-q` | Suppress diagnostics |
| `--help` / `-h` | Help for the noun / verb |

## Examples

```bash
# What's currently active?
condash projects list --status now,review

# Search both trees for a phrase.
condash search "session cookie"

# Resolve a slug, then edit the README.
$EDITOR "$(condash projects resolve my-feature)"/README.md

# Validate every item.
condash projects validate --all

# Pipe to jq.
condash projects list --json | jq '.data[] | select(.kind == "incident")'
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | OK |
| 1 | Runtime error |
| 2 | Usage |
| 3 | Validation |
| 4 | Not found |
| 5 | No conception path |
| 6 | Ambiguous slug |

## More

The full noun-by-noun reference (every flag, every output shape) lives
online at **https://condash.vcoeur.com/reference/cli/**.
