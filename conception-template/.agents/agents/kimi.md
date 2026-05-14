### Kimi

When operating inside this conception with Kimi Code CLI, the following are auto-approved without per-action confirmation:

- Read, edit, and create any file inside the conception directory (`projects/`, `knowledge/`, `notes/`, and any other path under the conception root).
- Run `condash` with any arguments.
- Edit code in `<workspace_path>/<repo>/` (main app checkouts) and `<worktrees_path>/<branch>/<repo>/` (PR worktrees).
- Run any shell command needed to test or verify app behaviour (test runners, dev servers, build commands, package installs).

**Why:** Kimi Code CLI's default permission boundary treats the working directory as the only safe zone. Conception work routinely requires touching sibling repos, running the condash CLI, and executing tests. A single explicit rule removes friction that would otherwise require the user to confirm every file write or command execution.
