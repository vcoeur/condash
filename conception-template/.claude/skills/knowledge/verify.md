# /knowledge — verify (conception-wide audit)

Audit the conception tree for convention drift: stale `**Verified:**` stamps, LFS coverage gaps, large plain-git binaries, dangling cross-repo references from sibling apps pointing into conception, and `knowledge/**/index.md` orphans/danglers. Every check lives in `condash` — there is no separate Python script.

Trigger: `/knowledge verify`.

## Procedure

1. **Run the verification + audit in two calls:**

   ```bash
   condash knowledge verify --max-age 30 --json
   condash audit --include lfs,binaries,cross-repo,worktrees,index --json
   ```

   Stamps are owned by `condash knowledge verify` (returns `data.stale[]`, `data.fresh`, `data.unstamped[]`, `data.maxAge`). Everything else lives under `condash audit` (returns `{summary, issues[]}` with one entry per finding). Both are pure read-only.

2. **Triage by check and severity.**

   `condash audit` issues carry severity `error` (essential file missing — investigate first) > `warn` (real drift) > `info` (heuristic or freshness signal, defer unless asked).

3. **Report the punch-list** and handle each check per the rules below. Always confirm a batch of fixes with the user before writing — never auto-edit one issue, ask, then auto-edit the next.

## Handling by check

### Stale stamps (`condash knowledge verify` → `data.stale[]`)

Stamps `**Verified:** YYYY-MM-DD <where>` older than `--max-age` days. Each row carries `relPath`, `line`, `verifiedAt`, `where`, `ageDays`. List as a punch-list. For each stale stamp, optionally verify the SHA is still reachable:

```bash
git -C <workspace_path>/<app> rev-parse --verify <shortsha>
```

If unreachable, mark `SHA missing` — the fact may need re-verifying even if still correct. **Never auto-bump** — a bumped stamp without a re-read is a lie about freshness. Suggest the user re-read the current state of each referenced app and refresh each stale claim via `condash knowledge stamp <path> --where <new-where>`.

### `lfs` (auto-fix candidate, with confirmation)

A `*.pdf|*.png|*.jpg|*.jpeg` under `projects/` is not tracked by git-lfs. Group the paths, report sizes (in `fix.sizeKb`), confirm once, then for each:

```bash
git -C <conception-path> lfs track <path>
git -C <conception-path> add <path>
```

Do **not** commit — the user commits when ready.

### `binaries` (informational)

A binary under `projects/` is > 50 kB and not in git-lfs. Usually resolved by fixing the matching `lfs` issue. Mention in the summary; don't act unless the file is intentionally plain-git.

### `cross-repo` (flag only)

A sibling app's `CLAUDE.md` references `../../conception/...` and the target doesn't resolve. Don't auto-fix — the reference may need re-pointing to a renamed file, not removal. For each:

1. Use `condash knowledge retrieve <name>` to find a likely renamed target.
2. If confident, propose the new path.
3. If not, propose removal.
4. Confirm before editing the sibling repo's `CLAUDE.md` — cross-repo writes affect other projects.

### `worktrees` (informational; offer setup)

Items declaring an active `**Branch**` field but no on-disk worktree. Offer `/projects worktree setup <branch>` per missing branch. Don't auto-create — worktree setup has side effects (env copy, install).

### `index` (auto-fix candidate)

`knowledge/**/index.md` orphans (body files not listed in their parent index) and danglers (entries pointing at missing files). Both are fixed by `/knowledge index` (which calls `condash knowledge index`). Suggest running it.

## What this does *not* do

- **Does not auto-bump stamps.** A bumped stamp without a re-read is a lie about freshness.
- **Does not check content accuracy.** Only dates, SHAs, LFS coverage, and tree structure. A stamp may be fresh and still wrong if the original author got the facts wrong.
- **Does not rewrite body content.** Every refresh is a human decision.

## Related

- `/knowledge update` — what the user runs after re-reading an app's current state to refresh a stale claim.
- `/knowledge index` — regenerates `knowledge/**/index.md` trees. Fixes `index` audit findings.
- `/projects worktree status` — surfaces the `worktrees` mismatch findings on the projects side.
