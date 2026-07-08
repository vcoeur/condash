import { createMemo, onCleanup, type Accessor } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
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
  // A Solid store fed by `reconcile(..., { key: 'id' })` — the same pattern
  // projects-store / repos-store use — so an unchanged `TermSession` keeps its
  // object identity across pushes. The main process rebroadcasts the FULL
  // snapshot on any change (e.g. the 2.5 s memory sampler), and a plain signal
  // replaced the whole array with fresh IPC-cloned objects each time — so every
  // `<For>`-keyed `CodeRunRow` was disposed and recreated, resetting its
  // `expanded` signal and destroying its mounted mini-xterm (an expanded live run
  // visibly collapsed every 2.5 s — review finding T6/R3). Reconcile keeps the
  // identity, so the row and its terminal survive; the derived memos read
  // fine-grained, so a memBytes-only change on a `my`-side tab retriggers none of
  // them (they read `repo` / `exited` / `side` / `cwd`, never `memBytes`).
  const [box, setBox] = createStore<{ list: TermSession[] }>({ list: [] });
  const allSessions: Accessor<readonly TermSession[]> = () => box.list;

  const liveRepos = createMemo<ReadonlySet<string>>(() => {
    const live = new Set<string>();
    for (const s of box.list) {
      if (s.repo && s.exited === undefined) live.add(s.repo);
    }
    return live;
  });

  const liveSessionCwds = createMemo<ReadonlyMap<string, string>>(() => {
    const out = new Map<string, string>();
    for (const s of box.list) {
      if (!s.repo || s.exited !== undefined) continue;
      if (s.cwd) out.set(s.repo, s.cwd);
    }
    return out;
  });

  const codeRunSessions = createMemo<readonly TermSession[]>(() =>
    box.list.filter((s) => s.side === 'code'),
  );

  let hasReceivedEvent = false;
  const offTermSessions = window.condash.onTermSessions((sessions) => {
    hasReceivedEvent = true;
    setBox('list', reconcile(sessions as TermSession[], { key: 'id' }));
  });
  void window.condash.termList().then((sessions) => {
    if (!hasReceivedEvent) setBox('list', reconcile(sessions as TermSession[], { key: 'id' }));
  });
  onCleanup(offTermSessions);

  return { allSessions, liveRepos, liveSessionCwds, codeRunSessions };
}
