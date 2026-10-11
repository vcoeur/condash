# Terminal acceptance harness

The terminal acceptance harness measures controlled local workloads. It selects no
optimization and makes no compositor-pixel or live-desktop UX claim. Application
source, batching, backpressure, worker and hydration behavior remain unchanged.

## Execution and evidence

- `tests/terminal-acceptance.spec.ts` runs in the ordinary headless suite. It gates
  a small complete census, first-frame/settled markers, geometry, positive perf
  telemetry with zero watchdogs, and an explicit processed-input absorb control.
- `tests/terminal-acceptance-measure.spec.ts` requires
  `CONDASH_TERM_ACCEPTANCE=1` for acceptance or
  `CONDASH_TERM_QUALIFICATION_SMOKE=1` for a qualification smoke. Both execute
  the full fixed-count driver: n=30 per distribution family, including
  receipt and hidden return, plus six separately labelled actual-keyboard samples.
  Census is a full population of exactly 64 tokens, never a sample.

```bash
npm run build
# A separately declared one-boot integration exercise; never an acceptance substitute:
CONDASH_TERM_QUALIFICATION_SMOKE=1 CONDASH_TERM_ACCEPTANCE_LABEL=qualification-smoke npm run test -- terminal-acceptance-measure.spec.ts
# Only after a fresh integration review PASS, declare the single four-boot campaign:
CONDASH_TERM_ACCEPTANCE=1 CONDASH_TERM_ACCEPTANCE_LABEL=run1 npm run test -- terminal-acceptance-measure.spec.ts
# Repeat as run2 and run3, each a fresh process boot; then:
CI=1 CONDASH_TERM_ACCEPTANCE=1 CONDASH_TERM_ACCEPTANCE_LABEL=ci-faithful taskset -c 0,1 npm run test -- terminal-acceptance-measure.spec.ts
```

Check that the host permits CPUs 0 and 1 before the constrained run. Run records
verify main and renderer affinity from `/proc`, not an environment declaration.
The distribution spec disables retries: a retry is not an independent repetition.
Use unique Playwright `--output` paths when retaining multiple executions.
Smoke and acceptance flags are mutually exclusive. A smoke always has
`purpose: qualification-smoke` and `allPass: false`, even under eligible CI
affinity; it cannot supply an acceptance boot. Its failures and full sample rows
are retained. Material source-budget, population or census failures stop the
driver; no retry, replacement opportunity or tuning is permitted.

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

New burst records use `causal-app-strict-memory-v4` and qualification label
`causal-paced-125ms-v4`. Active census and hidden burst-idle ACKs use separate
source nonces, expected files and actual PTY sessions; neither stream can borrow
the other's payload witnesses. The active census keeps the same prepared current
instance selected through the final64/64. The hidden stream is unprepared and
does not claim a complete default-retention census.

The in-page delivery tracker declares exactly30 original `floor(B*i/31)` targets.
On actual target crossing it captures the latest positive same-session callback
and complete payload-line boundary, then immediately triggers the echo without
a Node/evaluate round-trip. The first successful ACK poll-entry timestamp and
latency are frozen before one unawaited checkpoint send in that same poll;
settlement/evidence collection cannot delay that send or inflate latency. The
tracker retains every callback and every attempted, timed-out or later
unattemptable row. Positive byte progress strictly inside ACK remains a diagnostic,
including zero, not the new qualification gate.

One common helper owns numeric packing, exact16-slot masks/null/reserved-zero
rules, strict schemas, schedule/mode validation, bounded sealed readback and
causal qualification. The fixture compiles/imports that exact module with the
existing esbuild before READY/GO, avoiding dependence on native Node22 TypeScript
support; no new package or loader flag is needed. Source pacing and tracing use
one monotonic clock with unchanged cumulative-byte scheduling, write order and
drain/rebase algorithm. The fixed16 MiB/131,072-record quota stores every event;
overflow invalidates evidence, never truncates it. No measured-path JSON/hash/file
I/O occurs. Serialization, hashing, file write/fsync/close and strict seal
publication occur once after source COMPLETE. END/DONE is not export completion:
the session stays alive through full valid readback, census and telemetry.

Qualification requires the full3932160-byte pinned identity, whole-generation
rate≥124,518.4 B/s (95% of nominal), and every conservative completed-progress
span≤125 ms (16 normal cadences), including startup and finish. Exact schedule
truth is checked without requiring zero write lateness or pre-deadline checkpoints.
The source preceding write→real pre-trigger delivery→trigger→frozen ACK and
ACK→checkpoint send→source receipt→first new source write→real post-ACK delivery
form a clock-free enclosure. Pending/false writes, drain, pause, rebase or completion
inside that conservative envelope reject, even below125 ms. A stale queued
callback cannot replace the first genuinely new following source write. The
literal claim is “ACK causally enclosed by a trace-verified paced-output segment
with approved rate/gap budgets and preceding/following delivered payload”—not
continuous output, instantaneous activity or independent upstream attribution.

Readback checks known regular canonical paths and actual file sizes before reading
either file, then enforces independent streaming limits:64 KiB seal,2,048-byte
LF-inclusive record and256 MiB sidefile, with fatal UTF-8, exact raw digest/count/
size reconciliation and complete relational validation. Seal-advertised sizes
never authorize reads. All producer append/control/export CPU, time, memory and
resource metadata, source records, callback/ACK clocks and raw files are retained;
no field or cost is dropped or subtracted.

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
eligible boots. Smoke uses `complete-qualification-smoke-clear` or
`complete-qualification-smoke-failed-checks` and always keeps acceptance `allPass`
false. These are per-record judgments, not programme-wide acceptance:
the required repeated loaded populations remain blocked at 29/30 in two boots.
Original records retain their historical labels/protocols and are not rewritten
or retro-passed by strict-v4 qualification. Report median/IQR/range/n,
run-level spread, nearest-rank quartiles and descriptive p95 without treating correlated in-run counts as
independent populations. Every number inherits the Xvfb/software-graphics caveat.

## Isolation

Fixture settings and conception are disposable; dashboard and auto-sync are
disabled and memory-scope infrastructure writes are disabled. No real agent,
provider or production request is part of these probes. The observer is disposed
before cleanup, and fixture evidence is copied before temporary directories are
removed. Failures require investigation or a separately approved design/source
decision, never weakened gates or speculative optimization.
