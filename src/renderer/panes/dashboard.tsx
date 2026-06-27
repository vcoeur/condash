import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type {
  DashboardConfigView,
  DashboardState,
  TabInfo,
  TabState,
  TabSummary,
} from '@shared/types';
import { appColorClass, appPillText } from '@shared/app-color';
import './app-pill.css';
import './dashboard-pane.css';

/** Human label for the state pill, by state. */
const STATE_LABEL: Record<TabState, string> = {
  working: 'Working',
  awaiting: 'Awaiting you',
  idle: 'Idle',
  error: 'Error',
};

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
  // The tabs whose summary is being recomputed in the in-flight cycle. A card
  // whose sid is in here is badged "Summarizing" (transient), overriding its
  // pending/last state so an actively-refreshing tab reads as live.
  const summarizingSids = createMemo(() => new Set(state()?.summarizingSids ?? []));

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

  // The app a tab belongs to: its launched repo if known, else the cwd's last
  // path segment. Rendered as a hash-coloured `#handle` pill so a busy grid is
  // scannable by project.
  const repoRef = (tab: TabInfo): string =>
    tab.repo?.trim() || tab.cwd.split('/').filter(Boolean).pop() || '';
  // The program driving the tab — the first token of the command (basename), so
  // a card shows "claude" / "pi" / "make" next to the repo. Empty cmd → shell.
  const agentName = (tab: TabInfo): string => {
    const first = tab.cmd?.trim().split(/\s+/)[0] ?? '';
    return first.split('/').pop() || 'shell';
  };
  // For an awaiting tab, the blocking question is the headline; otherwise the
  // model's one-line current action.
  const cardAction = (summary: TabSummary): string =>
    summary.state === 'awaiting' && summary.awaitingPrompt
      ? summary.awaitingPrompt
      : summary.currentAction;

  // The badge state to render for a card: a tab being recomputed this cycle
  // reads "summarizing" (transient), otherwise its own pending/summarized state.
  // 'pending' and 'summarizing' are display-only states, not TabStates.
  const cardState = (
    sid: string,
    base: TabState | 'pending',
  ): TabState | 'pending' | 'summarizing' => (summarizingSids().has(sid) ? 'summarizing' : base);
  // Human label for a card's badge, covering the two display-only states.
  const cardStateLabel = (display: TabState | 'pending' | 'summarizing'): string =>
    display === 'summarizing'
      ? 'Summarizing'
      : display === 'pending'
        ? 'Starting'
        : STATE_LABEL[display];

  // Cross-tab state tally for the chip row above the grid — counted over the
  // live summarized tabs (state().tabs holds only still-open ones).
  const tally = (): Record<TabState, number> => {
    const counts: Record<TabState, number> = { working: 0, awaiting: 0, idle: 0, error: 0 };
    for (const tab of state()?.tabs ?? []) counts[tab.state] += 1;
    return counts;
  };

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

  // The single contextual hint shown above the status strip when the engine
  // can't produce summaries (off / no key / no open tabs). Null when there's
  // nothing to say, so the header is omitted entirely rather than leaving an
  // empty gap where the old "Dashboard" heading used to sit.
  const headerHint = (): string | null => {
    const cfg = config();
    if (!cfg) return null;
    if (!cfg.enabled)
      return 'Live tab summaries are off. Enable them and set a DeepSeek API key in Settings → Dashboard.';
    if (!cfg.hasApiKey) return 'No DeepSeek API key set. Add one in Settings → Dashboard.';
    if (roster().length === 0 && !state()?.lastError) return 'No open terminal tabs to summarize…';
    return null;
  };

  return (
    <div class="dashboard-pane">
      {/* No standing title — the pane lives under the "DASHBOARD" tab, so a
          second "Dashboard" heading was pure redundancy. The header now carries
          only a contextual hint, and only when there is one. */}
      <Show when={headerHint()}>
        {(hint) => (
          <header class="dashboard-pane-header">
            <p class="dashboard-pane-hint">{hint()}</p>
          </header>
        )}
      </Show>

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
        <section class="dashboard-status" data-phase={engine()?.phase ?? 'idle'}>
          <span class="dashboard-status-item">
            <span class="dashboard-status-dot" />
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
            {/* Header row: title + the cross-tab state tally — the cockpit's
                at-a-glance triage readout. A chip per non-empty state. */}
            <div class="dashboard-tab-head">
              <h3>Open tabs{cards().length > 0 ? ` · ${cards().length}` : ''}</h3>
              <Show
                when={(['working', 'awaiting', 'idle', 'error'] as const).some(
                  (s) => tally()[s] > 0,
                )}
              >
                <div class="dashboard-tally">
                  <For
                    each={(['working', 'awaiting', 'idle', 'error'] as const).filter(
                      (s) => tally()[s] > 0,
                    )}
                  >
                    {(s) => (
                      <span class="dashboard-tally-chip" data-state={s}>
                        <b>{tally()[s]}</b> {STATE_LABEL[s].toLowerCase()}
                      </span>
                    )}
                  </For>
                </div>
              </Show>
            </div>
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
                        <li
                          class="dashboard-tab-card dashboard-tab-card-pending"
                          data-state={cardState(card.tab.sid, 'pending')}
                        >
                          <div class="dashboard-tab-card-head">
                            <span
                              class="dashboard-tab-state"
                              data-state={cardState(card.tab.sid, 'pending')}
                            >
                              <span class="dashboard-tab-state-dot" />
                              {cardStateLabel(cardState(card.tab.sid, 'pending'))}
                            </span>
                            <span class="dashboard-tab-card-meta">
                              <Show when={repoRef(card.tab)}>
                                <span
                                  class={`dashboard-repo-pill ${appColorClass(repoRef(card.tab))}`}
                                >
                                  {appPillText(repoRef(card.tab))}
                                </span>
                              </Show>
                              <span class="dashboard-tab-agent">{agentName(card.tab)}</span>
                              {/* The SUMMARIZING badge already says it's in
                                  flight; don't repeat "summarizing…" here. */}
                              <Show when={!summarizingSids().has(card.tab.sid)}>
                                <span class="dashboard-tab-card-time">{pendingTimeText()}</span>
                              </Show>
                            </span>
                          </div>
                          <div class="dashboard-tab-card-title">{tabLabel(card.tab)}</div>
                          <ul class="dashboard-tab-card-context">
                            <li>Directory: {card.tab.cwd}</li>
                            <li>
                              Waiting for first agent output (a submitted prompt or finished turn).
                            </li>
                          </ul>
                        </li>
                      }
                    >
                      {(summary) => (
                        <li
                          class="dashboard-tab-card"
                          data-state={cardState(summary().sid, summary().state)}
                        >
                          <div class="dashboard-tab-card-head">
                            <span
                              class="dashboard-tab-state"
                              data-state={cardState(summary().sid, summary().state)}
                            >
                              <span class="dashboard-tab-state-dot" />
                              {cardStateLabel(cardState(summary().sid, summary().state))}
                            </span>
                            <span class="dashboard-tab-card-meta">
                              <Show when={repoRef(card.tab)}>
                                <span
                                  class={`dashboard-repo-pill ${appColorClass(repoRef(card.tab))}`}
                                >
                                  {appPillText(repoRef(card.tab))}
                                </span>
                              </Show>
                              <span class="dashboard-tab-agent">{agentName(card.tab)}</span>
                              <span
                                class="dashboard-tab-card-time"
                                title={fmtTime(summary().updatedAt)}
                              >
                                {fmtRelative(summary().updatedAt)}
                              </span>
                            </span>
                          </div>
                          <div class="dashboard-tab-card-title">{summary().title}</div>
                          <Show when={cardAction(summary())}>
                            <p class="dashboard-tab-card-action">{cardAction(summary())}</p>
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
