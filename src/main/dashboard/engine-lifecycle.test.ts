/**
 * E3 lifecycle test for the dashboard engine: a tick whose LLM round-trips
 * straddle a conception switch/teardown must abort at the generation guard
 * before it overwrites the (already reset) module state or persists the old
 * tree's cards. `summarizeTab` is a controllable gate held open across the
 * switch; `saveDashboardState` (only reached after the guard) is the observable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardConfig, DashboardState, TabInfo } from '../../shared/types';
import type { SummaryOwner, TabInput, TabSummaryResult } from './summarizer';

const h = vi.hoisted(() => {
  let resolveSummarize: ((v: TabSummaryResult | null) => void) | null = null;
  let gate: Promise<TabSummaryResult | null> = Promise.resolve(null);
  return {
    tabs: [] as TabInfo[],
    bytes: new Map<string, number>(),
    recent: new Map<string, string>(),
    config: null as DashboardConfig | null,
    summarizeTab: vi.fn<typeof import('./summarizer').summarizeTab>(() => gate),
    writeCard: vi.fn<typeof import('./summarizer').writeCard>(async () => ({
      title: 'T',
      subtitle: 'S',
    })),
    deriveProvenance: vi.fn<typeof import('./provenance').deriveProvenance>(async () => ({})),
    saveDashboardState: vi.fn<typeof import('./state').saveDashboardState>(async () => {}),
    loadDashboardState: vi.fn<typeof import('./state').loadDashboardState>(async () => null),
    armGate: () => {
      gate = new Promise((res) => {
        resolveSummarize = res;
      });
    },
    releaseSummarize: (v: TabSummaryResult | null) => resolveSummarize?.(v),
    resetGate: () => {
      gate = Promise.resolve(null);
      resolveSummarize = null;
    },
  };
});

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../terminals', () => ({
  dashboardRoster: () => h.tabs,
  tabsBytes: () => h.bytes,
  tabRecentText: (sid: string) => h.recent.get(sid) ?? '',
}));
vi.mock('./config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config')>();
  return { ...actual, readDashboardConfig: vi.fn(async () => h.config!) };
});
vi.mock('./summarizer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./summarizer')>();
  return { ...actual, summarizeTab: h.summarizeTab, writeCard: h.writeCard };
});
vi.mock('./provenance', () => ({ deriveProvenance: h.deriveProvenance }));
vi.mock('./state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./state')>();
  return {
    ...actual,
    loadDashboardState: h.loadDashboardState,
    saveDashboardState: h.saveDashboardState,
  };
});

import {
  getBackoffDelayMs,
  getDashboardState,
  refreshTab,
  setDashboardConception,
  tick,
} from './engine';
import { DASHBOARD_DEFAULTS, readDashboardConfig } from './config';

const TREE_A = '/tmp/condash-engine-tree-a';
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const summary = {
  title: 'old-tree card',
  contextLines: [],
  currentAction: 'doing',
  state: 'working' as const,
  activity: 'implementing' as const,
};

beforeEach(() => {
  h.summarizeTab.mockClear();
  h.saveDashboardState.mockClear();
  h.resetGate();
  h.summarizeTab.mockImplementation(() => Promise.resolve(null));
  h.writeCard.mockReset().mockImplementation(async () => ({ title: 'T', subtitle: 'S' }));
  h.deriveProvenance.mockReset().mockImplementation(async () => ({}));
  h.saveDashboardState.mockReset().mockImplementation(async () => {});
  h.loadDashboardState.mockReset().mockImplementation(async () => null);
  h.config = {
    ...DASHBOARD_DEFAULTS,
    enabled: true,
    apiKey: 'fixture',
    gateOnActivity: false,
    skipIdle: false,
    intervalSec: 120,
  };
  h.tabs = [{ sid: 's1', cwd: '/w', cmd: 'claude' }];
  h.bytes = new Map([['s1', 100]]);
  h.recent = new Map([['s1', 'recent output line']]);
  vi.mocked(readDashboardConfig)
    .mockReset()
    .mockImplementation(async () => h.config!);
});

afterEach(async () => {
  await setDashboardConception(null);
  for (const release of releases.splice(0)) release();
  await drain();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('dashboard engine lifecycle (E3)', () => {
  it('harness sanity: a normal cycle reaches saveDashboardState', async () => {
    // Gate returns null → summarizeTab yields no card, but the tick still
    // completes and persists the resting state.
    await setDashboardConception(TREE_A);
    await vi.waitFor(() => expect(h.saveDashboardState).toHaveBeenCalled());
  });

  it('a teardown mid-cycle aborts before persisting old-tree state', async () => {
    h.armGate();
    h.summarizeTab.mockImplementation(() => {
      // Use the legacy harness's controllable promise for this original regression.
      return new Promise((resolve) => {
        releases.push(() => resolve(null));
        h.releaseSummarize = resolve;
      });
    });
    await setDashboardConception(TREE_A); // fires an immediate tick that gates
    await vi.waitFor(() => expect(h.summarizeTab).toHaveBeenCalledTimes(1));
    // Tear down mid-cycle: resets state + bumps the generation the tick captured.
    await setDashboardConception(null);
    h.saveDashboardState.mockClear();
    // Release the old cycle's summarize; it resumes AFTER teardown and must bail
    // at the generation guard before it clobbers state or persists.
    h.releaseSummarize(summary);
    await flush();
    expect(h.saveDashboardState).not.toHaveBeenCalled();
  });
});

const releases: (() => void)[] = [];
async function drain(): Promise<void> {
  for (let i = 0; i < 150; i++) await Promise.resolve();
}
function held<T>(fallback: T) {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  releases.push(() => resolve(fallback));
  return { promise, resolve, reject };
}
function roster(sids: string[]) {
  h.tabs = sids.map((sid) => ({ sid, cwd: '/w', cmd: 'fixture' }));
  for (const sid of sids) {
    if (!h.bytes.has(sid)) h.bytes.set(sid, 100);
    if (!h.recent.has(sid)) h.recent.set(sid, `output ${sid}`);
  }
}
async function armEmpty() {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  vi.spyOn(Math, 'random').mockReturnValue(0);
  roster([]);
  h.recent = new Map();
  await setDashboardConception(TREE_A);
  await drain();
}
const starts = () => h.summarizeTab.mock.calls.map((call) => (call[1] as TabInput).sid);

describe('approved dashboard full-job dispatcher', () => {
  it('actual-source finite manual stress admits all twelve scheduled tabs by 2400 virtual ms with 223 full calls', async () => {
    await armEmpty();
    const actual = await vi.importActual<typeof import('./summarizer')>('./summarizer');
    h.summarizeTab.mockImplementation(actual.summarizeTab);
    h.writeCard.mockImplementation(actual.writeCard);
    h.config!.model = 'card';
    h.config!.writerModel = 'writer';
    const admissions: { sid: string; at: number }[] = [];
    let cards = 0;
    let writers = 0;
    let pending = 0;
    let peak = 0;
    const epoch = Date.now();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, options) => {
        const body = JSON.parse(options.body);
        const card = body.model === 'card';
        const text = body.messages[1].content;
        const sid = card
          ? text.match(/output ([sm]\d+)/)[1]
          : text.match(/Draft title.*: ([sm]\d+)/)[1];
        if (card) {
          cards++;
          admissions.push({ sid, at: Date.now() - epoch });
        } else writers++;
        peak = Math.max(peak, ++pending);
        await new Promise((resolve) => setTimeout(resolve, sid === 's0' ? 1000 : 100));
        pending--;
        if (card && sid === 's1') throw new Error('fixture rejection');
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify(
                    card ? { ...summary, title: sid } : { title: sid, subtitle: 'fixture' },
                  ),
                },
              },
            ],
          }),
        };
      }),
    );
    roster(Array.from({ length: 12 }, (_, i) => `s${i}`));
    const batch = tick(TREE_A);
    const manual: Promise<void>[] = [];
    for (let i = 0; i < 100; i++)
      setTimeout(
        () => {
          roster([...h.tabs.map((tab) => tab.sid), `m${i}`]);
          manual.push(refreshTab(`m${i}`));
        },
        1 + i * 25,
      );
    await drain();
    await vi.advanceTimersByTimeAsync(2500);
    const scheduled = admissions.filter((entry) => entry.sid.startsWith('s'));
    expect(scheduled.map((entry) => entry.sid)).toEqual(
      Array.from({ length: 12 }, (_, i) => `s${i}`),
    );
    expect(scheduled.at(-1)?.at).toBe(2400);
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([batch, ...manual]);
    expect({ cards, writers, pending, peak }).toEqual({
      cards: 112,
      writers: 111,
      pending: 0,
      peak: 3,
    });
    expect(getDashboardState()?.summarizingSids).toEqual([]);
  });

  it.each(['null', 'reject', 'reported'])(
    'a manual %s attempt advances retry clock and admission byte baseline',
    async (outcome) => {
      await armEmpty();
      roster(['a']);
      h.summarizeTab.mockImplementation(async (_config, _input, owner?: SummaryOwner) => {
        if (outcome === 'reject') throw new Error('fixture rejection');
        if (outcome === 'reported') owner!.reportError('fixture error');
        return null;
      });
      await refreshTab('a');
      await tick(TREE_A);
      expect(starts()).toEqual(['a']);
      h.config!.gateOnActivity = true;
      vi.setSystemTime(Date.now() + 121_000);
      await tick(TREE_A); // unchanged output is gate-held, even after a failed attempt
      expect(starts()).toEqual(['a']);
      h.bytes.set('a', 200);
      vi.setSystemTime(Date.now() + 121_000);
      h.summarizeTab.mockImplementation(async () => null);
      await tick(TREE_A);
      expect(starts()).toEqual(['a', 'a']);
    },
  );

  it.each([6, 12])('bounds a %i-tab cohort at three full jobs and drains FIFO', async (count) => {
    await armEmpty();
    const gates = Array.from({ length: count }, () => held<TabSummaryResult | null>(null));
    h.summarizeTab.mockImplementation(
      (_config, input: TabInput) => gates[Number(input.sid.slice(1))].promise,
    );
    roster(Array.from({ length: count }, (_, i) => `s${i}`));
    const batch = tick(TREE_A);
    await drain();
    expect(starts()).toEqual(['s0', 's1', 's2']);
    for (let i = 0; i < count; i++) {
      gates[i].resolve(summary);
      await drain();
      expect(getDashboardState()?.summarizingSids?.length).toBeLessThanOrEqual(3);
    }
    await batch;
    expect(starts()).toEqual(h.tabs.map((tab) => tab.sid));
    expect(h.writeCard).toHaveBeenCalledTimes(count);
    expect(getDashboardState()?.tabs).toHaveLength(count);
    expect(getDashboardState()?.summarizingSids).toEqual([]);
  });

  it('shares manual/scheduled slots, FIFO promotion and repeated-click settlement without follow-up', async () => {
    await armEmpty();
    const gates = new Map<string, ReturnType<typeof held<TabSummaryResult | null>>>();
    h.summarizeTab.mockImplementation((_config, input: TabInput) => {
      const gate = held<TabSummaryResult | null>(null);
      gates.set(input.sid, gate);
      return gate.promise;
    });
    roster(['s0', 's1', 's2', 's3', 's4', 's5', 's6', 'm0', 'm1', 'm2', 'm3']);
    // Only scheduled sids pass the activity gate in the captured batch.
    h.config!.gateOnActivity = true;
    for (const sid of ['m0', 'm1', 'm2', 'm3']) h.bytes.delete(sid);
    const batch = tick(TREE_A);
    await drain();
    let activeClickDone = false;
    const activeClick = refreshTab('s0').then(() => {
      activeClickDone = true;
    });
    const clicks = [
      refreshTab('s5'),
      refreshTab('s5'),
      refreshTab('m0'),
      refreshTab('m1'),
      refreshTab('m2'),
      refreshTab('m3'),
    ];
    await drain();
    expect(starts()).toEqual(['s0', 's1', 's2']);
    expect(activeClickDone).toBe(false);
    gates.get('s0')!.resolve(null);
    await drain();
    expect(starts().at(-1)).toBe('s5');
    expect(activeClickDone).toBe(true);
    gates.get('s1')!.resolve(null);
    await drain();
    expect(starts().at(-1)).toBe('m0');
    gates.get('s2')!.resolve(null);
    await drain();
    expect(starts().at(-1)).toBe('s3');
    gates.get('s5')!.resolve(null);
    await drain();
    expect(starts().at(-1)).toBe('m1');
    gates.get('m0')!.resolve(null);
    await drain();
    expect(starts().at(-1)).toBe('m2');
    gates.get('s3')!.resolve(null);
    await drain();
    expect(starts().at(-1)).toBe('s4');
    gates.get('m1')!.resolve(null);
    await drain();
    expect(starts().at(-1)).toBe('m3');
    // Replenishment cannot jump the older scheduled s6.
    roster([...h.tabs.map((tab) => tab.sid), 'm4']);
    const later = refreshTab('m4');
    await drain();
    gates.get('m2')!.resolve(null);
    await drain();
    expect(starts().at(-1)).toBe('m4');
    gates.get('s4')!.resolve(null);
    await drain();
    expect(starts().at(-1)).toBe('s6');
    for (const gate of gates.values()) gate.resolve(null);
    await drain();
    await Promise.all([batch, activeClick, later, ...clicks]);
    expect(starts().filter((sid) => sid === 's5')).toHaveLength(1);
    expect(starts().filter((sid) => sid === 's0')).toHaveLength(1);
    expect(getDashboardState()?.summarizingSids).toEqual([]);
  });

  it('captures queued config/text/bytes at admission and never banks output received during a manual job', async () => {
    await armEmpty();
    const gates = new Map<string, ReturnType<typeof held<TabSummaryResult | null>>>();
    h.summarizeTab.mockImplementation((_config, input: TabInput) => {
      const gate = held<TabSummaryResult | null>(null);
      gates.set(input.sid, gate);
      return gate.promise;
    });
    roster(['a', 'b', 'c', 'queued']);
    const batch = tick(TREE_A);
    await drain();
    const click = refreshTab('queued');
    await drain();
    h.recent.set('queued', 'latest at admission');
    h.bytes.set('queued', 200);
    h.config = { ...h.config!, model: 'changed-at-admission' };
    gates.get('a')!.resolve(null);
    await drain();
    const call = h.summarizeTab.mock.calls.find((call) => (call[1] as TabInput).sid === 'queued')!;
    expect(call[0].model).toBe('changed-at-admission');
    expect(call[1].recentText).toBe('latest at admission');
    h.bytes.set('queued', 300);
    for (const gate of gates.values()) gate.resolve(null);
    await drain();
    await Promise.all([batch, click]);
    h.config!.gateOnActivity = true;
    h.summarizeTab.mockImplementation(async () => null);
    vi.setSystemTime(Date.now() + 121_000);
    await tick(TREE_A);
    expect(starts().filter((sid) => sid === 'queued')).toHaveLength(2);
  });

  it.each(['disabled', 'keyless', 'closed', 'empty'])(
    'skips a queued %s owner without consuming its attempt',
    async (gate) => {
      await armEmpty();
      const first = held<TabSummaryResult | null>(null);
      h.summarizeTab.mockImplementation(() => first.promise);
      roster(['a', 'b', 'c', 'queued']);
      const batch = tick(TREE_A);
      await drain();
      if (gate === 'disabled') h.config!.enabled = false;
      if (gate === 'keyless') h.config!.apiKey = undefined;
      if (gate === 'closed') roster(['a', 'b', 'c']);
      if (gate === 'empty') h.recent.set('queued', '');
      first.resolve(null);
      await drain();
      await batch;
      expect(starts()).toEqual(['a', 'b', 'c']);
      h.config!.enabled = true;
      h.config!.apiKey = 'fixture';
      roster(['a', 'b', 'c', 'queued']);
      h.recent.set('queued', 'now readable');
      h.summarizeTab.mockImplementation(async () => null);
      await tick(TREE_A);
      expect(starts().at(-1)).toBe('queued');
    },
  );

  it.each(['card', 'provenance', 'writer'])(
    'holds the %s phase across close/root changes without unsent work or stale errors/state',
    async (phase) => {
      await armEmpty();
      const gate = held<any>(null);
      h.summarizeTab.mockImplementation(async () => summary);
      if (phase === 'card') h.summarizeTab.mockImplementation(() => gate.promise);
      if (phase === 'provenance') h.deriveProvenance.mockImplementation(() => gate.promise);
      if (phase === 'writer') h.writeCard.mockImplementation(() => gate.promise);
      roster(['old0', 'old1', 'old2', 'oldQueued']);
      const oldBatch = tick(TREE_A);
      await drain();
      const beforeWriter = h.writeCard.mock.calls.length;
      roster(['old1', 'old2', 'arrival']);
      await tick(TREE_A);
      const arrival = refreshTab('arrival');
      await drain();
      expect(starts()).not.toContain('arrival');
      // Reset repeatedly while the same three old logical slots are still occupied.
      roster(['new0', 'new1', 'new2', 'new3']);
      await setDashboardConception('/tmp/condash-engine-tree-b');
      await drain();
      await setDashboardConception(TREE_A);
      await drain();
      expect(starts()).toHaveLength(3);
      const oldOwners = h.summarizeTab.mock.calls
        .slice(0, 3)
        .map((call) => call[2] as SummaryOwner);
      for (const owner of oldOwners) owner.reportError('invalid old error');
      h.summarizeTab.mockImplementation(async () => null);
      h.deriveProvenance.mockImplementation(async () => ({}));
      h.writeCard.mockImplementation(async () => ({ title: 'new', subtitle: 'new' }));
      gate.reject(new Error('late old rejection'));
      await drain();
      await oldBatch;
      await arrival;
      expect(starts().slice(3)).toEqual(['new0', 'new1', 'new2', 'new3']);
      expect(h.writeCard.mock.calls.length).toBe(beforeWriter);
      expect(getDashboardState()?.tabs).toEqual([]);
      expect(getDashboardState()?.lastError).toBeUndefined();
      expect(getBackoffDelayMs()).toBe(0);
      expect(getDashboardState()?.summarizingSids).toEqual([]);
    },
  );

  it('continues observation/decay and unrelated arrivals after a single-tab close; no stale finalizer clears siblings', async () => {
    await armEmpty();
    h.summarizeTab.mockImplementation(async () => summary);
    roster(['quiet']);
    await tick(TREE_A);
    const gates = new Map<string, ReturnType<typeof held<TabSummaryResult | null>>>();
    h.summarizeTab.mockImplementation((_config, input: TabInput) => {
      const gate = held<TabSummaryResult | null>(null);
      gates.set(input.sid, gate);
      return gate.promise;
    });
    roster(['quiet', 'close', 'sibling']);
    const close = refreshTab('close');
    const sibling = refreshTab('sibling');
    await drain();
    roster(['quiet', 'sibling', 'arrival']);
    h.config!.gateOnActivity = true;
    vi.setSystemTime(Date.now() + 241_000);
    const observation = tick(TREE_A);
    await drain();
    expect(getDashboardState()?.tabs.find((tab) => tab.sid === 'quiet')?.state).toBe('idle');
    expect(getDashboardState()?.roster.map((tab) => tab.sid)).toEqual([
      'quiet',
      'sibling',
      'arrival',
    ]);
    expect(starts().at(-1)).toBe('arrival');
    gates.get('close')!.resolve(summary);
    await drain();
    expect(getDashboardState()?.summarizingSids).toEqual(['sibling', 'arrival']);
    expect(getDashboardState()?.tabs.some((tab) => tab.sid === 'close')).toBe(false);
    gates.get('arrival')!.resolve(summary);
    gates.get('sibling')!.resolve(summary);
    await drain();
    await Promise.all([close, sibling, observation]);
    expect(
      getDashboardState()
        ?.tabs.map((tab) => tab.sid)
        .sort(),
    ).toEqual(['arrival', 'quiet', 'sibling']);
  });

  it('aggregates one scheduled batch failure despite sibling success and promotion; manual bypass does not reset backoff/errors', async () => {
    await armEmpty();
    const gates = new Map<string, ReturnType<typeof held<TabSummaryResult | null>>>();
    h.summarizeTab.mockImplementation((_config, input: TabInput) => {
      const gate = held<TabSummaryResult | null>(null);
      gates.set(input.sid, gate);
      return gate.promise;
    });
    roster(['a', 'b', 'c', 'promoted']);
    const batch = tick(TREE_A);
    await drain();
    const promoted = refreshTab('promoted');
    await drain();
    const ownerA = h.summarizeTab.mock.calls[0][2] as SummaryOwner;
    ownerA.reportError('scheduled failure');
    gates.get('a')!.resolve(null);
    await drain();
    gates.get('b')!.resolve(summary);
    await drain();
    expect(getDashboardState()?.lastError).toBe('scheduled failure');
    gates.get('c')!.resolve(null);
    gates.get('promoted')!.resolve(summary);
    await drain();
    await Promise.all([batch, promoted]);
    expect(getBackoffDelayMs()).toBe(30_000);
    h.summarizeTab.mockImplementation(async () => summary);
    await refreshTab('b');
    expect(getBackoffDelayMs()).toBe(30_000);
    expect(getDashboardState()?.lastError).toBe('scheduled failure');
    roster([...h.tabs.map((tab) => tab.sid), 'later']);
    await tick(TREE_A);
    expect(starts()).not.toContain('later');
    vi.setSystemTime(Date.now() + 31_000);
    await tick(TREE_A);
    expect(starts().at(-1)).toBe('later');
    expect(getBackoffDelayMs()).toBe(0);
    expect(getDashboardState()?.lastError).toBeUndefined();
  });

  it('keeps latest admission-sequence errors; manual success only clears its own older manual failure', async () => {
    await armEmpty();
    roster(['a', 'b']);
    h.summarizeTab.mockImplementation(async (_config, input: TabInput, owner?: SummaryOwner) => {
      owner!.reportError(`failure ${input.sid}`);
      return null;
    });
    await refreshTab('a');
    await refreshTab('b');
    expect(getDashboardState()?.lastError).toBe('failure b');
    h.summarizeTab.mockImplementation(async () => null);
    await refreshTab('a');
    expect(getDashboardState()?.lastError).toBe('failure b');
    await refreshTab('b');
    expect(getDashboardState()?.lastError).toBeUndefined();
    expect(getBackoffDelayMs()).toBe(0);
  });

  it('serializes reverse-completed saves, snapshots execution-time state and holds manual settlement through persistence', async () => {
    await armEmpty();
    roster(['a', 'b', 'c', 'queued']);
    const cardGates = new Map(
      ['a', 'b', 'c', 'queued'].map((sid) => [sid, held<TabSummaryResult | null>(null)]),
    );
    h.summarizeTab.mockImplementation(
      (_config, input: TabInput) => cardGates.get(input.sid)!.promise,
    );
    const firstSave = held<void>(undefined);
    const saved: DashboardState[] = [];
    h.saveDashboardState.mockImplementation(async (_path: string, snapshot: DashboardState) => {
      saved.push(snapshot);
      if (saved.length === 1) await firstSave.promise;
    });
    let finished = 0;
    const clicks = ['a', 'b', 'c', 'queued'].map((sid) =>
      refreshTab(sid).then(() => {
        finished++;
      }),
    );
    await drain();
    cardGates.get('c')!.resolve(summary);
    await drain();
    cardGates.get('b')!.resolve(summary);
    await drain();
    cardGates.get('a')!.resolve(summary);
    await drain();
    expect(starts()).toEqual(['a', 'b', 'c']);
    expect(saved).toHaveLength(1);
    expect(finished).toBe(0);
    expect(getDashboardState()?.tabs).toHaveLength(3);
    expect(saved[0].tabs).toHaveLength(1);
    firstSave.resolve();
    cardGates.get('queued')!.resolve(summary);
    await drain();
    await Promise.all(clicks);
    expect(
      saved
        .at(-1)
        ?.tabs.map((tab) => tab.sid)
        .sort(),
    ).toEqual(['a', 'b', 'c', 'queued']);
    expect(starts()).toHaveLength(4);
    expect(getDashboardState()?.summarizingSids).toEqual([]);
  });

  it('an old started save finishes before new same-path writes; stale queued saves skip and rejection does not wedge', async () => {
    await armEmpty();
    roster(['oldA', 'oldB']);
    h.summarizeTab.mockImplementation(async () => summary);
    const saveGate = held<void>(undefined);
    const saved: { path: string; sids: string[] }[] = [];
    h.saveDashboardState.mockImplementation(async (path: string, snapshot: DashboardState) => {
      saved.push({ path, sids: snapshot.tabs.map((tab) => tab.sid) });
      if (saved.length === 1) await saveGate.promise;
      if (saved.length === 2) throw new Error('fixture persist failure');
    });
    const old = [refreshTab('oldA'), refreshTab('oldB')];
    await drain();
    roster([]);
    await setDashboardConception('/tmp/condash-engine-tree-b');
    await drain();
    await setDashboardConception(TREE_A);
    await drain();
    roster(['newA', 'newB']);
    const fresh = refreshTab('newA');
    await drain();
    expect(saved).toHaveLength(1);
    saveGate.resolve();
    await drain();
    await Promise.all([...old, fresh]);
    await refreshTab('newB');
    expect(saved).toHaveLength(3);
    expect(saved[0]).toEqual({ path: TREE_A, sids: ['oldA'] });
    expect(saved[1]).toEqual({ path: TREE_A, sids: ['newA'] });
    expect(saved[2]).toEqual({ path: TREE_A, sids: ['newA', 'newB'] });
    expect(getDashboardState()?.lastError).toBeUndefined();
  });

  it('rechecks identities after config awaits and overlapping root-load completions', async () => {
    await armEmpty();
    roster(['a']);
    const configGate = held<DashboardConfig>(h.config!);
    vi.mocked(readDashboardConfig).mockImplementationOnce(() => configGate.promise);
    const click = refreshTab('a');
    await drain();
    roster([]);
    await setDashboardConception('/tmp/condash-engine-tree-b');
    await drain();
    configGate.resolve(h.config!);
    await click;
    expect(starts()).not.toContain('a');
    // A stale root load must not re-arm its immediate tick after a later teardown.
    const loadGate = held<null>(null);
    h.loadDashboardState.mockImplementationOnce(() => loadGate.promise);
    const root = setDashboardConception(TREE_A);
    await drain();
    await setDashboardConception(null);
    loadGate.resolve(null);
    await root;
    expect(getDashboardState()).toBeNull();
  });

  it.each([6, 12])(
    'actual two-phase source drains %i tabs with exact requests and virtual-time waves',
    async (count) => {
      await armEmpty();
      const actual = await vi.importActual<typeof import('./summarizer')>('./summarizer');
      h.summarizeTab.mockImplementation(actual.summarizeTab);
      h.writeCard.mockImplementation(actual.writeCard);
      h.config!.model = 'fixture-card';
      h.config!.writerModel = 'fixture-writer';
      let cards = 0;
      let writers = 0;
      let pending = 0;
      let peak = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url, options) => {
          const body = JSON.parse(options.body);
          const card = body.model === 'fixture-card';
          if (card) cards++;
          else writers++;
          peak = Math.max(peak, ++pending);
          await new Promise((resolve) => setTimeout(resolve, 100));
          pending--;
          const title = card ? `draft ${cards}` : `written ${writers}`;
          return {
            ok: true,
            json: async () => ({
              choices: [
                {
                  message: {
                    content: JSON.stringify(
                      card ? { ...summary, title } : { title, subtitle: 'fixture' },
                    ),
                  },
                },
              ],
            }),
          };
        }),
      );
      roster(Array.from({ length: count }, (_, i) => `s${i}`));
      const startedAt = Date.now();
      const batch = tick(TREE_A);
      await drain();
      expect(cards).toBe(3);
      await vi.advanceTimersByTimeAsync((count / 3) * 200);
      await batch;
      expect(Date.now() - startedAt).toBe(count === 6 ? 400 : 800);
      expect({ cards, writers, pending, peak }).toEqual({
        cards: count,
        writers: count,
        pending: 0,
        peak: 3,
      });
      expect(getDashboardState()?.summarizingSids).toEqual([]);
    },
  );

  it('actual slow/rejected card fixture sends twelve cards/eleven writers, retains slots through both phases and backs off once', async () => {
    await armEmpty();
    const actual = await vi.importActual<typeof import('./summarizer')>('./summarizer');
    h.summarizeTab.mockImplementation(actual.summarizeTab);
    h.writeCard.mockImplementation(actual.writeCard);
    h.config!.model = 'card';
    h.config!.writerModel = 'writer';
    let cards = 0;
    let writers = 0;
    let pending = 0;
    let peak = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, options) => {
        const body = JSON.parse(options.body);
        const card = body.model === 'card';
        const user = body.messages[1].content;
        const sid = card ? user.match(/output (s\d+)/)[1] : user.match(/Draft title.*: (s\d+)/)[1];
        if (card) cards++;
        else writers++;
        peak = Math.max(peak, ++pending);
        await new Promise((resolve) => setTimeout(resolve, sid === 's0' ? 1000 : 100));
        pending--;
        if (card && sid === 's1') throw new Error('fixture card rejection');
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify(
                    card ? { ...summary, title: sid } : { title: sid, subtitle: 'fixture' },
                  ),
                },
              },
            ],
          }),
        };
      }),
    );
    roster(Array.from({ length: 12 }, (_, i) => `s${i}`));
    const batch = tick(TREE_A);
    await drain();
    await vi.advanceTimersByTimeAsync(2000);
    await batch;
    expect({ cards, writers, pending, peak }).toEqual({
      cards: 12,
      writers: 11,
      pending: 0,
      peak: 3,
    });
    expect(getBackoffDelayMs()).toBe(30_000);
    expect(getDashboardState()?.lastError).toBe('fixture card rejection');
  });

  it.each(['cooperative', 'noncooperative', 'late-body'])(
    'actual %s timeout bounds logical jobs, not underlying operations, across roots',
    async (mode) => {
      await armEmpty();
      const actual = await vi.importActual<typeof import('./summarizer')>('./summarizer');
      h.summarizeTab.mockImplementation(actual.summarizeTab);
      h.writeCard.mockImplementation(actual.writeCard);
      let underlying = 0;
      let peakUnderlying = 0;
      let aborted = 0;
      const fetchMock = vi.fn((_url, options) => {
        peakUnderlying = Math.max(peakUnderlying, ++underlying);
        const operation = held<unknown>({ choices: [{ message: { content: '{}' } }] });
        options.signal.addEventListener('abort', () => {
          aborted++;
          if (mode === 'cooperative') operation.reject(new Error('cooperative abort'));
        });
        const tracked = operation.promise.finally(() => {
          underlying--;
        });
        if (mode === 'late-body') return Promise.resolve({ ok: true, json: () => tracked });
        return tracked.then(() => ({ ok: true, json: async () => ({ choices: [] }) }));
      });
      vi.stubGlobal('fetch', fetchMock);
      roster(['old0', 'old1', 'old2']);
      const old = tick(TREE_A);
      await drain();
      expect(fetchMock).toHaveBeenCalledTimes(3);
      roster(['new0', 'new1', 'new2']);
      await setDashboardConception('/tmp/condash-engine-tree-b');
      await drain();
      expect(fetchMock).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(60_000);
      await old;
      await drain();
      expect(fetchMock).toHaveBeenCalledTimes(6);
      expect(aborted).toBe(3);
      expect(peakUnderlying).toBe(mode === 'cooperative' ? 3 : 6);
      expect(getDashboardState()?.summarizingSids).toEqual(['new0', 'new1', 'new2']);
      expect(getDashboardState()?.lastError).toBeUndefined();
      expect(getBackoffDelayMs()).toBe(0);
      // Dispose and explicitly settle every underlying loser; none is left hanging.
      await setDashboardConception(null);
      for (const release of releases.splice(0)) release();
      await drain();
      expect(underlying).toBe(0);
      expect(actual.getSummarizerError()).toBeNull();
    },
  );
});
