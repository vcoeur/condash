import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type {
  ActivityStage,
  DashboardConfigView,
  DashboardState,
  TabInfo,
  TabState,
  TabSummary,
} from '@shared/types';
import './dashboard-pane.css';

/** Human label for the health state, used on the card's state-dot tooltip. */
const STATE_LABEL: Record<TabState, string> = {
  working: 'Working',
  awaiting: 'Awaiting you',
  idle: 'Idle',
  error: 'Error',
};

/** Human label for the finer work-stage activity badge. */
const ACTIVITY_LABEL: Record<ActivityStage, string> = {
  implementing: 'Implementing',
  designing: 'Designing',
  reviewing: 'Reviewing',
  'making-pr': 'Making PR',
  documenting: 'Documenting',
  testing: 'Testing',
  debugging: 'Debugging',
  researching: 'Researching',
  awaiting: 'Awaiting',
  idle: 'Idle',
};

/** The per-state tallies always shown in the top status line, in this order. */
const TALLY_STATES: readonly TabState[] = ['working', 'awaiting', 'idle'];

/** One rendered breadcrumb segment under a card's title. */
interface Crumb {
  /** Visible text of the segment. */
  text: string;
  /** Full value for the hover tooltip when `text` may be truncated. */
  full?: string;
  /** Render in the mono face (used for the `#app` and `wt:` provenance crumbs). */
  mono?: boolean;
  /** A trailing `+N` more-projects affordance, when several projects match. */
  extra?: string;
  /** Tooltip listing the remaining project titles behind `extra`. */
  extraTitle?: string;
  /** Click handler to open the crumb's target. */
  onClick?: () => void;
}

/**
 * The Dashboard working surface: a Direction-B "breadcrumb" view of what the
 * terminal tabs are doing. A single thin top status line (product label +
 * on/off dot, live tab tallies, last-update time, and a hover popover with the
 * full summarizer config) sits above a responsive grid of tab cards. Each card
 * leads with a minimal header (health dot + age + per-tab update button), then a
 * title with an activity badge, a provenance breadcrumb (`#app › wt:branch ›
 * project`), a one-sentence subtitle, and a short recent-actions timeline. A tab
 * with no summary yet keeps a graceful fallback so it is never invisible.
 * Self-contained — subscribes to the engine's pushed state and seeds from the
 * last snapshot on mount.
 */
export function DashboardView(props: {
  /** Jump to the terminal tab a card summarizes (its `sid`). When set, each
   *  card becomes a button that activates that tab and shows the terminal band. */
  onOpenTab?: (sid: string) => void;
}) {
  const [state, setState] = createSignal<DashboardState | null>(null);
  const [config, setConfig] = createSignal<DashboardConfigView | null>(null);
  // Local 1s clock so relative ages ("3m") and the pending next-attempt hint
  // tick live between the engine's pushes (which only arrive on a real change).
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
  // Re-read the config view alongside each pushed state so the hover popover
  // tracks edits made in Settings while the Dashboard is open.
  const offState = window.condash.onDashboardState((next) => {
    setState(next);
    refreshConfig();
  });
  onCleanup(offState);

  const roster = (): TabInfo[] => state()?.roster ?? [];
  const engine = () => state()?.engine;
  // The tabs whose summary is being recomputed in the in-flight cycle. A card
  // whose sid is in here shows a small pulsing marker; its own state badge and
  // colour are untouched.
  const summarizingSids = createMemo(() => new Set(state()?.summarizingSids ?? []));

  // The per-card "Update now" button forces an immediate re-summarization of one
  // tab. Only meaningful — and only shown — when the engine can actually run a
  // summary (enabled with a key); the main process no-ops otherwise.
  const canRefresh = (): boolean => !!config()?.enabled && !!config()?.hasApiKey;
  const refreshCard = (sid: string): void => {
    void window.condash.dashboardRefreshTab(sid);
  };
  // Small ghost button shared by both card variants. Disabled while this card's
  // summary is already being recomputed so a double-click can't queue two runs.
  const refreshButton = (sid: string) => (
    <Show when={canRefresh()}>
      <button
        type="button"
        class="dashboard-tab-refresh"
        title="Re-summarize this tab now"
        disabled={summarizingSids().has(sid)}
        // stopPropagation: keep the card's open-tab click from also firing.
        onClick={(e) => {
          e.stopPropagation();
          refreshCard(sid);
        }}
      >
        Update
      </button>
    </Show>
  );

  // Whole-card affordance: a card is a link to the terminal tab it summarizes.
  // Only wired when the host passes `onOpenTab`; inner controls (crumb links,
  // the Update button) stopPropagation so they keep their own action.
  const cardClickProps = (sid: string) =>
    props.onOpenTab
      ? {
          role: 'button' as const,
          tabindex: 0,
          title: 'Open this terminal tab',
          onClick: () => props.onOpenTab!(sid),
          // Guard on target === currentTarget so Enter/Space on an inner button
          // (crumb / Update) doesn't also open the tab via the bubbled keydown.
          onKeyDown: (e: KeyboardEvent & { currentTarget: HTMLElement; target: Element }) => {
            if (e.currentTarget !== e.target) return;
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              props.onOpenTab!(sid);
            }
          },
        }
      : {};

  // Cross-tab state tally for the top line — counted over the live summarized
  // tabs (state().tabs holds only still-open ones). Memoised: the top line reads
  // it up to 4× per render (three tallies + the error Show/count), and it should
  // recompute only when the pushed state changes, not per read.
  const tally = createMemo<Record<TabState, number>>(() => {
    const counts: Record<TabState, number> = { working: 0, awaiting: 0, idle: 0, error: 0 };
    for (const tab of state()?.tabs ?? []) counts[tab.state] += 1;
    return counts;
  });

  // One card per open tab: a summarized tab carries its rich summary; an
  // as-yet-unsummarized tab gets a fallback drawn from its command/cwd — so no
  // open tab is ever missing. Cards stay in roster order so they always line up
  // with the tab strip. Memoised — read both by the grid's `length` guard and
  // its `<For>`, so it should build the roster×summary join once per state push.
  const cards = createMemo<Array<{ tab: TabInfo; summary?: TabSummary }>>(() => {
    const bySid = new Map((state()?.tabs ?? []).map((tab) => [tab.sid, tab]));
    return roster().map((tab) => ({ tab, summary: bySid.get(tab.sid) }));
  });

  // Fallback label for a tab with no summary yet: the command, else the cwd's
  // last path segment, else the sid.
  const tabLabel = (tab: TabInfo): string => tab.cmd?.trim() || dirName(tab) || tab.sid;
  const dirName = (tab: TabInfo): string => tab.cwd.split('/').filter(Boolean).pop() ?? '';

  // The provenance breadcrumb under a card title — only the segments that exist,
  // so missing app / worktree / project carry no dangling separator. Each segment
  // is clickable when the main process supplied a path.
  const breadcrumb = (summary: TabSummary): Crumb[] => {
    const crumbs: Crumb[] = [];
    if (summary.app) {
      crumbs.push({
        text: `#${summary.app}`,
        full: summary.app,
        mono: true,
        onClick: summary.appPath ? () => void window.condash.openPath(summary.appPath!) : undefined,
      });
    }
    if (summary.worktree) {
      crumbs.push({
        text: `wt:${summary.worktree}`,
        full: summary.worktree,
        mono: true,
        onClick: summary.worktreePath
          ? () => void window.condash.openPath(summary.worktreePath!)
          : undefined,
      });
    }
    const projects = summary.projects ?? [];
    if (projects.length === 1) {
      crumbs.push({
        text: projects[0].title,
        full: projects[0].title,
        onClick: projects[0].readmePath
          ? () => void window.condash.openInEditor(projects[0].readmePath!)
          : undefined,
      });
    } else if (projects.length > 1) {
      crumbs.push({
        text: projects[0].title,
        full: projects[0].title,
        extra: `+${projects.length - 1}`,
        extraTitle: projects
          .slice(1)
          .map((project) => project.title)
          .join('\n'),
        onClick: projects[0].readmePath
          ? () => void window.condash.openInEditor(projects[0].readmePath!)
          : undefined,
      });
    }
    return crumbs;
  };

  const fmtTime = (ms: number): string => new Date(ms).toLocaleTimeString();
  // HH:MM for the top line's "updated" stamp.
  const fmtClock = (ms: number): string =>
    new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // Compact relative age ("now" / "12s" / "3m" / "2h"), reactive on the 1s clock.
  const fmtAge = (ms: number): string => {
    const seconds = Math.max(0, Math.round((nowMs() - ms) / 1000));
    if (seconds < 5) return 'now';
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.round(minutes / 60)}h`;
  };

  // The age-slot text for a pending card: the engine's next attempt if it is
  // counting down, else a flat "pending".
  const pendingHint = (): string => {
    const status = engine();
    if (
      status &&
      (status.phase === 'waiting' || status.phase === 'idle' || status.phase === 'summarizing')
    ) {
      const secs = Math.max(0, Math.round((status.nextRunAt - nowMs()) / 1000));
      return secs <= 0 ? 'soon' : `in ${secs}s`;
    }
    return 'pending';
  };

  // The on/off dot state and label for the top line. Engine phase can override
  // the plain "on" state when the engine is in backoff after repeated failures.
  const powerState = (cfg: DashboardConfigView): 'on' | 'off' | 'nokey' | 'backoff' => {
    if (!cfg.enabled) return 'off';
    if (!cfg.hasApiKey) return 'nokey';
    if (engine()?.phase === 'backoff') return 'backoff';
    return 'on';
  };
  const powerLabel = (cfg: DashboardConfigView): string => {
    if (!cfg.enabled) return 'Off';
    if (!cfg.hasApiKey) return 'On · no key';
    if (engine()?.phase === 'backoff') return 'On · backoff';
    return 'On';
  };
  const endpointLabel = (cfg: DashboardConfigView): string =>
    cfg.baseUrl?.trim() ? cfg.baseUrl : 'DeepSeek (default)';

  // Actionable guidance shown under the top line only when the engine can't
  // produce summaries at all (off / no key). The empty-tab case is handled by
  // the grid's own fallback.
  const headerHint = (): string | null => {
    const cfg = config();
    if (!cfg) return null;
    if (!cfg.enabled)
      return 'Live tab summaries are off. Enable them and set a DeepSeek API key in Settings → Dashboard.';
    if (!cfg.hasApiKey) return 'No DeepSeek API key set. Add one in Settings → Dashboard.';
    return null;
  };

  return (
    <div class="dashboard-pane">
      {/* Thin top status line: product label + on/off dot, live tab tallies,
          last-update time, and a hover popover carrying the full config. */}
      <Show when={config()}>
        {(cfg) => (
          <header class="dashboard-topline">
            <span class="dashboard-topline-brand">
              condash<span class="dashboard-topline-mark"> ▸ </span>dashboard
            </span>
            <span class="dashboard-topline-power" data-power={powerState(cfg())}>
              <span class="dashboard-topline-power-dot" />
              {powerLabel(cfg())}
            </span>
            <span class="dashboard-topline-tallies">
              <span class="dashboard-topline-tally">
                <b>{roster().length}</b> tabs
              </span>
              <For each={TALLY_STATES}>
                {(s) => (
                  <span class="dashboard-topline-tally" data-state={s}>
                    <b>{tally()[s]}</b> {s}
                  </span>
                )}
              </For>
              <Show when={tally().error > 0}>
                <span class="dashboard-topline-tally" data-state="error">
                  <b>{tally().error}</b> error
                </span>
              </Show>
            </span>
            <span class="dashboard-topline-updated">
              <Show when={state()?.updatedAt} fallback="not yet run">
                updated {fmtClock(state()!.updatedAt)}
              </Show>
            </span>
            {/* Hover/focus reveals the full summarizer config. Secrets stay out —
                only "set"/"missing" for the API key, never the key itself. */}
            <span class="dashboard-topline-config" tabindex="0">
              config
              <div class="dashboard-topline-config-pop" role="tooltip">
                <dl>
                  <dt>Provider</dt>
                  <dd>{cfg().provider}</dd>
                  <dt>Card model</dt>
                  <dd>
                    {cfg().model}
                    {cfg().cardReasoning ? ' · reasoning on' : ' · reasoning off'}
                  </dd>
                  <dt>Writer model</dt>
                  <dd>
                    {cfg().writerModel}
                    {cfg().writerReasoning ? ' · reasoning on' : ' · reasoning off'}
                  </dd>
                  <dt>Endpoint</dt>
                  <dd>{endpointLabel(cfg())}</dd>
                  <dt>Interval</dt>
                  <dd>{cfg().intervalSec}s</dd>
                  <dt>Activity gate</dt>
                  <dd>{cfg().gateOnActivity ? 'On — only changed tabs' : 'Off — every tab'}</dd>
                  <dt>Skip idle</dt>
                  <dd>{cfg().skipIdle ? 'On' : 'Off'}</dd>
                  <dt>API key</dt>
                  <dd>{cfg().hasApiKey ? 'set' : 'missing'}</dd>
                </dl>
              </div>
            </span>
          </header>
        )}
      </Show>

      <Show when={headerHint()}>{(hint) => <p class="dashboard-pane-hint">{hint()}</p>}</Show>

      {/* A failed summarization cycle (auth / model / network) would otherwise be
          a silent no-op — the tab titles just stop updating. The banner explains. */}
      <Show when={state()?.lastError}>
        <div class="dashboard-error-banner" role="alert">
          <span class="dashboard-error-banner-label">Last summary failed</span>
          <span class="dashboard-error-banner-msg">{state()!.lastError}</span>
        </div>
      </Show>

      <Show
        when={cards().length > 0}
        fallback={<p class="dashboard-pane-hint">No open terminal tabs to summarize.</p>}
      >
        <ul class="dashboard-card-grid">
          <For each={cards()}>
            {(card) => (
              <Show
                when={card.summary}
                fallback={
                  // No summary yet: the tab stays visible, drawn from its
                  // command/cwd, with the engine's next-attempt hint.
                  <li
                    class="dashboard-card dashboard-card-pending"
                    classList={{ 'is-openable': !!props.onOpenTab }}
                    data-state="pending"
                    {...cardClickProps(card.tab.sid)}
                  >
                    <div class="dashboard-card-head">
                      <span class="dashboard-card-dot" title="Starting" />
                      <span class="dashboard-card-head-right">
                        <Show when={summarizingSids().has(card.tab.sid)}>
                          <span class="dashboard-tab-summarizing" title="Summarizing…" />
                        </Show>
                        <span class="dashboard-card-age">{pendingHint()}</span>
                        {refreshButton(card.tab.sid)}
                      </span>
                    </div>
                    <div class="dashboard-card-title-row">
                      <div class="dashboard-card-title" title={tabLabel(card.tab)}>
                        {tabLabel(card.tab)}
                      </div>
                      <span class="dashboard-card-activity" data-activity="idle">
                        Starting
                      </span>
                    </div>
                    <Show when={dirName(card.tab)}>
                      <div class="dashboard-card-breadcrumb">
                        <span class="dashboard-card-crumb is-mono" title={card.tab.cwd}>
                          {dirName(card.tab)}
                        </span>
                      </div>
                    </Show>
                    <p class="dashboard-card-subtitle">
                      Waiting for first agent output (a submitted prompt or finished turn).
                    </p>
                  </li>
                }
              >
                {(summary) => (
                  <li
                    class="dashboard-card"
                    classList={{ 'is-openable': !!props.onOpenTab }}
                    data-state={summary().state}
                    {...cardClickProps(summary().sid)}
                  >
                    <div class="dashboard-card-head">
                      <span
                        class="dashboard-card-dot"
                        data-state={summary().state}
                        title={STATE_LABEL[summary().state]}
                      />
                      <span class="dashboard-card-head-right">
                        <Show when={summarizingSids().has(summary().sid)}>
                          <span class="dashboard-tab-summarizing" title="Summarizing…" />
                        </Show>
                        <span class="dashboard-card-age" title={fmtTime(summary().updatedAt)}>
                          {fmtAge(summary().updatedAt)}
                        </span>
                        {refreshButton(summary().sid)}
                      </span>
                    </div>

                    <div class="dashboard-card-title-row">
                      <div class="dashboard-card-title" title={summary().title}>
                        {summary().title}
                      </div>
                      <span class="dashboard-card-activity" data-activity={summary().activity}>
                        {ACTIVITY_LABEL[summary().activity]}
                      </span>
                    </div>

                    <Show when={breadcrumb(summary()).length > 0}>
                      <div class="dashboard-card-breadcrumb">
                        <For each={breadcrumb(summary())}>
                          {(crumb, index) => (
                            <>
                              <Show when={index() > 0}>
                                <span class="dashboard-card-crumb-sep">›</span>
                              </Show>
                              <Show
                                when={crumb.onClick}
                                fallback={
                                  <span
                                    class="dashboard-card-crumb"
                                    classList={{ 'is-mono': !!crumb.mono }}
                                    title={crumb.full ?? crumb.text}
                                  >
                                    {crumb.text}
                                    <Show when={crumb.extra}>
                                      <span
                                        class="dashboard-card-crumb-more"
                                        title={crumb.extraTitle}
                                      >
                                        {crumb.extra}
                                      </span>
                                    </Show>
                                  </span>
                                }
                              >
                                <button
                                  type="button"
                                  class="dashboard-card-crumb is-clickable"
                                  classList={{ 'is-mono': !!crumb.mono }}
                                  title={crumb.full ?? crumb.text}
                                  // stopPropagation: a crumb opens its own target
                                  // (app / worktree / project), not the tab.
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    crumb.onClick?.();
                                  }}
                                >
                                  {crumb.text}
                                  <Show when={crumb.extra}>
                                    <span
                                      class="dashboard-card-crumb-more"
                                      title={crumb.extraTitle}
                                    >
                                      {crumb.extra}
                                    </span>
                                  </Show>
                                </button>
                              </Show>
                            </>
                          )}
                        </For>
                      </div>
                    </Show>

                    <Show when={summary().subtitle}>
                      <p class="dashboard-card-subtitle">{summary().subtitle}</p>
                    </Show>

                    {/* An awaiting tab's blocking question — a tinted callout so it
                        pulls the eye and reads as actionable. */}
                    <Show when={summary().state === 'awaiting' && summary().awaitingPrompt}>
                      <p class="dashboard-card-awaiting">{summary().awaitingPrompt}</p>
                    </Show>

                    {/* Recent actions: up to four events, most recent first, with
                        relative timestamps — a visible feed, not a collapsed disclosure. */}
                    <Show when={summary().events.length > 0}>
                      <ul class="dashboard-card-actions">
                        <For each={[...summary().events].reverse().slice(0, 4)}>
                          {(ev) => (
                            <li>
                              <span class="dashboard-card-action-time" title={fmtTime(ev.at)}>
                                {fmtAge(ev.at)}
                              </span>
                              <span class="dashboard-card-action-text" title={ev.text}>
                                {ev.text}
                              </span>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </li>
                )}
              </Show>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
