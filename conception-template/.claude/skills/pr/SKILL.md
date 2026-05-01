---
allowed-tools: Read, Glob, Grep, Bash
description: "Open a GitHub PR from the current branch. Project-aware wrapper: handles Branch/Base resolution and the project-README timeline append; defers PR body shape to the user's personal /pr skill in ~/.claude (if installed) or prompts inline. Trigger when the user says 'open pr', 'create pr', 'make pr', or '/pr'."
---

# /pr — open a pull request (project-aware wrapper)

This skill handles the **project-side mechanics** of opening a PR for any repo listed in `configuration.json` under `repositories:`:

- Resolve the driving project from the current git branch.
- Pick the base branch via the project's `**Base**` field (or `origin/HEAD`).
- Push if needed and run `gh pr create`.
- Append a timeline entry to the driving project's README on success.

**PR body shape (title format, required sections, prohibited content) is not this skill's job.** That belongs in the user's personal `/pr` skill at `~/.claude/skills/pr/`. If installed, follow its rules. If not, prompt the user inline for title + body.

## Hard rules (workspace-side, not house-style)

- **Self-contained body.** PR body has no links to conception paths (`projects/...`, `knowledge/...`, `<conception-root>/...`), no worktree paths, no `file://` URLs. A GitHub reader cannot follow them. Internal context goes in the body as prose. Scrub before opening.
- **No full diffs** in the body — GitHub already shows them.
- **No force-push.** Never `--force` / `--force-with-lease` unless the user explicitly asks.
- **No `--no-verify` / hook skipping.**

Anything else about the body — title style, mandatory sections, prohibited trailers, language conventions — is house style and belongs in the user's global `/pr` skill or in `knowledge/conventions.md`.

## Process

1. **Read the actual diff.**

   ```bash
   git rev-parse --abbrev-ref HEAD
   git log --oneline <base>..HEAD
   git diff --stat <base>..HEAD
   git diff <base>..HEAD
   ```

   Don't guess. If the diff is huge, sample with `| head -300` and skim the rest.

2. **Pick the base branch.** Precedence (first match wins):

   | Source | Check |
   |--------|-------|
   | User call-site override | "`/pr base=develop`", "open PR to `release-4.2`", etc. |
   | Project `**Base**` field | `condash projects list --branch <current-branch> --json` returns one row per matching project with parsed `branch` / `base`. If exactly one match has a non-empty `base`, use that value. |
   | `origin/HEAD` on main checkout | `git rev-parse --git-common-dir` to find the main checkout; `git -C "$main" symbolic-ref refs/remotes/origin/HEAD` for the default. If unset, try `git remote set-head origin -a` once, then ask the user. |

   Sanity-check: `git log --oneline <base>..HEAD` must be a clean non-empty diff. Re-ask if it's empty or enormous.

3. **Compose the body.**

   - **If the user has a global `/pr` skill** at `~/.claude/skills/pr/SKILL.md`, follow its rules. Read that file before drafting.
   - **Otherwise**, ask the user for a title (one line, imperative mood) and a short body. Don't impose a template.

4. **Scrub internal links.** Grep the draft body for `<conception-root>/`, `projects/`, `knowledge/`, `~/src/`, `<workspace_path>/`, `<worktrees_path>/`, `file://`. Any hit → rewrite as prose.

5. **Confirm with the user** via `AskUserQuestion` with the full title, body, and base / head pair:

   - `Yes, open PR` — `gh pr create …`
   - `Yes, open as draft` — `gh pr create --draft …`
   - `No, let me edit` — stop.

6. **Push if needed.** If `git rev-parse --abbrev-ref --symbolic-full-name '@{u}'` fails, `git push -u origin <branch>`. Never force-push; never `--no-verify`.

7. **Open the PR.**

   ```bash
   gh pr create --base <base> --head <branch> --title "<title>" --body "<body>"
   ```

   Pass the body inline via `--body`. Avoid HEREDOC indirection.

8. **Report the URL** in plain text.

9. **Link back to the driving project** (unless the user passed `--no-project-link`). Run `condash projects list --branch <current-branch> --json` to find every project declaring this branch:

   - **One match** → append `- YYYY-MM-DD — Opened PR <url>.` to that README's timeline. Confirm in chat: *"Logged PR to `<slug>`."*.
   - **Zero matches** → say so; the user may want to create an item.
   - **Multiple matches** → `AskUserQuestion` with the list; append to the chosen README only.

   Don't change `**Status**`. Don't commit.
