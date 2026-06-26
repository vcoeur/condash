import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type { DashboardConfigView, DashboardState } from '@shared/types';
import './dashboard-pane.css';

/**
 * The Dashboard working surface: a detailed, always-current view of what the
 * terminal tabs are doing. Renders the active summarizer settings, any last
 * summarization error, the cross-tab overview, a card per recently-modified tab
 * (most-recent first, with title, current action, context, recent events), and
 * a global event history. Self-contained — subscribes to the engine's pushed
 * state and seeds from the last snapshot on mount.
 */
export function DashboardView() {
  const [state, setState] = createSignal<DashboardState | null>(null);
  const [config, setConfig] = createSignal<DashboardConfigView | null>(null);

  const refreshConfig = (): void => {
    void window.condash.dashboardGetConfigView().then(setConfig);
  };

  onMount(() => {
    void window.condash.dashboardGetState().then(setState);
    refreshConfig();
  });
  // Re-read the config view alongside each pushed state so the settings panel
  // tracks edits made in Settings while the Dashboard is open (the engine
  // re-reads its config every cycle; this keeps the displayed copy in step).
  const offState = window.condash.onDashboardState((next) => {
    setState(next);
    refreshConfig();
  });
  onCleanup(offState);

  // Most-recently-updated tab first, so the list reads as "recently modified".
  const tabs = () => [...(state()?.tabs ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
  const overview = () => state()?.overview ?? [];
  const history = () => state()?.history ?? [];

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
            config()?.enabled && config()?.hasApiKey && tabs().length === 0 && !state()?.lastError
          }
        >
          <p class="dashboard-pane-hint">Waiting for active tabs to summarize…</p>
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

      <Show when={config()}>
        {(cfg) => (
          <section class="dashboard-section">
            <h3>Settings</h3>
            <dl class="dashboard-settings">
              <dt>Status</dt>
              <dd>{statusLabel(cfg())}</dd>
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

      <Show when={overview().length > 0}>
        <section class="dashboard-section">
          <h3>What's going on</h3>
          <ul class="dashboard-overview">
            <For each={overview()}>{(line) => <li>{line}</li>}</For>
          </ul>
        </section>
      </Show>

      <section class="dashboard-section">
        <h3>Recently modified tabs</h3>
        <Show
          when={tabs().length > 0}
          fallback={<p class="dashboard-pane-hint">No active tab summaries yet.</p>}
        >
          <ul class="dashboard-tab-list">
            <For each={tabs()}>
              {(tab) => (
                <li class="dashboard-tab-card">
                  <div class="dashboard-tab-card-head">
                    <span class="dashboard-tab-card-title">{tab.title}</span>
                    <span class="dashboard-tab-card-time" title={fmtTime(tab.updatedAt)}>
                      {fmtRelative(tab.updatedAt)}
                    </span>
                  </div>
                  <Show when={tab.currentAction}>
                    <p class="dashboard-tab-card-action">{tab.currentAction}</p>
                  </Show>
                  <Show when={tab.contextLines.length > 0}>
                    <ul class="dashboard-tab-card-context">
                      <For each={tab.contextLines}>{(line) => <li>{line}</li>}</For>
                    </ul>
                  </Show>
                  <Show when={tab.events.length > 0}>
                    <details class="dashboard-tab-card-events">
                      <summary>Recent events</summary>
                      <ul>
                        <For each={[...tab.events].reverse()}>
                          {(ev) => (
                            <li>
                              <span class="dashboard-event-time">{fmtTime(ev.at)}</span> {ev.text}
                            </li>
                          )}
                        </For>
                      </ul>
                    </details>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>

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

      <Show when={state()?.updatedAt}>
        <footer class="dashboard-pane-footer">Updated {fmtTime(state()!.updatedAt)}</footer>
      </Show>
    </div>
  );
}
