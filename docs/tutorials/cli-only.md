---
title: condash without the window · condash
description: Drive the whole lifecycle from a terminal — create, list, search, worktrees, config, close and reopen — against the same demo tree the other tutorials use.
---

# condash without the window

> **Audience.** New user — headless box, SSH session, or terminal-first. You installed condash but rarely (or never) open the window.

**When to read this.** You want to run condash from a shell: a server you reach over SSH, a cron-driven workflow, or you simply prefer the CLI. Nothing here opens a window — every command prints text and exits.

By the end, you'll have created an item, listed and searched the tree, materialised a branch worktree, read a config key, and closed and reopened an item — all from the terminal, against the same demo tree the other tutorials use.

## Following along

The demo tree from [A day with condash](daily-loop.md) — **`tests/fixtures/conception-demo/`** — is a real, populated conception: nine items across three months, a `knowledge/` tree, resources, and tasks. It is not in the installed app, only in a clone. To follow along:

```bash
# From a condash repo clone — copy it somewhere writable. condash writes
# .condash/ on first boot, so work on a copy, not the checkout.
cp -r tests/fixtures/conception-demo /tmp/condash-demo

# Point the CLI at it once per shell — or pass --conception <path> on every
# command instead.
export CONDASH_CONCEPTION_PATH=/tmp/condash-demo
```

If you installed a binary instead, run every command below in your own tree and substitute your own slugs and queries. Two caveats for the demo copy: the repos the items name (`helio`…) don't exist on your machine, so the worktrees step below uses `<branch>`/`<repo>` placeholders — see that step. And the demo ships items dated 2026-04, so a new item lands in the current month.

## 1. Create an item

The CLI's `create` is stricter than the dashboard modal: `--kind`, `--slug`, and `--title` are required; `--apps` is optional and defaults to empty.

```bash
condash projects create --kind project --slug cli-tour \
  --title "CLI tour" --apps helio
```

condash writes `projects/<YYYY-MM>/<YYYY-MM-DD>-cli-tour/README.md` from the canonical template and creates an empty `notes/` beside it. `--status` accepts `now` (default), `review`, `later`, or `backlog` — `done` is rejected: you close an item, you don't create it closed. An incident (`--kind incident`) adds `--environment`, `--severity`, and `--severity-impact`.

!!! success "Checkpoint — the item is on disk"

    ```bash
    condash projects read cli-tour
    ```

    `read` resolves the short slug and prints the README. The folder name is `2026-08-01-cli-tour` (today's date), but `cli-tour` resolves to it.

## 2. See what's active

```bash
condash projects list --status now,review
```

The demo tree's active set — four rows, status and kind and app pills in fixed-width columns. Filter by `--kind`, `--apps`, or `--branch` too, and sort with `--sort`.

For scripts, `--json` wraps the same data in a single envelope — pipe it wherever:

```bash
condash projects list --status now,review --json | jq '.data[] | select(.kind == "incident") | .title'
```

!!! success "Checkpoint — machine-readable output"

    The `jq` pipeline prints one title: `` `helio search` crashes on large logs ``. Without the `select`, `jq '.data[]'` lists all four active items with their full fields.

## 3. Search

Full-text search across projects, knowledge, resources, and skills (saved session logs only under `--scope logs`):

```bash
condash search "fuzzy search"
condash search "trigram index" --scope knowledge --limit 10
```

Hits are ranked with a snippet under each result. `--scope` narrows to one tree; the default `all` covers the four markdown scopes.

!!! success "Checkpoint — a query returns hits"

    `condash search "fuzzy search"` surfaces `2026-04-02-fuzzy-search-v2` first. A query with no matches prints `(no matches for "<query>")` and exits 0 — it's an empty result, not an error.

## 4. A branch-isolated checkout

The worktree lifecycle is the CLI's job (there is no `condash code` — the Code pane is GUI-only):

```bash
condash worktrees setup <branch>
condash worktrees check <branch>
```

`setup` creates `<worktrees_path>/<branch>/<repo>/` for every configured repo; `check` reports which items declare the branch and the per-repo state. In the demo copy the repos don't exist, so `check` answers with `worktree✗ branch✗` and a `Missing worktrees:` list — that's the expected outcome here, not an error. Against a real repo, `setup` needs the branch to exist or a `--base` to branch from — the full walkthrough (setup → edit → push → remove) is [Work in a branch-isolated worktree](worktrees.md).

!!! success "Checkpoint — check reports the shape of the branch"

    ```bash
    condash worktrees check <branch>
    ```

    You get the declaring item, its status, and one flag line per repo. `--no-install` skips the per-repo `install:` hook on `setup`, and `--no-env` skips copying `env:` files.

## 5. Read config

```bash
condash config get worktrees_path
condash config path
```

`get` reads one key (dot-separated for nested paths, `--global` / `--effective` to switch files); `path` prints both config files at once. The same `--conception` resolution chain as every other command applies.

!!! success "Checkpoint — the CLI sees the same config as the GUI"

    `config path` shows the per-machine `settings.json` and the conception's `.condash/settings.json` — the same two files the Settings modal edits.

## 6. Close and reopen

Closing is a **status flip, not a move** — a `done` item stays in its folder forever. From the CLI:

```bash
condash projects close cli-tour --summary "Tour complete"
condash projects list --status done --json | jq '.data[] | .slug'
condash projects reopen cli-tour
```

`close` sets `status: done` and appends a dated `Closed.` timeline entry (annotated from `--summary`); `reopen` moves it back to `now` with a `Reopened.` entry. The status pill in the dashboard does the same write.

!!! success "Checkpoint — the item round-trips"

    `close` prints `now → done`; the `--status done` list shows the slug; `reopen` prints `done → now`. Check the README and you'll see both timeline entries on disk — the file is the database.

## What you just learned

- The CLI speaks the same tree as the dashboard: `projects create` → `list` → `search` → `worktrees setup` → `config get` → `close`/`reopen` covers a full item lifecycle with no window.
- `--json` turns every command into a stable, scriptable envelope; `jq` is the natural companion.
- `condash` dispatches on argv: no arguments opens the dashboard, anything else runs the CLI. There is no separate CLI binary.
- The CLI is one-shot per invocation — no daemon, no watcher. The dashboard's live watcher is a GUI feature.

## Where to go from here

- **[CLI reference](../reference/cli.md)** — every noun, every verb, every flag, exit codes.
- **[Work in a branch-isolated worktree](worktrees.md)** — the full worktree lifecycle against a real repo.
- **[A day with condash](daily-loop.md)** — the same loop through the dashboard, if you ever do open the window.
- **[The Code pane](../guides/code-pane.md)** — how the worktrees you materialise display in the GUI.
