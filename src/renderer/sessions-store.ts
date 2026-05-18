import { createMemo, createSignal, onCleanup, type Accessor } from 'solid-js';
import type { TermSession } from '../shared/types';

/**
 * Tracks every live-or-exited pty session the main process knows about.
 *
 * Two consumers in the renderer:
 *   - the Code pane's per-repo inline runner row (filtered through
 *     `codeRunSessions`, which keeps only the `side: 'code'` sessions);
 *   - the LIVE badge + "running on <branch>" label on repo cards
 *     (derived from `liveRepos` + `liveSessionCwds`).
 *
 * Both subscribe to the same snapshot, so a single `onTermSessions`
 * push from main updates both views in one frame.
 *
 * Seeds with `termList()` on mount — `onTermSessions` only fires on
 * change events, so without the initial pull a session inherited from
 * a prior renderer instance would not surface until the next
 * spawn / exit.
 */
export interface SessionsStore {
  /** Every session, live or exited, in main-process order. */
  allSessions: Accessor<readonly TermSession[]>;
  /** Set of repo names currently running at least one live session. */
  liveRepos: Accessor<ReadonlySet<string>>;
  /** Map of repo name → cwd of the live session for that repo. */
  liveSessionCwds: Accessor<ReadonlyMap<string, string>>;
  /** Just the `side: 'code'` slice — what the Code pane runner wants. */
  codeRunSessions: Accessor<readonly TermSession[]>;
}

export function createSessionsStore(): SessionsStore {
  const [allSessions, setAllSessions] = createSignal<readonly TermSession[]>([]);

  const liveRepos = createMemo<ReadonlySet<string>>(() => {
    const live = new Set<string>();
    for (const s of allSessions()) {
      if (s.repo && s.exited === undefined) live.add(s.repo);
    }
    return live;
  });

  const liveSessionCwds = createMemo<ReadonlyMap<string, string>>(() => {
    const out = new Map<string, string>();
    for (const s of allSessions()) {
      if (!s.repo || s.exited !== undefined) continue;
      if (s.cwd) out.set(s.repo, s.cwd);
    }
    return out;
  });

  const codeRunSessions = createMemo<readonly TermSession[]>(() =>
    allSessions().filter((s) => s.side === 'code'),
  );

  let hasReceivedEvent = false;
  const offTermSessions = window.condash.onTermSessions((sessions) => {
    hasReceivedEvent = true;
    setAllSessions(sessions);
  });
  void window.condash.termList().then((sessions) => {
    if (!hasReceivedEvent) setAllSessions(sessions);
  });
  onCleanup(offTermSessions);

  return { allSessions, liveRepos, liveSessionCwds, codeRunSessions };
}
