---
title: Work in a branch-isolated worktree · condash
description: Give each item's branch its own checkout — create with condash worktrees setup, edit and push from the worktree, check the state, and remove it when the branch is done.
---

# Work in a branch-isolated worktree

> **Audience.** New user becoming a daily user — you've worked through Get started and the daily loop.

**When to read this.** You're about to change code in a repo condash knows, and you don't want that work landing in the primary checkout — or you want to see how an item's `branch:` field becomes a real checkout on disk.

By the end, you'll have created a worktree from the CLI, edited and pushed from it, and removed it once the branch was done — with the primary checkout untouched throughout.

## Following along

The demo tree from [A day with condash](daily-loop.md) — `tests/fixtures/conception-demo/` — declares branches on its items: `2026-04-02-fuzzy-search-v2` carries `branch: search/fuzzy-v2`, and `2026-04-12-cli-config-migration` carries `branch: config/layered-toml`. But the repos those items name don't exist on your machine, and a worktree needs a real repo — so the commands below use `<branch>` and `<repo>` placeholders. Substitute an item of your own and one of its [configured repositories](../guides/repositories-and-open-with.md), or just any branch on any repo condash already knows. If you installed a binary, follow along in your own tree from the start.

## 1. Why worktrees

The **primary checkout** — the repo as checked out under `workspace_path` — is the row the Code pane tints as the always-on reference. A **worktree** is a second, branch-isolated checkout of the same repo, created at `<worktrees_path>/<branch>/<repo>/`.

Three properties make that worth having:

- **The main checkout stays clean.** Commits you make in a worktree never appear in the primary checkout, or in any other worktree, until the branch is merged through the normal git flow.
- **Parallel work.** `search/fuzzy-v2` and `config/layered-toml` can be checked out side by side. The Code pane shows each worktree as a row inside its repo's card, each with its own dirty count and its own actions.
- **One worktree per branch per repo.** condash keys worktrees to branches, not to people or features — `condash worktrees setup <branch>` is idempotent, and the lifecycle commands all take a branch name.

## 2. Declare the branch (optional but useful)

An item's `branch:` frontmatter field tells condash which branch that item's work happens on. It is what the pin selector's "project" badge reads, and what `worktrees check` and `mismatch` are anchored to — see [The Code pane](../guides/code-pane.md). Setting it is optional (`worktrees setup` works on a bare branch name), but it is the tie that connects an item to its checkout.

## 3. Create the worktree

```bash
condash worktrees setup <branch>
```

For every configured repo — or the `--repo <r>` subset — condash creates `<worktrees_path>/<branch>/<repo>/`, checked out on `<branch>`. The base of the new branch comes from the declaring items' `base:` header fields (which must agree); with no base declared, each repo branches from its own default-branch tip (`origin/HEAD`, else local `main` / `master`, else the primary checkout's HEAD). No fetch is run, so a base ref trailing its upstream only earns a warning.

Two flags matter on day one: `--no-install` skips the per-repo `install:` hook that runs by default (and a rerun never re-runs it), and `--no-env` skips copying the repo's `env:` files from the primary checkout.

The new worktree appears as a row in the repo's card on the Code pane.

!!! success "Checkpoint — the checkout exists"

    ```bash
    ls <worktrees_path>/<branch>/<repo>
    git -C <worktrees_path>/<branch>/<repo> branch --show-current
    # <branch>
    condash worktrees list
    ```

    `worktrees list` shows the branch grouped under its primary, with its dirty status. If a repo came back under `blocked` instead (pinned, primary already on the branch, or a missing base ref), that is reported as an expected outcome — see the [worktrees reference](../reference/cli.md#worktrees) for the full verb.

## 4. Edit, commit, push from the worktree

```bash
cd <worktrees_path>/<branch>/<repo>
# … make your edits …
git add -A
git commit -m "<message>"
git push -u origin <branch>
```

The worktree is an ordinary git checkout: your editor, git hooks, and CI behave exactly as they do in the primary checkout. Because it is branch-isolated, the primary checkout and every other worktree stay blind to these commits until the branch merges. After the push, the Code pane's **Open with…** menu on that row gains **Open PR #N** when `gh` can see the branch — the same badge the item's card picks up.

!!! success "Checkpoint — the work is pushed"

    ```bash
    git -C <worktrees_path>/<branch>/<repo> log --oneline origin/<branch>..HEAD
    ```

    An empty output means everything is pushed. The Code pane row now shows no dirty pill.

## 5. Check the state

```bash
condash worktrees check <branch>
condash worktrees mismatch
```

`check` reports which items declare the branch, a per-repo set of flags (`worktree✓`, `branch✓`, `primary-on-branch`, `pinned`), and any missing or orphan worktree directories. `mismatch` compares the two directions at once: a `branch:` field with no on-disk worktree, or a worktree no item declares. The same lifecycle checks run under `condash audit --include worktrees`.

## 6. Remove the worktree when the branch is done

Once the branch is merged (or abandoned), tear the checkout down:

```bash
condash worktrees remove <branch>
```

`remove` deletes the worktrees and, when safe, the local branch. It refuses on `long_lived_branches` (default `main` and `master`, globs supported) and on pinned repos — those come back under `protected[]` and nothing is deleted. A dirty worktree needs `--force` (passed through to `git worktree remove --force`), and a leftover directory — typical with `node_modules` — needs `--force-rm`, which implies `--force` and removes the residual dir. The row disappears from the Code pane.

!!! success "Checkpoint — the worktree is gone"

    ```bash
    condash worktrees list
    ```

    The branch no longer appears, and `git worktree list` in the repo shows only the primary checkout.

## What you just learned

- A worktree is a branch-isolated checkout at `<worktrees_path>/<branch>/<repo>/`; the primary checkout stays clean until the branch merges.
- condash drives the whole lifecycle from the CLI: `worktrees setup` → `check` / `mismatch` → `remove`.
- The item's `branch:` field is the tie between an item and its checkout — the pin selector's "project" badge, `check`, and `mismatch` all read it.
- There is no `condash code` command — Code is the GUI pane; worktrees are the CLI's job.

## Where to go from here

- **[The Code pane](../guides/code-pane.md)** — how cards, rows, pinning, and worktrees display.
- **[CLI → worktrees](../reference/cli.md#worktrees)** — the full verb reference: `setup` flags, `check` flags, `remove` semantics.
- **[Repositories and open-with launchers](../guides/repositories-and-open-with.md)** — `worktrees_path`, `long_lived_branches`, and the per-repo `install:` / `env:` hooks.
