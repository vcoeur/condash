# /projects — worktree (multi-repo branch management)

Multi-repo items use git worktrees at `<worktrees_path>/<branch>/<repo>/`, grouped by branch name. Worktrees let us work on several items simultaneously without switching branches in the main working copies at `<workspace_path>/<repo>/`. Both paths come from `configuration.json` at the conception tree root.

```
/projects worktree <action> [branch]
```

| Action            | Effect                                                                                              |
|-------------------|-----------------------------------------------------------------------------------------------------|
| `setup <branch>`  | Create worktrees + copy `.env` + install dependencies                                                |
| `remove <branch>` | Delete worktrees + cleanup `~/src/worktrees/<branch>`                                                |
| `list` / `status` | Inspect existing worktrees, show repos and dirty/clean status                                        |

## `setup <branch>`

1. **Confirm** with the user before proceeding.
2. Search `**Branch**` across all item READMEs in `projects/` — a single glob over `projects/*/*/README.md` — to find the items on this branch.
3. Collect `**Apps**` from matching items; derive unique git repos (first path segment of each app, deduplicated).
4. If no items reference the branch, ask which repos to include.
5. `mkdir -p <worktrees_path>/<branch>`.
6. For each repo:
   - Check if the branch is already checked out in the main copy (`git -C <workspace_path>/<repo> branch --show-current`).
   - If yes: tell the user that `<workspace_path>/<repo>/` must be switched to another branch first. Ask which branch, then `git -C <workspace_path>/<repo> checkout <other-branch>`.
   - Run `git -C <workspace_path>/<repo> worktree add <worktrees_path>/<branch>/<repo> <branch>`.
   - If the branch doesn't exist in the repo, ask the user whether to create it (and from which base).
7. Copy environment files: for each repo, copy `.env` / `.env.local` from the main copy (`<workspace_path>/<repo>/`) to the worktree if they exist (gitignored, not part of the checkout).
8. Install dependencies. For each repo, read its optional `install` command from `configuration.json` (the `repositories.primary[]` and `repositories.secondary[]` entries accept `install:` alongside `run:`). If set, run the command from the fresh worktree: `cd <worktrees_path>/<branch>/<repo> && <install>`. If no `install` field is configured for the repo, skip. When the install command is npm/pnpm, prefer `--cache $TMPDIR/.npm-cache` (or the pnpm equivalent) to keep the cache inside the sandbox-writable area.

9. **Final report.** End the setup reply with the absolute worktree path on its own line, ready to paste into a terminal. Format:

    ```
    Worktree ready at: <worktrees_path>/<branch>/
      <repo-1>/  <repo-2>/  ...
    Next: `cd <worktrees_path>/<branch>/<repo>`.
    ```

    Use the tilde-free absolute path so it copies cleanly.

## `remove <branch>`

1. **Confirm** with the user before proceeding.
2. For each repo dir in `<worktrees_path>/<branch>/`:
   - `git -C <workspace_path>/<repo> worktree remove <worktrees_path>/<branch>/<repo>`.
   - If uncommitted changes, warn and confirm per repo.
3. `rmdir <worktrees_path>/<branch>`.

## `list` / `status`

- List directories under `<worktrees_path>/`.
- For each: absolute worktree path (tilde-free), repos present, branch, and dirty/clean status (`git status --short`).
- Also report items currently declaring each branch (grep `**Branch**` across `projects/*/*/README.md`).
- Format each worktree block so the absolute path is the first line, copy-paste ready:

  ```
  <worktrees_path>/<branch>/   [<items declaring this branch>]
    <repo-1>/  (clean | M 3 ?? 1)
    <repo-2>/  (clean | M 1)
  ```

- **Then run the mismatch audit.** Items with an active `**Branch**` field but no corresponding worktree are flagged by the shared audit script:

  ```bash
  python3 .claude/scripts/audit.py --checks=worktrees --pretty
  ```

  Report flagged items under a `Missing worktrees:` heading after the directory listing. For each, offer to run `/projects worktree setup <branch>`. Don't auto-create — worktree setup has side effects (npm install, env file copy).

## Per-repo overrides

A repo entry in `configuration.json` may carry a `pinned_branch:` field; when set, the repo always stays on that branch and is **never** included in worktree setup, even when listed in a project's Apps. Use this for repos whose branch tracks a different axis (e.g. a benchmark harness pinned to `main`, with the version under test selected by an in-tree config file).

**Multiple items on the same branch** is fine — worktrees are per-branch, not per-item. `remove` should only run when no active item still references the branch.
