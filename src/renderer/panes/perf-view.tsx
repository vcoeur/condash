import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type { PerfVitals, TermSession } from '@shared/types';
import './perf-pane.css';

/**
 * Performance pane.
 *
 * Reads the two things the tab-strip meter could never show: how fast a tab's
 * memory is *growing* (the meter is a level, so a tab climbing 2G→8G inside one
 * sampling window gave no warning before it died), and whether a tab is being
 * *throttled* at its `MemoryHigh` — the state tabs actually die in, previously
 * an unexplained slowdown with nothing to attribute it to.
 *
 * Per-tab figures come from the always-on memory sampler, so the pane is useful
 * without turning recording on. Event-loop delay — the most direct measure of
 * the UI lag this whole effort is about — needs `terminal.perf.enabled`, which
 * the toggle here flips.
 */

/** Poll cadence for the process vitals. Matches main's sampler tick, so the
 *  pane and the session snapshot move together rather than beating against
 *  each other. */
const VITALS_POLL_MS = 2500;

/** Compact byte size, GB-scale first (tab scopes are GB-scale). */
function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 0.1) return `${gb.toFixed(1)} G`;
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return `${Math.round(mb)} M`;
  return `${Math.round(bytes / 1024)} K`;
}

/** Signed rate label. A near-zero rate renders as a dash rather than a noisy
 *  ±1 MB/s, which would otherwise dominate a resting tab's row. */
function formatRate(bytesPerSec: number | undefined): string {
  if (bytesPerSec === undefined) return '—';
  const mbPerSec = bytesPerSec / 1024 ** 2;
  if (Math.abs(mbPerSec) < 1) return '—';
  const sign = mbPerSec > 0 ? '+' : '−';
  return `${sign}${Math.abs(mbPerSec).toFixed(0)} MB/s`;
}

/** Seconds until a tab at its current growth rate reaches its cap, or undefined
 *  when it is not growing / has no cap. The number that turns a level into a
 *  warning: "5.8 G of 8 G" is ambiguous, "≈40 s to cap" is not. */
function secondsToCap(session: TermSession): number | undefined {
  const { memBytes, memMaxBytes, memGrowthBytesPerSec: rate } = session;
  if (memBytes === undefined || memMaxBytes === undefined) return undefined;
  if (rate === undefined || rate <= 0) return undefined;
  const remaining = memMaxBytes - memBytes;
  if (remaining <= 0) return 0;
  return Math.round(remaining / rate);
}

/** Short "time to cap" label; only rendered when the projection is near enough
 *  to be actionable, so a slow-growing tab doesn't cry wolf. */
function formatEta(seconds: number | undefined): string | undefined {
  if (seconds === undefined || seconds > 600) return undefined;
  if (seconds < 60) return `≈${seconds}s to cap`;
  return `≈${Math.round(seconds / 60)}m to cap`;
}

export interface PerfViewProps {
  /** Live terminal sessions, from the same broadcast the tab strip reads. */
  sessions: () => readonly TermSession[];
}

export function PerfView(props: PerfViewProps) {
  const [vitals, setVitals] = createSignal<PerfVitals | undefined>();
  const [busy, setBusy] = createSignal(false);

  const refresh = async (): Promise<void> => {
    try {
      setVitals(await window.condash.perfVitals());
    } catch {
      // A failed poll is not worth a toast — the pane simply keeps its last
      // reading and tries again on the next tick.
    }
  };

  onMount(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), VITALS_POLL_MS);
    onCleanup(() => clearInterval(timer));
  });

  const toggleRecording = async (): Promise<void> => {
    setBusy(true);
    try {
      setVitals(await window.condash.perfSetEnabled(!(vitals()?.recording ?? false)));
    } finally {
      setBusy(false);
    }
  };

  /** Live sessions only — an exited row has no meaningful current usage. */
  const liveSessions = (): TermSession[] => props.sessions().filter((s) => s.exited === undefined);

  return (
    <div class="perf-view">
      <div class="perf-header">
        <h3>Performance</h3>
        <button
          type="button"
          class="perf-toggle"
          classList={{ recording: vitals()?.recording === true }}
          disabled={busy()}
          onClick={() => void toggleRecording()}
          title={
            vitals()?.recording === true
              ? 'Stop recording to .condash/perf/'
              : 'Record main-process counters to .condash/perf/ (off by default)'
          }
        >
          {vitals()?.recording === true ? 'Recording' : 'Record'}
        </button>
      </div>

      <div class="perf-vitals">
        <div class="perf-vital">
          <small>main loop p99</small>
          <strong>
            <Show when={vitals()?.loop} fallback="—">
              {(loop) => `${loop().p99.toFixed(1)} ms`}
            </Show>
          </strong>
        </div>
        <div class="perf-vital">
          <small>main loop max</small>
          <strong>
            <Show when={vitals()?.loop} fallback="—">
              {(loop) => `${loop().max.toFixed(0)} ms`}
            </Show>
          </strong>
        </div>
        <div class="perf-vital">
          <small>main heap</small>
          <strong>
            <Show when={vitals()} fallback="—">
              {(v) => formatBytes(v().heapUsed)}
            </Show>
          </strong>
        </div>
        <div class="perf-vital">
          <small>live tabs</small>
          <strong>{liveSessions().length}</strong>
        </div>
      </div>

      <Show when={vitals() && vitals()!.recording === false}>
        <p class="perf-hint">
          Event-loop figures need recording. Per-tab memory, growth, and throttle state below are
          always live.
        </p>
      </Show>

      <Show
        when={liveSessions().length > 0}
        fallback={<div class="empty">No terminal sessions running.</div>}
      >
        <table class="perf-table">
          <thead>
            <tr>
              <th>Tab</th>
              <th class="num">Memory</th>
              <th class="num">Growth</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            <For each={liveSessions()}>
              {(session) => {
                const eta = (): string | undefined => formatEta(secondsToCap(session));
                return (
                  <tr classList={{ throttled: session.memThrottled === true }}>
                    {/* The id rides along because the primary label is a repo or
                        cwd, and two tabs opened in one directory render
                        identically under it — which reads as a duplicated row
                        rather than as two tabs. */}
                    <td class="perf-tab-name">
                      <span>{session.repo ?? session.cwd ?? session.id}</span>
                      <Show when={session.repo !== undefined || session.cwd !== undefined}>
                        <span class="perf-tab-id">{session.id}</span>
                      </Show>
                    </td>
                    <td class="num">
                      <Show when={session.memBytes !== undefined} fallback="—">
                        {formatBytes(session.memBytes!)}
                        <Show when={session.memMaxBytes !== undefined}>
                          <span class="perf-cap"> / {formatBytes(session.memMaxBytes!)}</span>
                        </Show>
                      </Show>
                    </td>
                    <td class="num">{formatRate(session.memGrowthBytesPerSec)}</td>
                    <td>
                      <Show
                        when={session.memThrottled === true}
                        fallback={
                          <Show when={eta()} fallback={<span class="perf-pill">ok</span>}>
                            {(label) => <span class="perf-pill warn">{label()}</span>}
                          </Show>
                        }
                      >
                        <span
                          class="perf-pill warn"
                          title="The kernel is reclaiming memory against this tab (MemoryHigh). Sustained throttling is what gets a tab killed under system memory pressure."
                        >
                          throttled
                        </span>
                      </Show>
                    </td>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </table>
      </Show>
    </div>
  );
}
