import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type { DashboardConfigView, DashboardState } from '@shared/types';
import './dashboard-pane.css';

/**
 * The Dashboard working surface: a detailed, always-current view of what the
 * terminal tabs are doing. Renders the cross-tab overview, a card per tab
 * (title, current action, context, recent events), and a global event history.
 * Self-contained — subscribes to the engine's pushed state and seeds from the
 * last snapshot on mount.
 */
export function DashboardView() {
  const [state, setState] = createSignal<DashboardState | null>(null);
  const [config, setConfig] = createSignal<DashboardConfigView | null>(null);

  onMount(() => {
    void window.condash.dashboardGetState().then(setState);
    void window.condash.dashboardGetConfigView().then(setConfig);
  });
  const offState = window.condash.onDashboardState((next) => setState(next));
  onCleanup(offState);

  const tabs = () => state()?.tabs ?? [];
  const overview = () => state()?.overview ?? [];
  const history = () => state()?.history ?? [];
  const fmtTime = (ms: number): string => new Date(ms).toLocaleTimeString();

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
        <Show when={state()?.lastError}>
          <p class="dashboard-pane-error">Last API error: {state()!.lastError}</p>
        </Show>
      </header>

      <Show when={overview().length > 0}>
        <section class="dashboard-section">
          <h3>What's going on</h3>
          <ul class="dashboard-overview">
            <For each={overview()}>{(line) => <li>{line}</li>}</For>
          </ul>
        </section>
      </Show>

      <section class="dashboard-section">
        <h3>Tabs</h3>
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
                    <span class="dashboard-tab-card-sid">{tab.sid}</span>
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
