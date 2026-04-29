# /knowledge — verify (conception-wide audit)

Audit the conception tree for convention drift: stale `**Verified:**` stamps, LFS coverage gaps, large plain-git binaries, and dangling cross-repo references from sibling apps pointing into conception. The mechanical work is a Python script at `.claude/scripts/audit.py`; this skill drives it, triages the output, and reports.

Trigger: `/knowledge verify`.

## Procedure

1. **Run the audit.**

   ```bash
   python3 .claude/scripts/audit.py --checks=stamps,lfs,binaries,cross-repo
   ```

   The script is read-only. Output is JSON; add `--pretty` for human-readable.

2. **Triage by check and severity.** Top-level shape:

   ```json
   {
     "summary": {"total": N, "by_severity": {...}, "auto_fixable": X, "checks_run": [...]},
     "issues": [{"check": "...", "severity": "...", "file": "...", "line": ..., "message": "...", "auto_fix": bool, "fix": {...}}]
   }
   ```

   Severity ladder: `error` (script crash or missing essential file — investigate first) > `warn` (real drift) > `info` (heuristic or freshness signal, defer unless asked).

3. **Report the punch-list** and handle each check per the rules below. Always confirm a batch of fixes with the user before writing — never auto-edit one issue, ask, then auto-edit the next.

## Handling by check

### `stale_verification` (auto-fix: no — flag for refresh)

Stamps `**Verified:** YYYY-MM-DD <where>` older than **1 month**. List as a punch-list with `file:line`. For each stale stamp, optionally verify the SHA is still reachable:

```bash
git -C ~/src/vcoeur/<app> rev-parse --verify <shortsha> >/dev/null 2>&1
```

If unreachable, mark `SHA missing` — the fact may need re-verifying even if still correct. **Never auto-bump** — a bumped stamp without a re-read is a lie about freshness. Suggest the user re-read the current state of each referenced app and refresh each stamp via `/knowledge update`.

### `lfs_uncovered` (auto-fix: yes, with confirmation)

A `*.pdf|*.png|*.jpg|*.jpeg` under `projects/` is not tracked by git-lfs. Group the paths, report sizes, confirm once, then for each:

```bash
git -C ~/src/vcoeur/conception lfs track <path>
git -C ~/src/vcoeur/conception add <path>
```

Do **not** commit — the user commits when ready.

### `large_binary` (auto-fix: no — informational)

A binary under `projects/` is > 50 kB and not in git-lfs. Usually resolved by fixing the matching `lfs_uncovered` issue. Mention in the summary; don't act unless the file is intentionally plain-git.

### `cross_repo_dangling` (auto-fix: flag only)

A sibling app's `CLAUDE.md` references `../../conception/...` and the target doesn't resolve. Don't auto-fix — the reference may need re-pointing to a renamed file, not removal. For each:

1. Grep `knowledge/` for a likely renamed target (similar name, same semantics).
2. If confident, propose the new path.
3. If not, propose removal.
4. Confirm before editing the sibling repo's `CLAUDE.md` — cross-repo writes affect other projects.

## What this does *not* do

- **Does not auto-bump stamps.** A bumped stamp without a re-read is a lie about freshness.
- **Does not check content accuracy.** Only dates, SHAs, and LFS coverage. A stamp may be fresh and still wrong if the original author got the facts wrong.
- **Does not rewrite body content.** Every refresh is a human decision.

## Related

- `/knowledge update` — what the user runs after re-reading an app's current state to refresh a stale claim.
- `/knowledge index` — regenerates `knowledge/**/index.md` trees. Use `--checks=index` on `audit.py` if you want to see index-tree issues without running the rest.
- `/projects worktree status` — runs the branch-worktree half of the audit (`--checks=worktrees`).
