# CLI overview

`condash-cli` is the command-line companion to the desktop dashboard. The
.deb / AppImage / DMG / NSIS installers drop both binaries — `condash`
opens the dashboard, `condash-cli` runs against the same conception tree
from a terminal.

```
condash-cli <noun> <verb> [args] [--flags]
```

## Top-level

| Invocation | What it does |
|---|---|
| `condash` | Launch the dashboard |
| `condash-cli --help` | Top-level CLI help |
| `condash-cli --version` | Print version |

## Nouns

| Noun | Common verbs |
|---|---|
| `projects` | `list`, `read`, `search`, `validate`, `status get/set`, `close` |
| `knowledge` | `tree`, `verify`, `retrieve`, `stamp` |
| `search` | `condash-cli search "<query>" [--scope all\|projects\|knowledge]` |
| `repos` | `list [--include-worktrees]` |
| `worktrees` | `list`, `setup <branch>`, `remove <branch>`, `check <branch>` |
| `audit` | `--include lfs,binaries,cross-repo,worktrees,index` |
| `dirty` | `list`, `touch <tree>`, `clear <tree\|all>` |
| `skills` | `list`, `install`, `status` |
| `templates` | `list`, `install [<path>...]`, `status` |
| `config` | `conception-path [<path>]`, `path`, `list`, `get <key>`, `set <key> <value>` (`--global` / `--effective` on read verbs) |
| `help` | `condash-cli help <noun>` |

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
condash-cli projects list --status now,review

# Search both trees for a phrase.
condash-cli search "session cookie"

# Resolve a slug, then edit the README.
$EDITOR "$(condash-cli projects resolve my-feature)"/README.md

# Validate every item.
condash-cli projects validate --all

# Pipe to jq.
condash-cli projects list --json | jq '.data[] | select(.kind == "incident")'
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
