# Terminal acceptance harness

How condash measures terminal responsiveness against its acceptance thresholds —
the `tests/terminal-acceptance*.spec.ts` pair, their fixtures, and the rules
that make the numbers trustworthy. The harness came out of the
2026-10 terminal-responsiveness acceptance project: measurement only, **no
optimization mechanism is or may be implemented by it** — a demonstrated
bottleneck feeds a separately approved proposal.

## What runs when

| Spec | When | What it gates |
|---|---|---|
| `tests/terminal-acceptance.spec.ts` | every `make test` | Structural bounds only: a small token census complete on both layers, one first-frame and one settled sample each yield their markers, `watchdogs === 0` under the acceptance load, and an absorb-mode control proves absence is detectable. |
| `tests/terminal-acceptance-measure.spec.ts` | explicitly, `CONDASH_TERM_ACCEPTANCE=1` | The full distribution harness: n=30 per case, medians/IQR/range, census ledgers, transport floors, per-run identity record. Evaluated against the user-approved threshold table. Never runs in the ordinary suite, so it never loads the tag-time 25-minute budget. |

Acceptance recipe (threshold judgments are made on CI-faithful runs only):

```bash
npm run build
CONDASH_TERM_ACCEPTANCE=1 CONDASH_TERM_ACCEPTANCE_LABEL=run1 npm run test -- terminal-acceptance-measure.spec.ts
# ×3 independent runs, then the CI-faithful judgment run:
CI=1 CONDASH_TERM_ACCEPTANCE=1 CONDASH_TERM_ACCEPTANCE_LABEL=ci-faithful taskset -c 0,1 \
  npm run test -- terminal-acceptance-measure.spec.ts
```

Each run writes `tests/acceptance-out/<label>.json` (gitignored) with the raw
samples, distributions, floors, identities and the census ledger.

## The six probe families

1. **First-useful frame (buffer level)** — an echo-probe TUI answers each
   `termWrite` token with `ACK <token>`; the sample's latency is trigger →
   token visible in the live DOM Terminal's registry buffer. This is
   **parsed-buffer first frame, not compositor pixels** — the proxy limit is
   inherited from the parent evidence, stated, not hidden. A separately
   labelled keyboard-dispatch arm (`page.keyboard` into the focused term) runs
   at low n and is never pooled with the IPC arm.
2. **Settled tab switch** — the same trigger against a hidden (worker-demoted)
   tab: click, token, and BOTH markers — first frame, and
   `__condashRepaints.settled` catching the baselined `started` (the
   hydrate-geometry barrier). Grid-vs-pty geometry is read only behind that
   barrier.
3. **Busy vs other-idle** — one tab loaded at a deterministic seeded
   16 KiB/s; probes alternate arms by count schedule: the loaded tab itself
   (busy-self) and an idle echo tab (other-idle).
4. **Sustained receipt** — the generator runs a fixed byte budget; the wait is
   the delivered-byte count reaching the mark. With `perfSetEnabled(true)`
   (opt-in, throwaway fixture settings only) the case records
   batches/pauses/watchdogs. Structural bound: `watchdogs === 0` — the
   watchdog is the renderer-saturation signal, never something to "fix".
5. **Burst received-token census** — the parent's burst identity (128 KiB/s ×
   30 s = 3,932,160 bytes exactly) with 64 sequence-numbered tokens
   interleaved (≥ the 62-token cadence minimum, pinned with margin) and the
   parent's 100-short-line probe block. Coverage is pinned by fixture
   geometry, not token spacing (see below). Every sent token is observed or
   explicitly ledgered with layer attribution; a renderer-layer miss is a
   finding to investigate before acceptance — never silently pooled, never
   auto-passed.
6. **Non-terminal views, resources, larger synthetic conception** — Projects
   write→DOM-title freshness, Knowledge first-open activation and
   terminal↔Knowledge hidden-return cycles, all on a deterministic synthetic
   conception pinned to the parent's corrected bound (60 ordinary + 20
   scratch + 8 baseline = 88 generator files, 91 total, < 5 MiB; scratch under
   `resources/local/`, excluded from watcher expectations).

## Why the census is trustworthy

Two traps were designed out, and both are worth remembering before "simplifying":

- **`termAttach` is not a free read.** It resets flow control on every call,
  and mid-burst that drops the pending renderer batch — a harness-caused
  renderer-layer loss that a tail-sampling census would mis-attribute to
  renderer/parse/hydrate. The attribution layer is therefore the
  **transport accumulator**: an in-page subscription to the app's own
  `onTermData` delivery stream, installed by an init script (same seam the
  terminal pane and code-run rows use; the flow-control ack rides a separate
  dedicated preload listener, so observing costs nothing). It covers the whole
  run by construction. The plan's single end-of-run `termAttach` tail read —
  safe once output has stopped — is still taken as a supplementary main-side
  slice.
- **xterm scrollback counts grid rows, not program lines.** A 1 KiB line at a
  ~120-column pane wraps into ~9 rows, and a 3.9 MB burst would evict all but
  the last few tokens before any end-of-run scan. The census tab's grid is
  resized to 1,100 columns (via `termResize`, before generation starts — the
  burst fixture holds for a stdin `GO`) so one ≤1,023-char program line is
  exactly one grid row and the whole burst fits the 5,000-line scrollback. The
  fixture self-checks pin the arithmetic: mean line ≥ 787 B
  (3,932,160 / 5,000), ≤ 5,000 total lines, ≥ 62 tokens.

`bytesSeen` is main-process-only (not in the `TermSession` IPC payload), so the
sustained-receipt wait rides the accumulator's delivered-byte count — the end
of the app's own delivery path — rather than an unimplemented `termList` field.
Both substitutions are tests-only; the no-`src/`-change boundary holds.

## Overhead bounds and thresholds

Every run measures the **transport floor** (median empty-`evaluate` RTT) and
the registry-read delta. Thresholds are the user-approved table (2026-10-07),
anchored to the parent's measured baselines and treated as local
regression-detection floors, not desktop UX promises:

- Slow arms (idle first-frame, busy-self, settled switch, Projects freshness)
  carry a **validity bound**: acceptance medians ≥ 5× the transport floor, or
  the probe is measuring transport, not the app.
- Fast arms (one-busy other-idle, burst-window idle ACK, hidden return,
  keyboard arm) report **floor-relative overhead** instead — their parent
  baselines (25–73 ms) sit below any 5× bound that the slow arms' own floors
  could satisfy, so applying the bound there would auto-declare
  parent-consistent results invalid.
- p95 is descriptive only (in-run counts are correlated); census cases are
  full-population; every number inherits the software-graphics/Xvfb caveat.

Promoting any threshold to a CI assertion is a later, explicit decision — the
always-on spec carries structural bounds only.

## Isolation

The harness runs against a throwaway userData dir and a throwaway conception
(the `perf-load.mjs` lesson — that harness's earlier version did real damage by
driving the user's own app state). `perfSetEnabled` persists only into the
fixture's settings; no real agent/provider/network/production calls exist.
