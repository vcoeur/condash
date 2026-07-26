---
title: Auto-commit (autoSync) · condash guide
description: Let condash be the single writer for a conception checkout — commit settled changes on a timer, one commit per item, and push.
---

# Auto-commit

> **Audience.** Daily user whose conception is a git repo — especially one shared by parallel agent sessions.

**When to read this.** Your conception tree is versioned and you are tired of committing it by hand — or several sessions write to it at once and you want exactly one process holding the index.

Auto-commit runs `condash sync run` on a timer while a conception is open. It is **off by default** and lives entirely in the app: the CLI verb it drives is documented in [CLI → sync](../reference/cli.md).

## Why a single writer

A conception checkout shared by parallel agent sessions has three ways to corrupt itself: they share one `.git/index`, the `index.md` files are fan-in that no one session owns, and concurrent pushes race. One writer dissolves all three. Auto-commit is that writer — the sessions write files and stop.

## What a sweep does

Each sweep takes an exclusive lock and then:

1. **Skips anything still warm.** A path modified more recently than the quiet period is left for the next sweep, so a file mid-write is never committed half-finished.
2. **Commits one commit per item.** Every changed file under `projects/<month>/<item>/` lands in a commit subjected `<item>: sync`, so a shared checkout still produces per-item history.
3. **Then knowledge, then everything else.** Changed `knowledge/` bodies go into `knowledge: sync`; every other tracked, non-gitignored file outside the two trees — `AGENTS.md`, `.agents/`, config, `resources/`, `tasks/` — goes into `meta: sync`.
4. **Then the regenerated indexes**, in a commit of their own (`indexes: sync`). If any item or knowledge path was held back by the quiet period, index regeneration is deferred too: an index is fan-in over every item, so regenerating one while an item is mid-write would record a bullet pointing at an uncommitted directory.
5. **Pushes**, unless you turned that off.

A sweep that introduces an item's `Closed.` timeline entry commits that item under a synthesised `Close <item>. Outcome: …` subject instead of `<item>: sync` — so closing an item stays a write-files-only operation.

**To keep a file out of auto-commit, gitignore it.** There is no exclusion list; git status is the filter.

## Turning it on

**Settings → Auto-commit**, under *Personal · this machine*. It is a personal setting: it describes how *this machine* drives commits while a conception is open, not anything about the tree — so `autoSync` lives in the per-machine `settings.json` and a conception file carrying it is rejected.

```json
{
  "autoSync": {
    "enabled": true,
    "intervalMinutes": 10,
    "quietPeriodSeconds": 90,
    "push": true
  }
}
```

| Key | Default | Notes |
|---|---|---|
| `enabled` | `false` | Master switch. |
| `intervalMinutes` | `10` | Sweep cadence. Clamped to 1–120. |
| `quietPeriodSeconds` | `90` | A file touched more recently than this is left for the next sweep. Clamped to 0–3600; `0` commits even just-touched files. |
| `push` | `true` | Push after committing. Off leaves the branch ahead of upstream. |

The engine re-reads its config every 30 seconds, so a change in Settings takes effect within one tick — no restart. Enabling it does **not** commit immediately: the first enabled tick only establishes a baseline, so the first sweep lands one full interval later rather than the instant the app opens.

Full key detail: [Config files → Auto-commit](../reference/config.md#auto-commit).

## Reading the status

The Settings section carries a **Commit & push now** button and a live status line beside it: the phase (*Off* / *Waiting for first sweep* / *Idle* / *Committing…* / *Last sweep failed*), when the next sweep is due, the last result (`3 commits, pushed · 4 min ago`), and the last error if there was one. A manual sweep also defers the next automatic one by a full interval.

The status bar carries the same engine, condensed:

- **A sync pill** — a state dot plus a label: `Synced`, `12 to sync`, `3 to push`, `Syncing…`, `Sync failed`, or `Auto-sync off`. Its tooltip spells out uncommitted and unpushed counts. **Click it** to open a **Recent commits** popover listing the conception's latest commits with their SHAs and subjects; unpushed ones are tagged.
- **A Sync now button** beside it, and another inside the popover — one immediate sweep, exactly what the Settings button does.

## When a sweep can't run

- **The lock is already held** (a CLI `condash sync` is mid-sweep): the tick exits quietly and tries again next interval.
- **The repo refuses** — mid-merge, a conflict, anything `syncRun` won't touch: the error is recorded, shown in both the Settings status line and the status-bar pill, and retried on the next interval. A failure is treated as a completed attempt so it can never hot-loop.

## Doing it by hand

The same sweep, from a terminal:

```bash
condash sync                      # sweep now (alias for `sync run`)
condash sync run --dry-run        # report what would be committed; write nothing
condash sync run --no-push        # commit but stay ahead of upstream
condash sync run --quiet-period 300
```

And a manual milestone commit for one item, taking the same lock:

```bash
condash sync commit <item> --message "Ship the parser rewrite."
```

Unlike `run`, a held lock is an error here rather than a silent skip. See [CLI → sync](../reference/cli.md) for the full flag set and exit codes.

## See also

- **[The Settings modal](settings-modal.md)** — where the Auto-commit section sits and which file it writes.
- **[Config files → Auto-commit](../reference/config.md#auto-commit)** — every key with its defaults and clamps.
- **[CLI reference](../reference/cli.md)** — the `sync` noun.
