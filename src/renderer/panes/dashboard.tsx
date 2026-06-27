import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type { DashboardConfigView, DashboardState, TabInfo, TabSummary } from '@shared/types';
import './dashboard-pane.css';

/**
 * The Dashboard working surface: a detailed, always-current view of what the
 * terminal tabs are doing. Renders the active summarizer settings, any last
 * summarization error, the cross-tab overview, one card per open tab (the full
 * roster — a summarized tab shows title, current action, context and recent
 * events; an as-yet-unsummarized tab shows a fallback from its command/cwd so it
 * is never invisible), and a global event history. Self-contained — subscribes
 * to the engine's pushed state and seeds from the last snapshot on mount.
 */
export function DashboardView() {
  const [state, setState] = createSignal<DashboardState | null>(null);
  const [config, setConfig] = createSignal<DashboardConfigView | null>(null);
  // Local 1s clock so the "next update in Xs" ETA counts down live between the
  // engine's pushes (which only arrive on a real change, not every second).
  const [nowMs, setNowMs] = createSignal(Date.now());

  const refreshConfig = (): void => {
    void window.condash.dashboardGetConfigView().then(setConfig);
  };

  onMount(() => {
    void window.condash.dashboardGetState().then(setState);
    refreshConfig();
    const clock = setInterval(() => setNowMs(Date.now()), 1000);
    onCleanup(() => clearInterval(clock));
  });
  // Re-read the config view alongside each pushed state so the settings panel
  // tracks edits made in Settings while the Dashboard is open (the engine
  // re-reads its config every cycle; this keeps the displayed copy in step).
  const offState = window.condash.onDashboardState((next) => {
    setState(next);
    refreshConfig();
  });
  onCleanup(offState);

  const roster = () => state()?.roster ?? [];
  const overview = () => state()?.overview ?? [];
  const history = () => state()?.history ?? [];
  const engine = () => state()?.engine;

  const secsUntil = (atMs: number): number => Math.max(0, Math.round((atMs - nowMs()) / 1000));

  // "next update in Xs" for the status strip. Empty when there's no key (no
  // cycle can run) so the strip just shows the paused phase instead.
  const nextUpdateText = (): string => {
    const status = engine();
    if (!status || status.phase === 'no-api-key') return '';
    if (status.phase === 'summarizing') return 'updating now…';
    const secs = secsUntil(status.nextRunAt);
    return secs <= 0 ? 'next update due now' : `next update in ${secs}s`;
  };

  // One-line description of what the summarizer loop is doing right now — shown
  // even before any tab has a summary, so an idle-but-running engine reads as
  // alive rather than dead.
  const enginePhaseText = (): string => {
    const status = engine();
    if (!status) return 'Starting…';
    const tabs = roster().length;
    const plural = tabs === 1 ? '' : 's';
    switch (status.phase) {
      case 'summarizing':
        return `Summarizing ${tabs} tab${plural}…`;
      case 'waiting':
        return `Waiting for activity · ${tabs} open tab${plural}`;
      case 'idle':
        return 'Idle — no open terminal tabs';
      case 'no-api-key':
        return 'Paused — set a DeepSeek API key in Settings';
    }
  };

  const lastRunText = (): string => {
    const status = engine();
    return status && status.lastRunAt ? fmtTime(status.lastRunAt) : '—';
  };

  // When the LLM cross-tab overview is empty (no tab summarized yet) but tabs are
  // open, synthesize a per-tab liveness line so "What's going on" is never blank
  // while work is in progress.
  const overviewLines = (): string[] => {
    const llm = overview();
    if (llm.length > 0) return llm;
    return roster().map((tab) => {
      const place = tab.cwd.split('/').filter(Boolean).pop();
      const where = place ? ` (${place})` : '';
      return `${tabLabel(tab)}${where} — running; no transcript captured yet. It will be summarized once it submits a prompt or finishes a turn.`;
    });
  };

  // Time-slot text for an as-yet-unsummarized tab card: tracks the engine's next
  // attempt instead of a flat "no summary yet", so the card looks live too.
  const pendingTimeText = (): string => {
    const status = engine();
    if (status?.phase === 'summarizing') return 'summarizing…';
    if (status && (status.phase === 'waiting' || status.phase === 'idle')) {
      const secs = secsUntil(status.nextRunAt);
      return secs <= 0 ? 'next attempt due now' : `next attempt in ${secs}s`;
    }
    return 'no summary yet';
  };

  // One card per open tab: a summarized tab carries its rich summary; an
  // as-yet-unsummarized tab (no readable output, or before the first cycle)
  // gets a fallback drawn from its command/cwd — so no open tab is ever missing
  // from the list. Summarized tabs sort first by recency; unsummarized ones
  // (updatedAt treated as -1) fall to the end.
  const cards = (): Array<{ tab: TabInfo; summary?: TabSummary }> => {
    const bySid = new Map((state()?.tabs ?? []).map((tab) => [tab.sid, tab]));
    return roster()
      .map((tab) => ({ tab, summary: bySid.get(tab.sid) }))
      .sort((a, b) => (b.summary?.updatedAt ?? -1) - (a.summary?.updatedAt ?? -1));
  };
  const tabLabel = (tab: TabInfo): string =>
    tab.cmd?.trim() || tab.cwd.split('/').filter(Boolean).pop() || tab.sid;

  const fmtTime = (ms: number): string => new Date(ms).toLocaleTimeString();
  const fmtRelative = (ms: number): string => {
    const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (seconds < 10) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    return `${hours}h ago`;
  };
  const endpoint = (cfg: DashboardConfigView): string =>
    cfg.baseUrl?.trim() ? cfg.baseUrl : 'DeepSeek (default endpoint)';
  const statusLabel = (cfg: DashboardConfigView): string =>
    !cfg.enabled ? 'Off' : cfg.hasApiKey ? 'On' : 'On — no API key';

  return (
    <div class="dashboard-pane">
      <header class="dashboard-pane-header">
        <h2>Dashboard</h2>
        <Show when={config() && !config()!.enabled}>
          <p class="dashboard-pane-hint">
            Live tab summaries are off. Enable them and set a DeepSeek API key in Settings →
            Dashboard.
          </p>
        </Show>
        <Show when={config()?.enabled && !config()?.hasApiKey}>
          <p class="dashboard-pane-hint">
            No DeepSeek API key set. Add one in Settings → Dashboard.
          </p>
        </Show>
        <Show
          when={
            config()?.enabled && config()?.hasApiKey && roster().length === 0 && !state()?.lastError
          }
        >
          <p class="dashboard-pane-hint">No open terminal tabs to summarize…</p>
        </Show>
      </header>

      {/* Surfaced prominently: a failed summarization cycle (auth / model /
          network) would otherwise be a silent no-op — the tab titles just stop
          updating. The banner explains why. */}
      <Show when={state()?.lastError}>
        <div class="dashboard-error-banner" role="alert">
          <span class="dashboard-error-banner-label">Last summary failed</span>
          <span class="dashboard-error-banner-msg">{state()!.lastError}</span>
        </div>
      </Show>

      {/* Always-on liveness strip: next-update ETA + what the loop is doing now
          + last run. Rendered whenever the engine is enabled, independent of any
          tab summary, so an idle-but-running engine is never mistaken for dead.
          A single horizontal line — three labelled segments separated by hairline
          dividers — so it stays compact above the working surface. */}
      <Show when={config()?.enabled}>
        <section class="dashboard-status">
          <span class="dashboard-status-item">
            <span class="dashboard-status-label">Status</span>
            <span>
              {statusLabel(config()!)}
              <Show when={nextUpdateText()}>
                <span class="dashboard-status-next"> · {nextUpdateText()}</span>
              </Show>
            </span>
          </span>
          <span class="dashboard-status-item">
            <span class="dashboard-status-label">Engine</span>
            <span>{enginePhaseText()}</span>
          </span>
          <span class="dashboard-status-item">
            <span class="dashboard-status-label">Last run</span>
            <span>{lastRunText()}</span>
          </span>
        </section>
      </Show>

      {/* Two-column working surface: a fixed meta rail (settings, the cross-tab
          overview, and history) beside a wide tab-card grid that fills the
          remaining width. Collapses to a single stacked column when narrow. */}
      <div class="dashboard-body">
        <aside class="dashboard-rail">
          <Show when={config()}>
            {(cfg) => (
              <section class="dashboard-section">
                <h3>Settings</h3>
                <dl class="dashboard-settings">
                  <dt>Model</dt>
                  <dd>{cfg().model}</dd>
                  <dt>Endpoint</dt>
                  <dd>{endpoint(cfg())}</dd>
                  <dt>Update interval</dt>
                  <dd>{cfg().intervalSec}s</dd>
                  <dt>Activity gate</dt>
                  <dd>
                    {cfg().gateOnActivity ? 'On — only changed tabs' : 'Off — every tab each cycle'}
                  </dd>
                </dl>
              </section>
            )}
          </Show>

          <Show when={config()?.enabled && overviewLines().length > 0}>
            <section class="dashboard-section">
              <h3>What's going on</h3>
              <ul class="dashboard-overview">
                <For each={overviewLines()}>{(line) => <li>{line}</li>}</For>
              </ul>
            </section>
          </Show>

          <Show when={history().length > 0}>
            <section class="dashboard-section">
              <h3>History</h3>
              <ul class="dashboard-history">
                <For each={[...history()].reverse()}>
                  {(ev) => (
                    <li>
                      <span class="dashboard-event-time">{fmtTime(ev.at)}</span> {ev.text}
                    </li>
                  )}
                </For>
              </ul>
            </section>
          </Show>
        </aside>

        <main class="dashboard-main">
          <section class="dashboard-section">
            <h3>Open tabs</h3>
            <Show
              when={cards().length > 0}
              fallback={<p class="dashboard-pane-hint">No open terminal tabs.</p>}
            >
              <ul class="dashboard-tab-list">
                <For each={cards()}>
                  {(card) => (
                    <Show
                      when={card.summary}
                      fallback={
                        // No summary yet: the tab is still visible, drawn from
                        // its command/cwd, so the user always sees every tab.
                        <li class="dashboard-tab-card dashboard-tab-card-pending">
                          <div class="dashboard-tab-card-head">
                            <span class="dashboard-tab-card-title">{tabLabel(card.tab)}</span>
                            <span class="dashboard-tab-card-time">{pendingTimeText()}</span>
                          </div>
                          <ul class="dashboard-tab-card-context">
                            <Show when={card.tab.cmd}>
                              <li>Command: {card.tab.cmd}</li>
                            </Show>
                            <li>Directory: {card.tab.cwd}</li>
                            <li>
                              Waiting for first agent output (a submitted prompt or finished turn).
                            </li>
                          </ul>
                        </li>
                      }
                    >
                      {(summary) => (
                        <li class="dashboard-tab-card">
                          <div class="dashboard-tab-card-head">
                            <span class="dashboard-tab-card-title">{summary().title}</span>
                            <span
                              class="dashboard-tab-card-time"
                              title={fmtTime(summary().updatedAt)}
                            >
                              {fmtRelative(summary().updatedAt)}
                            </span>
                          </div>
                          <Show when={summary().currentAction}>
                            <p class="dashboard-tab-card-action">{summary().currentAction}</p>
                          </Show>
                          <Show when={summary().contextLines.length > 0}>
                            <ul class="dashboard-tab-card-context">
                              <For each={summary().contextLines}>{(line) => <li>{line}</li>}</For>
                            </ul>
                          </Show>
                          <Show when={summary().events.length > 0}>
                            <details class="dashboard-tab-card-events">
                              <summary>Recent events</summary>
                              <ul>
                                <For each={[...summary().events].reverse()}>
                                  {(ev) => (
                                    <li>
                                      <span class="dashboard-event-time">{fmtTime(ev.at)}</span>{' '}
                                      {ev.text}
                                    </li>
                                  )}
                                </For>
                              </ul>
                            </details>
                          </Show>
                        </li>
                      )}
                    </Show>
                  )}
                </For>
              </ul>
            </Show>
          </section>
        </main>
      </div>

      <Show when={state()?.updatedAt}>
        <footer class="dashboard-pane-footer">Updated {fmtTime(state()!.updatedAt)}</footer>
      </Show>
    </div>
  );
}
