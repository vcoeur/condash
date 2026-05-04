# /projects — worktree (multi-repo branch management)

Multi-repo items use git worktrees at `<worktrees_path>/<branch>/<repo>/`, grouped by branch name. Worktrees let us work on several items simultaneously without switching branches in the main working copies at `<workspace_path>/<repo>/`. Both paths come from `configuration.json` at the conception tree root.

The CLI owns the multi-app derivation, the protected-set logic, and the per-repo `git worktree` calls. The skill just translates user intent into CLI calls.

```
/projects worktree <action> [branch]
```

| Action            | Meaning                                                                                              |
|-------------------|------------------------------------------------------------------------------------------------------|
| `setup <branch>`  | Create worktrees for every repo in the union of `**Apps**` across items declaring `<branch>`.         |
| `remove <branch>` | Remove this branch's worktrees, protected-set aware.                                                  |
| `check <branch>`  | Per-repo state for one branch (declaring items, on-disk worktrees, local branches).                   |
| `list` / `status` | All repos with their worktrees + `**Branch**` mismatch audit.                                         |

## `setup <branch>`

1. Confirm with the user.
2. `condash worktrees check <branch> --json` — preview which repos will get worktrees, what's already in place, and what's blocked (primary checkout already on the branch, pinned repos, etc.). Show this preview before acting.
3. **For every repo where `data.repos[].primaryOnBranch` is true** (the main checkout currently has the branch), the worktree can't be added until the primary moves. Ask the user which branch to switch the primary to, then `git -C <workspace_path>/<repo> checkout <other-branch>`. (This is the one operation the CLI defers to skill prose — it requires a user decision the CLI can't make.)
4. **Run setup:**

   ```bash
   condash worktrees setup <branch> [--copy-env] [--install] [--base <ref>] --json
   ```

   **Per-repo `env: [...]`** in `configuration.json` is the canonical way to copy gitignored files (e.g. `[".env", ".env.local"]`) from the primary into the new worktree. Applied unconditionally when set. `--copy-env` is a legacy fallback that copies `.env` / `.env.local` only for repos *without* an `env:` declaration.

   `--install` runs the optional `install:` command from `configuration.json`'s `repositories.{primary,secondary}[]` entry, in each fresh worktree (npm/pnpm/uv/etc.). Skipped per-repo when no `install:` is set.

   **Base ref.** The CLI reads `**Base**` from every item declaring `<branch>` and uses it as the start point for new branches. All declaring items must agree on the base (the call fails with the disagreeing slugs otherwise). `--base <ref>` overrides the README field for one-shot setups. When no item declares `**Base**` and `--base` isn't passed, new branches are created off the repo's default tip.

   The CLI:
   - reads `**Apps**` from every item declaring `<branch>` and unions the top-level repos,
   - skips repos with `pinned_branch:` (those track a different axis),
   - calls `git worktree add` per repo (creates the branch with `-b <branch> <base>` when missing),
   - blocks any repo whose declared `<base>` doesn't resolve locally — the reason field tells you to `git fetch` or create the base first,
   - returns `{created[], alreadyPresent[], blocked[], envCopied[], installRan[], base}`.

5. **Final report.** End with the absolute worktree path on its own line, ready to paste:

   ```
   Worktree ready at: <worktrees_path>/<branch>/
     <repo-1>/  <repo-2>/  ...
   Next: `cd <worktrees_path>/<branch>/<repo>`.
   ```

## `remove <branch>`

1. Confirm with the user.
2. `condash worktrees check <branch> --json` — preview the state.
3. **Run remove:**

   ```bash
   condash worktrees remove <branch> [--repo <r>...] --json
   ```

   The CLI:
   - resolves the protected set (other active items on the same branch keep their worktrees),
   - calls `git worktree remove` per non-protected repo,
   - rmdirs `<worktrees_path>/<branch>/` if it's empty after,
   - returns `{removed[], protected[], notPresent[], parentRemoved}`.

   `--repo` overrides the Apps-derivation: useful when the closing item shares the branch with another item but you only want to remove the closing item's repos.
4. **Local branch cleanup** stays in skill prose because `git branch -d` refusal must surface to the user. For each `data.removed[].repo`:

   ```bash
   git -C <workspace_path>/<repo> branch -d <branch>
   ```

   If `-d` refuses, surface the message and stop. Don't fall back to `-D`. Don't push-delete the remote — that's GitHub's responsibility (the "Delete branch" button on the merged PR).

## `check <branch>`

```bash
condash worktrees check <branch> --json
```

Returns `{branch, worktreesRoot, declaringItems[], repos[], missing[], orphan[]}`. Each repo row carries `worktreeExists`, `localBranchExists`, `primaryOnBranch`, and an optional `pinnedBranch`.

Use this before any setup/remove, and any time the user asks "what's the state of branch X?".

## `list` / `status`

```bash
condash repos list --include-worktrees --json
condash worktrees mismatch --json
```

The first call returns every configured repo with its worktrees (path / branch / primary / dirty count). The second flags items declaring `**Branch**` but missing the on-disk worktree — offer `/projects worktree setup <branch>` per missing branch.

Format the directory listing so the absolute path is the first line of each block, copy-paste ready.

## Per-repo overrides

A repo entry in `configuration.json` may carry a `pinned_branch:` field; when set, the repo always stays on that branch and is **never** included in worktree setup, even when listed in a project's Apps. The CLI honours this automatically. Use this for repos whose branch tracks a different axis (e.g. a benchmark harness pinned to `main`, with the version under test selected by an in-tree config file).

**Multiple items on the same branch** is fine — worktrees are per-branch, not per-item. `remove` honours the protected set so closing one item never yanks worktrees out from under another.
