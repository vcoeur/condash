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

When pushing with integration enabled, it fetches and integrates **before** the steps below. An integration error skips all new commits, live index regeneration and push, leaving behind-only history retryable instead of creating divergence. This also applies to milestone `sync commit` and refused opt-in safe merges. Explicit `ff-only` divergence without an integration error retains its local-commit behavior.

1. **Skips anything still warm.** A path modified more recently than the quiet period is left for the next sweep, so a file mid-write is never committed half-finished.
2. **Commits one commit per item.** Every changed file under `projects/<month>/<item>/` lands in a commit subjected `<item>: sync`, so a shared checkout still produces per-item history.
3. **Then knowledge, then everything else.** Changed `knowledge/` bodies go into `knowledge: sync`; every other tracked, non-gitignored file outside the two trees — `AGENTS.md`, `.agents/`, config, `resources/`, `tasks/` — goes into `meta: sync`.
4. **Then the regenerated indexes**, in a commit of their own (`indexes: sync`). A tree's indexes regenerate whenever its `.index-dirty` marker is set *or* the sweep commits content in it, so an index never trails what it describes by more than the quiet period. An index is fan-in over every item of its tree, so regenerating one while a **brand-new** item of that tree is mid-write would record a bullet pointing at a directory `main` does not contain. A held-back path that HEAD has never seen therefore defers index work — but only for **its own tree**: a mid-write project item never delays a `knowledge/**/index.md`, and vice versa. A held-back path that HEAD already holds does not defer: its bullet may describe the mid-write file for one sweep, and the tree stays marked dirty until a sweep finds every path in it settled, so the next tick re-derives it. The sweep names what it deferred and why (`deferred projects indexes until new projects/2026-08/2026-08-19-foo/README.md settles`), so an index change that sits uncommitted across several sweeps is visible rather than silent.
5. **Pushes**, unless you turned that off.

Dirty indexes use their **pre-integration, pre-regeneration mtime** for quiet-period eligibility. Rewriting an already settled index during the sweep does not make it warm again; a fresh pre-existing index still waits. Index changes first authored by the sweep remain immediately eligible.

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
    "push": true,
    "integration": "ff-only"
  }
}
```

| Key | Default | Notes |
|---|---|---|
| `enabled` | `false` | Master switch. |
| `intervalMinutes` | `10` | Sweep cadence. Clamped to 1–120. |
| `quietPeriodSeconds` | `90` | A file touched more recently than this is left for the next sweep. Clamped to 0–3600; `0` commits even just-touched files. |
| `push` | `true` | Push after committing. Off leaves the branch ahead of upstream. |
| `integration` | `ff-only` | `ff-only` fetches/fast-forwards and refuses divergence. Opt-in `safe-merge` also recovers clean or generated-row-only divergence; `off` skips fetch/integration. |

The engine re-reads its config every 30 seconds, so a change in Settings takes effect within one tick — no restart. Enabling it does **not** commit immediately: the first enabled tick only establishes a baseline, so the first sweep lands one full interval later rather than the instant the app opens.

Full key detail: [Config files → Auto-commit](../reference/config.md#auto-commit).

## Reading the status

The Settings section carries a **Commit & push now** button and a live status line beside it: the phase (*Off* / *Waiting for first sweep* / *Idle* / *Committing…* / *Integration needed* / *Last sweep failed*), when the next sweep is due, the last result (`3 commits, pushed · 4 min ago`), and the last error if there was one. A manual sweep also defers the next automatic one by a full interval.

The first blocked integration in an episode sends a desktop notification with waiting commits **recounted after local commits**, or “count unknown”, and the first detection time. The same evidence remains in Settings and the status tooltip even as the scheduling phase cycles through idle/syncing or auto-sync is disabled/re-enabled. Notifications are best-effort and never fail a sweep. Suppression is session-scoped; only verified reconciliation or a conception change clears the episode, not a skipped integration.

The status bar carries the same engine, condensed:

- **A sync pill** — a state dot plus a label: `Synced`, `12 to sync`, `3 to push`, `Syncing…`, `Sync failed`, `Integration needed`, or `Auto-sync off`. Its tooltip spells out uncommitted and unpushed counts. **Click it** to open a **Recent commits** popover listing the conception's latest commits with their SHAs and subjects; unpushed ones are tagged.
- **A Sync now button** beside it, and another inside the popover — one immediate sweep, exactly what the Settings button does.

## When a sweep can't run

- **The lock is already held** (a CLI `condash sync run` is mid-sweep): the tick exits quietly and tries again next interval.
- **The repo refuses** — mid-merge, a conflict, anything `syncRun` won't touch: the error is recorded, shown in both the Settings status line and the status-bar pill, and retried on the next interval. A failure is treated as a completed attempt so it can never hot-loop.
- **The tree has diverged from the remote** (commits on both sides): `ff-only` still commits local work but refuses the push. `safe-merge` can recover automatically on a clean sweep; unsafe conflicts remain *Integration needed*. Reconcile manually with `git pull --rebase` or `git merge` against your upstream only once work is settled, then sync again. Preserve prose/curated rows in conflicted generated indexes, resolve only drafted content, then run `condash projects index` or `condash knowledge index`. Never take a whole index side blindly or discard local commits.
- **Fetch, fast-forward or safe-merge recovery fails:** later commits and push stop, with bounded multiline diagnostics naming known blockers. Guarded recovery may already have safe writes or completed commits/push; its report preserves those effects and can require manual reconciliation, not retry. A dirty safe-merge checkout no longer commits during refusal; explicit `condash sync run --no-push` can settle ordinary local work but cannot bypass unfinished recovery evidence.

## Guarded dirty-index fast-forward

When a pushing `sync run` is behind-only with `ff-only` or `safe-merge` enabled, it structurally checks dirty generated-index overlaps **before** an ordinary merge. Every overlap must be an unstaged tracked regular output modification whose raw local and HEAD non-draft segments match exactly, including blanks/EOL. Stale strict unannotated draft rows may differ. The complete batch, current/incoming input shapes, ignored/untracked collisions, retained index census and inert conversion at local/incoming/current attributes for **every** potential or selected output must pass before any replacement. Unsupported batches leave candidate bytes unchanged; the initial fetch may update tracking refs. `sync commit` does not normalize dirty overlap.

Two ownership corrections (2026-11-18) keep more of your hand-written index prose safe before recovery is ever needed. The ordinary generator treats fenced code blocks as prose on both sides of the render: a drafted row inside a ```/~~~ fence survives regeneration verbatim and the engine's replacement row is written outside the fence. A non-draft loose row — one matching only the `- [name](link)` head — whose target keys to no real on-disk child is human-owned prose too: it stays byte-identical until you remove it, so a dangling link stays visible instead of being silently cleaned up, it is never re-rendered or re-keyed, and duplicate same-head loose rows collapse to the first occurrence. Loose rows with a real target still get repaired to the canonical shape, and drafted loose rows with missing targets are still cleaned up as the engine's own stale output. The guarded recovery protects every non-draft segment, so it agrees with the generator on the preserved class; on the recorded disagreement classes it fails closed — it refuses and retains manual-reconciliation evidence rather than writing a loss it cannot prove safe.

Diagnostics retain up to 12 nonempty lines and 4096 UTF-8 bytes, including an explicit truncation marker, so ordinary Git blocker paths remain visible within those bounds.

The sync lock excludes cooperating sweepers, **not arbitrary external editors**. Dirty-index mtimes are refreshed for observable later writes before regeneration; this is not a universal writer lock. Default integration mode and quiet period are unchanged.

Supported recovery saves private bounded evidence, writes exact pinned HEAD bytes only to qualified candidates, then runs one guarded live fast-forward with ordinary hooks/filters intact. The actual bottom-up generator validates prevalidation/direct reads and changed/unchanged outputs through queued strict write-ahead persistence; no virtual source overlay or predicted output is used. Source-only inputs may undergo trusted checkout conversion (including LFS-style filters); their actual checkout bytes become the incoming baseline. Intentional incoming human output replacements supersede old local/HEAD prose, while unchanged local protection and later additions remain mandatory.

The retained census includes skipped dated-child inputs and dynamically found outputs, even when a later walk omits them. Full branch/upstream/config/index/operation, all-output conversion and retained-content checks repeat before staging and committing. Actual staged blobs, `commit --only` objects and complete commit trees are checked before another group or push. A post-checkout guard stop can leave advanced HEAD and safe earlier child writes; it blocks the unsafe write and subsequent commits/push, retaining evidence for manual reconciliation rather than reversing the merge. A hook-created incompatible local commit or uncertain push is reported as an actual partial effect.

Lock release checks its nonce and inode rather than deleting a replacement owner's lock. On capable Linux hosts, stale takeover uses the same private nonblocking flock arbitration as internal recovery promotion. Without that capability, stale/dead/unparseable locks are retained for manual reconciliation, not taken over; free-lock acquisition and appropriate owned release still work. Uncertain probing is not treated as safe unavailability. Any partial recovery root, unfinished record or pending archive blocks ordinary acquisition instead of being age-cleaned; only fully validated terminal archives are nonblocking. This coordinates participating sweepers on a stable host capability, not arbitrary editors or older executables.

Both sync entries discover unfinished evidence before ordinary status/fetch/lock routing. Only an exact durably relinquished deferred record may resume through an exclusive durable claim, with push on, no dry-run, the same integration mode/root/full refs/index and a fresh finite nonnegative quiet period. Continuation does not refetch or repeat the fast-forward/hook. Other unfinished or invalid evidence refuses with exit 3, including milestone, dry-run, no-push, integration off and already-up-to-date invocations. Diagnostics escape the private evidence path and include phase/generation and validated expected HEAD/pending count where available. Missing metadata/immutable bytes are never reconstructed, erased or treated as absent.

Opaque executable post-merge hooks make pre-existing outputs warm even if their bytes match incoming Git objects. A held tree or quiet-ineligible pre-existing output durably defers **the whole recovery invocation**, including unrelated groups: no commits or push, although safe generation may already have happened. A later owned continuation uses a fresh cutoff, keeps every original requirement and retains newly observed protected additions before writes. Own generation timestamps do not reset age; observable same-content external stat drift does. Ordinary quiet/default behavior stays unchanged.

The journal is private under the resolved Git directory, with owned generations, per-effect intents, strict target/parent fsync/readback before completion and both archive-move parents fsynced. Support requires Linux, a stable system-flock capability, supported ownership and regular single-link 0644 outputs, a compatible checkout umask and strict filesystem operations; recovery never changes the process umask. Limits are 100,000 relevant entries, 1,000 candidates, 8 MiB per protected index, 128 MiB journal and 120 seconds preflight. Known limits refuse before candidate replacement; later exhaustion/I/O failures retain unresolved evidence. Process-kill tests and ordered fsync calls are not power-loss certification.

Private publication protocol **version 2** creates discoverable partial evidence before rewriting/persisting the existing token as recovery-purpose. A final generation/transaction/owner/location release prerequisite identifies what must finish; visible terminal/deferred bytes are not acknowledgment. Every required journal write, fsync, close, accounting and final verification must succeed before the running owner may remove its exact token. Earlier failures retain it even if emergency recording fails or the helper dies, including failures before a journal object returns. Generic cleanup cannot delete it, and a recovery token with no journal root still blocks.

Actual authorized removal acknowledges the already durable journal. Later removal-parent persistence/helper errors are **cleanup uncertainty**, not failed journal publication or zero effects; no further journal/emergency/target effect or unlink retry follows. Valid new evidence plus absence may admit a later invocation. Missing-before-attempt, foreign/malformed/unreadable tokens and unknown outcomes are not successful owned release. This causal rule assumes cooperating processes and supported persistence, not detectable arbitrary witness erasure.

Automatic deferred continuation requires exactly one valid v2 generation and **absent** token under lease, then a durable recovery-purpose claimant before publishing its active owner. Dead matching and foreign claimant tokens remain manual. Legacy v1 is inspection/manual only; reviewed closure preserves original manifests/orphans. Its token/process/arbitration-bound receipt authorizes a strictly persisted non-admissible resolving barrier with cleared descriptor **before** removing the inspected old token and establishing a new administrative owner. It never impersonates a dead process or replays effects. Historical acknowledged v2 archives permit a later different ordinary nonce; current recovery/partial evidence gates globally and aggregate archive budgets remain finite.

Private manual-reconciliation APIs can inventory a stopped transaction and prepare exact user-reviewed operations. They never execute the proposed target repairs. Closure requires a concrete receipt that is reverified against current refs/index/path identities, retained sequences, actual selected object bytes and all private evidence under administrative lease ownership; a boolean acknowledgement cannot authorize it. Orphan errors/temporaries are retained and actual partial effects are recorded as reconciled, never replayed or reset. Invalid main metadata or missing/unmet protection still refuses closure. No public repair command was added.

## Safe-merge recovery

Select **Settings → Auto-commit → Upstream integration → Safe merge**, or set `autoSync.integration` to `"safe-merge"` in the per-machine settings. `ff-only` remains the default; upgrades do not opt you in. The CLI forwards the same setting.

Recovery first prepares the merge in a disposable Git repository using immutable local/upstream tips. With no conflicts, both histories join normally. With conflicts, only regular generated project root/month or knowledge indexes qualify, and only strict, unfenced child bullets carrying a trailing `<!-- draft -->` marker with no additional HTML comments may be discarded and rebuilt. Any extra comment, including inside the row body, makes the whole row human/ambiguous for recovery; its annotations must survive or recovery refuses. Filename alone proves nothing: the remaining human content is three-way merged, so clean remote prose/curated changes survive and handwritten conflicts refuse. Affected trees are regenerated from the merged committed sources; regeneration that loses human lines refuses too. This conservative ownership check does not change ordinary index rendering.

The resulting commit has both original tips as parents. Before application, condash rechecks HEAD, branch, upstream, operation state and clean working tree/index. Git then performs only a guarded fast-forward, with autostash and ignored-file overwrites disabled. Dirty/staged/untracked work waits; ignored obstructions refuse rather than disappear. No stash, reset, clean, rebase or force push is used. The sync lock protects cooperating sweepers, not arbitrary external writers: the final checks and Git's own refusal checks narrow the race but cannot lock out an unrelated editor between operations.

Git **2.29 or newer** and the required merge guards are checked; unsupported Git refuses recovery without an unsafe fallback. Deleted/renamed/type-changed indexes, symlinks/submodules in either source tree, non-text merge attributes, item-local index conflicts, ambiguous regenerated renames and index entries hiding work (`assume-unchanged`/`skip-worktree`) also refuse. Dry-run, no-push, integration off and no upstream do not recover. A rejected ordinary push retains the commits and waits for the next sweep's fetch.

## Working with collaborators

Each collaborator keeps their own checkout and pushes to the one shared remote. The sweeper fetches first and fast-forwards an ahead-only remote unless local work blocks it. On divergence, default `ff-only` waits for manual reconciliation; opt-in `safe-merge` recovers only under its safeguards. An integration error prevents new local commits; `--no-push` explicitly settles work without integration. `integration: 'off'` restores the old behavior (no fetch, no integration).

## Doing it by hand

The same sweep, from a terminal:

```bash
condash sync                      # dry-run: report what a sweep would commit; write nothing
condash sync run                  # sweep now (executes)
condash sync run --dry-run        # report what would be committed; write nothing
condash sync run --no-push        # commit but stay ahead of upstream
condash sync run --quiet-period 300
```

Bare `condash sync` never writes git state — it prints the plan. The sweep itself
is `condash sync run`.

And a manual milestone commit for one item, taking the same lock:

```bash
condash sync commit <item> --message "Ship the parser rewrite."
```

Unlike `run`, a held lock is an error here rather than a silent skip. See [CLI → sync](../reference/cli.md) for the full flag set and exit codes.

## See also

- **[The Settings modal](settings-modal.md)** — where the Auto-commit section sits and which file it writes.
- **[Config files → Auto-commit](../reference/config.md#auto-commit)** — every key with its defaults and clamps.
- **[CLI reference](../reference/cli.md)** — the `sync` noun.
