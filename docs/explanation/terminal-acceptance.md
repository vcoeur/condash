# Terminal acceptance harness

The terminal acceptance harness measures controlled local workloads. It selects no
optimization and makes no compositor-pixel or live-desktop UX claim. Application
source, batching, backpressure, worker and hydration behavior remain unchanged.

## Execution and evidence

- `tests/terminal-acceptance.spec.ts` runs in the ordinary headless suite. It gates
  a small complete census, first-frame/settled markers, geometry, positive perf
  telemetry with zero watchdogs, and an explicit processed-input absorb control.
- `tests/terminal-acceptance-measure.spec.ts` requires
  `CONDASH_TERM_ACCEPTANCE=1`. It records n=30 per distribution family, including
  receipt and hidden return, plus six separately labelled actual-keyboard samples.
  Census is a full population of exactly 64 tokens, never a sample.

```bash
npm run build
CONDASH_TERM_ACCEPTANCE=1 CONDASH_TERM_ACCEPTANCE_LABEL=run1 npm run test -- terminal-acceptance-measure.spec.ts
# Repeat as run2 and run3, each a fresh process boot; then:
CI=1 CONDASH_TERM_ACCEPTANCE=1 CONDASH_TERM_ACCEPTANCE_LABEL=ci-faithful taskset -c 0,1 npm run test -- terminal-acceptance-measure.spec.ts
```

Check that the host permits CPUs 0 and 1 before the constrained run. Run records
verify main and renderer affinity from `/proc`, not an environment declaration.
The distribution spec disables retries: a retry is not an independent repetition.
Use unique Playwright `--output` paths when retaining multiple executions.

Each invocation creates `tests/acceptance-out/<label>-<timestamp>-<pid>/` with
`record.json`, a final screenshot, and copies of disposable fixture/userData.
Checkpoints retain partial samples and failing gates; failed output is never
silently replaced or pooled into successful repetitions. Complete records include
descriptive distributions, all 64 ledger rows, resources, overhead, telemetry and
source/build/fixture/runtime identities. The ordinary structural case retains
fixture and telemetry evidence in its Playwright output directory.

## Signals and invariants

**First frame** is an ACK parsed into the active xterm buffer. An in-page clock
starts before `termWrite`, polling at 4 ms without per-poll Playwright transport.
This bypasses keyboard dispatch and is not final pixels. The separately labelled
keyboard arm uses actual `page.keyboard.type`; its clock includes arm-to-dispatch
transport uncertainty. Neither arm is pooled with the other.

**Settlement** is separate from the first marker. Repaint `started` is baselined
before a tab switch; `settled` must catch all newly started repaints before reading
grid and authoritative PTY geometry. A stable-looking mid-nudge grid is not a
settlement condition. Busy-self and other-idle arms alternate by count while a
finite seeded 16 KiB/s load is positively observed still active.

**Delivered receipt** is a test-side `onTermData` subscription installed before
output. It never acknowledges or changes flow. A bounded stream accumulator
handles chunk boundaries and measures callback cost. `PAYLOAD-BEGIN` and
`PAYLOAD-END` delimit printable ASCII payload from framing and ACK traffic;
newline expansion is accounted separately. Receipt marks and the full-budget
endpoint are timestamped inside the delivery callback, before xterm parsing;
completion-marker time is separate. Parsing, census and overhead belong to the
separately labelled evidence duration, not receipt. Known payload budget and explicit
completion are required. This is IPC receipt **before parsing**, not private
`bytesSeen`, PTY production proof or independent main-side evidence.

**Final burst census** uses the 128 KiB/s × 30 s scheduled profile and exactly
3,932,160 payload bytes, with 100 short probe lines and 64 sparse numbered tokens.
After completion and parsing the final marker, a final whole-buffer scan must
contain all 64 tokens exactly once. Earlier sightings, delivered receipt, eviction
or unavailable attribution cannot pass a missing final token. Per-token evidence
contains delivered presence/count/offset, renderer presence/count and attribution.
Delivered-present/final-absent indicates a post-receipt discrepancy, including
retention. Absent delivery is labelled upstream-loss attribution unavailable:
there is no independent main-side evidence. Never call `termAttach` for census;
every attach resets flow and can drop pending renderer batches.

Retention is a **wrapped-row** calculation at measured fitted columns, including
control rows. A 1,023-character line occupies six rows near 180 columns; the burst
needs roughly 23,000 rows, not roughly 3,840. After READY and settlement, the
fixture explicitly sets only the census burst instance's `options.scrollback`
to 50,000 through the already-armed test registry. It verifies the actual option
and unchanged fitted/PTY geometry before GO. This is test-fixture preparation,
not product preference propagation or default 5,000-row retention. No source/API/
grid override or row-times-column byte estimate is accepted; failed preparation
or final retention remains a failed gate. Overhead is measured on this actual
full retained buffer, not the earlier 5,017-row truncated buffer.

Burst-idle ACKs retain callback-observed load bytes/completion at trigger and ACK.
Only positive delivered-stream byte progress with incomplete payload budget at both endpoints qualifies
as a loaded first-marker sample. Completed, cumulative-only or stalled intervals
are explicitly excluded, retained in the attempt ledger, and make an inadequate
population fail rather than reporting post-load ACKs as loaded. There is no retry
or artificial delay to improve validity or calibration.

Exactly 30 count-scheduled opportunities remain the approved protocol. Within-run
oversampling or extra opportunities were explicitly denied. Existing 29/30
populations remain failed/inadequate; neither a successful constrained screen nor
another descriptive boot supplies the missing repeated population.

**Hidden return** is band show/select, not inactive-tab hydration. Knowledge is
selected only if not already visible. The same mounted registry identities must
survive hide/show; hidden elements must become visible and contain expected ACKs.
The action-to-visible-content and separately settled intervals are both retained;
geometry is checked after settlement. Registry disappearance is not expected.

**Telemetry** must cover the entire measured interval through its final window,
using each JSONL flush timestamp and `windowMs`. A 250 ms `perfVitals` heartbeat
keeps otherwise-idle windows observable; an initial complete record is required
before measurement begins. Missing/malformed records, coverage gaps or missing
positive session bytes/batches invalidate zero-watchdog claims. Sessions and the
recorder remain alive until a record covers the final marker/settlement. Raw
records are retained; boundary windows conservatively include adjacent activity.

## Resources, overhead and thresholds

Every case saves before/after `perfVitals` and Electron `getAppMetrics`, labelled
reported process aggregates, not unique physical memory or calibrated host CPU.
The synthetic fixture is recounted: 60 ordinary + 20 ignored scratch + 8 baseline
Markdown files = 88 conception files, plus three external support documents = 91;
content is below 5 MiB. Boot observation starts before fixture setup/launch and
includes test transport; Knowledge is honestly labelled post-boot activation.

Every run measures matched empty-evaluate/census round trips and a count-balanced
delivery-census-only versus delivery-plus-registry comparison. Paired comparisons
yield between measurements so they do not starve observation timers; measured
body costs exclude that yield. Delivered callback cost is separately recorded.

The user-approved absolute local regression bounds remain:

| Arm | Median bound | Descriptive p95 bound |
|---|---:|---:|
| Idle first frame | 400 ms | 800 ms |
| Other-idle under one busy tab | 120 ms | 250 ms |
| Busy-self | 400 ms | 500 ms |
| Settled switch | 1,000 ms | 2,000 ms |
| Projects freshness | 700 ms | 1,000 ms |
| Hidden return to visible parsed content | 250 ms | — |
| Empty-evaluate transport floor | 15 ms | — |

Slow-arm medians (idle, busy-self, settled switch, freshness) must clear five times
the measured floor for validity. Fast arms (other-idle, burst-idle, hidden return,
keyboard) report floor-relative ratios instead. Numeric failures and validity
failures remain in the record; numerical limits are not new CI timing assertions.
Structural failures do fail the spec. Judging acceptance uses the constrained
run; unconstrained runs are descriptive repetitions. `allDescriptiveChecksClear`
retains their local calculations, but `allPass` additionally requires `CI=1` and
actual main/renderer affinity `0-1`. New report states are
`complete-descriptive-clear` / `complete-descriptive-failed-checks` for ineligible
boots and `complete-acceptance-pass` / `complete-acceptance-failed-gates` for
eligible boots. These are per-record judgments, not programme-wide acceptance:
the required repeated loaded populations remain blocked at 29/30 in two boots.
Original records retain their historical labels and are not rewritten as outputs
of this reporting fix. Report median/IQR/range/n,
run-level spread, nearest-rank quartiles and descriptive p95 without treating correlated in-run counts as
independent populations. Every number inherits the Xvfb/software-graphics caveat.

## Isolation

Fixture settings and conception are disposable; dashboard and auto-sync are
disabled and memory-scope infrastructure writes are disabled. No real agent,
provider or production request is part of these probes. The observer is disposed
before cleanup, and fixture evidence is copied before temporary directories are
removed. Failures require investigation or a separately approved design/source
decision, never weakened gates or speculative optimization.
