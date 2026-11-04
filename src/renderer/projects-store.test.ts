/**
 * Store-side tests for the projects batch-arrival ownership: batch
 * registration gates both held list reads and held per-path patch replies.
 * The dispatcher-side behaviour (which lookups are issued per batch) lives
 * in `tree-events.test.ts`.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { createRoot, createSignal } from 'solid-js';
import type { Project, StepMarker, TreeEvent } from '@shared/types';
import { createProjectsStore } from './projects-store';
import { applyStepMarker } from './panes/projects-parts/data';
import { countSteps } from '@shared/projects';

function projectRow(path: string, title: string): Project {
  return {
    path,
    slug: path.split('/').pop() ?? path,
    title,
    timeline: [],
  } as unknown as Project;
}

const A = '/c/projects/2026-07/a/README.md';
const B = '/c/projects/2026-07/b/README.md';

/** Solid effects are scheduled, not synchronous — let them run. */
const flushEffects = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function makeStore() {
  const [conceptionPath, setConceptionPath] = createSignal<string | null>('/c');
  const listProjects = vi.fn(async (): Promise<Project[]> => [projectRow(A, 'list')]);
  const getProject = vi.fn(async (): Promise<Project | null> => stepRow(' '));
  (globalThis as unknown as { window: unknown }).window = {
    condash: { listProjects, getProject },
  };
  let store!: ReturnType<typeof createProjectsStore>;
  const dispose = createRoot((disposeRoot) => {
    store = createProjectsStore({ conceptionPath });
    return disposeRoot;
  });
  return {
    store,
    ownership: store.ownership,
    listProjects,
    getProject,
    setConceptionPath,
    dispose,
  };
}

function stepRow(marker: StepMarker, lineIndex = 11): Project {
  const steps = [{ marker, lineIndex, text: 'First step', section: 'Steps' }];
  return { ...projectRow(A, 'list-owned'), steps, stepCounts: countSteps(steps) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('createProjectsStore — list reads gate on batch registration', () => {
  it('a held list read across a patch batch is discarded; exactly one trailing read starts after the lookups settle', async () => {
    const { store, ownership, listProjects, dispose } = makeStore();
    await flushEffects(); // boot read resolves with the default list

    let resolveHeldList!: (value: Project[]) => void;
    listProjects.mockImplementation(
      () =>
        new Promise<Project[]>((resolve) => {
          resolveHeldList = resolve;
        }),
    );
    const held = store.reload();

    // Batch: change for A (its lookup is still pending) while the list read
    // is in flight.
    const events: TreeEvent[] = [{ kind: 'project', op: 'change', path: A }];
    const tickets = ownership.registerBatch(events);
    const ticket = tickets.get(events[0])!;
    expect(tickets.size).toBe(1);
    expect(listProjects).toHaveBeenCalledTimes(2); // no trailing read yet

    // Release the held list reply — it predates the batch registration.
    resolveHeldList([projectRow(A, 'held-list')]);
    await held;
    // Discarded; the trailing read waits for the registered patch lookup.
    expect(listProjects).toHaveBeenCalledTimes(2);

    // Settle the patch lookup: its patch applies, then the one trailing
    // list read starts and observes after the patch.
    ownership.settle(ticket, (items) =>
      items.map((p) => (p.path === A ? { ...p, title: 'patched' } : p)),
    );
    await flushEffects();

    expect(store.projects().map((p) => p.title)).toEqual(['patched']);
    expect(listProjects).toHaveBeenCalledTimes(3); // exactly one trailing list read

    // Quiet interval: nothing else reads.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listProjects).toHaveBeenCalledTimes(3);
    dispose();
  });

  it('a membership-only batch (projects-reload) discards a held list read and trails immediately', async () => {
    const { store, ownership, listProjects, dispose } = makeStore();
    await flushEffects(); // boot read resolved

    let resolveList!: (value: Project[]) => void;
    listProjects.mockImplementation(
      () =>
        new Promise<Project[]>((resolve) => {
          resolveList = resolve;
        }),
    );
    const held = store.reload();
    ownership.registerBatch([{ kind: 'projects-reload' }]);
    resolveList([projectRow(A, 'held')]);
    await held;

    // Held reply discarded; the one trailing read started right away
    // (no registered lookups to wait for) and its data applies.
    expect(listProjects).toHaveBeenCalledTimes(3);
    const trailing = Promise.resolve();
    void trailing;
    await flushEffects();
    expect(store.projects().map((p) => p.title)).toEqual(['list']); // trailing applied the default data
    dispose();
  });

  it('an unknown batch invalidates list ownership the same way', async () => {
    const { store, ownership, listProjects, dispose } = makeStore();
    await flushEffects();

    let resolveList!: (value: Project[]) => void;
    listProjects.mockImplementation(
      () =>
        new Promise<Project[]>((resolve) => {
          resolveList = resolve;
        }),
    );
    const held = store.reload();
    ownership.registerBatch([{ kind: 'unknown' } as TreeEvent]);
    resolveList([projectRow(A, 'held')]);
    await held;
    expect(listProjects).toHaveBeenCalledTimes(3);
    await flushEffects();
    expect(store.projects().map((p) => p.title)).toEqual(['list']);
    dispose();
  });

  it('several batches during one list flight coalesce into a single trailing read', async () => {
    const { store, ownership, listProjects, dispose } = makeStore();
    await flushEffects();

    let resolveList!: (value: Project[]) => void;
    listProjects.mockImplementation(
      () =>
        new Promise<Project[]>((resolve) => {
          resolveList = resolve;
        }),
    );
    const held = store.reload();

    // Three successive batches while the read is in flight.
    ownership.registerBatch([{ kind: 'projects-reload' }]);
    ownership.registerBatch([{ kind: 'unknown' } as TreeEvent]);
    ownership.registerBatch([{ kind: 'projects-reload' }]);

    resolveList([projectRow(A, 'held')]);
    await held;
    // One trailing read for the whole dirty period.
    expect(listProjects).toHaveBeenCalledTimes(3);
    await flushEffects();
    expect(store.projects().map((p) => p.title)).toEqual(['list']);

    // Quiet interval: the trailing read settled, nothing further fires.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listProjects).toHaveBeenCalledTimes(3);
    dispose();
  });

  it('a failed list read retains the last-good list and the next valid read recovers', async () => {
    const { store, listProjects, dispose } = makeStore();
    await flushEffects();
    expect(store.projects().map((p) => p.title)).toEqual(['list']);

    listProjects.mockRejectedValueOnce(new Error('boom'));
    await store.reload().catch(() => undefined); // the read failed; last-good retained
    expect(store.projects().map((p) => p.title)).toEqual(['list']);
    expect(store.loaded()).toBe(true);

    await store.reload();
    expect(store.projects().map((p) => p.title)).toEqual(['list']);
    dispose();
  });
});

describe('createProjectsStore — patch tickets', () => {
  it('a settled ticket applies while it owns the path and never after supersession', async () => {
    const { store, ownership, dispose } = makeStore();
    await flushEffects(); // boot read settles before the scenario starts
    store.mutate(() => [projectRow(A, 'seed')]);

    const firstEvent: TreeEvent = { kind: 'project', op: 'change', path: A };
    const firstTicket = ownership.registerBatch([firstEvent]).get(firstEvent)!;
    ownership.settle(firstTicket, (items) =>
      items.map((p) => (p.path === A ? { ...p, title: 'first' } : p)),
    );
    expect(store.projects().map((p) => p.title)).toEqual(['first']);

    // A later batch re-registers the path; the first batch's ticket is dead
    // even if its reply resolves afterwards.
    const secondEvent: TreeEvent = { kind: 'project', op: 'change', path: A };
    const secondTicket = ownership.registerBatch([secondEvent]).get(secondEvent)!;
    ownership.settle(firstTicket, (items) =>
      items.map((p) => (p.path === A ? { ...p, title: 'stale' } : p)),
    );
    expect(store.projects().map((p) => p.title)).toEqual(['first']);

    ownership.settle(secondTicket, (items) =>
      items.map((p) => (p.path === A ? { ...p, title: 'second' } : p)),
    );
    expect(store.projects().map((p) => p.title)).toEqual(['second']);
    dispose();
  });

  it('an unlink registration defeats a held change ticket', async () => {
    const { store, ownership, dispose } = makeStore();
    await flushEffects();
    store.mutate(() => [projectRow(A, 'seed')]);

    const changeEvent: TreeEvent = { kind: 'project', op: 'change', path: A };
    const ticket = ownership.registerBatch([changeEvent]).get(changeEvent)!;

    // A later operation re-registers the path as an unlink (same or later batch).
    ownership.registerBatch([{ kind: 'project', op: 'unlink', path: A }]);

    ownership.settle(ticket, (items) =>
      items.map((p) => (p.path === A ? { ...p, title: 'stale-patch' } : p)),
    );
    expect(store.projects().map((p) => p.title)).toEqual(['seed']);
    dispose();
  });

  it('a settled ticket from a switched conception never applies', async () => {
    const { store, ownership, setConceptionPath, dispose } = makeStore();
    await flushEffects();
    store.mutate(() => [projectRow(A, 'seed')]);

    const changeEvent: TreeEvent = { kind: 'project', op: 'change', path: A };
    const ticket = ownership.registerBatch([changeEvent]).get(changeEvent)!;

    setConceptionPath('/next');
    ownership.settle(ticket, (items) =>
      items.map((p) => (p.path === A ? { ...p, title: 'stale-patch' } : p)),
    );
    expect(store.projects().map((p) => p.title)).toEqual(['seed']);
    dispose();
  });

  it('a patch preserves unrelated card identity (reconcile keyed by path)', async () => {
    const { store, ownership, dispose } = makeStore();
    const rowA = projectRow(A, 'A');
    const rowB = projectRow(B, 'B');
    await flushEffects();
    store.mutate(() => [rowA, rowB]);
    const before = store.projects()[1]; // rowB

    const changeEvent: TreeEvent = { kind: 'project', op: 'change', path: A };
    const ticket = ownership.registerBatch([changeEvent]).get(changeEvent)!;
    ownership.settle(ticket, (items) =>
      items.map((p) => (p.path === A ? { ...p, title: 'A2' } : p)),
    );

    expect(store.projects().map((p) => p.title)).toEqual(['A2', 'B']);
    // Unrelated row keeps its reference across the patch.
    expect(store.projects()[1]).toBe(before);
    dispose();
  });

  it('a failed patch lookup releases the pending gate so a discarded list read can trail', async () => {
    const { store, ownership, listProjects, dispose } = makeStore();
    await flushEffects(); // boot read resolved

    let resolveList!: (value: Project[]) => void;
    listProjects.mockImplementation(
      () =>
        new Promise<Project[]>((resolve) => {
          resolveList = resolve;
        }),
    );
    const held = store.reload();

    const changeEvent: TreeEvent = { kind: 'project', op: 'change', path: A };
    const ticket = ownership.registerBatch([changeEvent]).get(changeEvent)!;

    resolveList([projectRow(A, 'held')]);
    await held;
    expect(listProjects).toHaveBeenCalledTimes(2); // discarded, waiting on the lookup

    ownership.fail(ticket);
    await flushEffects();
    // Pending gate released: exactly one trailing read started.
    expect(listProjects).toHaveBeenCalledTimes(3);
    expect(store.projects().map((p) => p.title)).toEqual(['list']);
    dispose();
  });

  it('dispose suppresses patch application and trailing-read scheduling; repeated dispose is tolerated', async () => {
    const { store, ownership, listProjects, dispose } = makeStore();
    await flushEffects(); // boot read resolved

    let resolveList!: (value: Project[]) => void;
    listProjects.mockImplementation(
      () =>
        new Promise<Project[]>((resolve) => {
          resolveList = resolve;
        }),
    );
    const held = store.reload();

    const changeEvent: TreeEvent = { kind: 'project', op: 'change', path: A };
    const ticket = ownership.registerBatch([changeEvent]).get(changeEvent)!;

    dispose();
    dispose(); // repeated cleanup tolerated

    resolveList([projectRow(A, 'held')]);
    await held;
    ownership.settle(ticket, (items) => items.map((p) => ({ ...p, title: 'post-dispose' })));
    await flushEffects();

    // No stale apply (the post-dispose patch is absent), no trailing read
    // scheduled after disposal; the list keeps the boot content.
    expect(store.projects().map((p) => p.title)).toEqual(['list']);
    expect(listProjects).toHaveBeenCalledTimes(2);
  });
});

describe('failed step intent settlement', () => {
  async function setup() {
    const fixture = makeStore();
    await flushEffects();
    fixture.listProjects.mockResolvedValue([stepRow(' ')]);
    fixture.store.mutate(() => [stepRow(' ')]);
    const toggle = () => {
      const intent = fixture.store.beginStepIntent(A);
      fixture.store.mutate((items) => applyStepMarker(items, A, 11, '~'));
      return intent;
    };
    const marker = () => fixture.store.projects()[0]?.steps?.[0]?.marker;
    return { ...fixture, toggle, marker };
  }

  it('snapshots before reconcile aliasing and patches shifted steps/counts without list-owned fields', async () => {
    const { store, toggle, marker, getProject, dispose } = await setup();
    const liveStep = store.projects()[0].steps[0];
    const intent = toggle();
    expect(liveStep.marker).toBe('~');
    expect(intent.previousSteps[0].marker).toBe(' ');
    getProject.mockResolvedValue({
      ...stepRow('!', 15),
      title: 'detail-only',
      timeline: [{ date: '2026-11-04', text: 'detail' }],
    });
    await store.settleFailedStep(intent);
    expect(marker()).toBe('!');
    expect(store.projects()[0].steps[0].lineIndex).toBe(15);
    expect(store.projects()[0].stepCounts.blocked).toBe(1);
    expect(store.projects()[0].title).toBe('list-owned');
    expect(store.projects()[0].timeline).toEqual([]);
    dispose();
  });

  for (const authoritativeMarker of ['!', '~'] as const) {
    it(`a watcher snapshot (${authoritativeMarker}) before rejection prevents even starting an obsolete repair`, async () => {
      const { store, ownership, toggle, marker, getProject, dispose } = await setup();
      const intent = toggle();
      const event: TreeEvent = { kind: 'project', op: 'change', path: A };
      const ticket = ownership.registerBatch([event]).get(event)!;
      ownership.settle(ticket, () => [stepRow(authoritativeMarker)]);
      await store.settleFailedStep(intent);
      expect(getProject).not.toHaveBeenCalled();
      expect(marker()).toBe(authoritativeMarker);
      dispose();
    });

    it(`a watcher snapshot (${authoritativeMarker}) after repair starts defeats the held read`, async () => {
      const { store, ownership, toggle, marker, getProject, dispose } = await setup();
      const read = deferred<Project | null>();
      getProject.mockReturnValue(read.promise);
      const repairing = store.settleFailedStep(toggle());
      const event: TreeEvent = { kind: 'project', op: 'change', path: A };
      const ticket = ownership.registerBatch([event]).get(event)!;
      ownership.settle(ticket, () => [stepRow(authoritativeMarker)]);
      read.resolve(stepRow(' '));
      await repairing;
      expect(marker()).toBe(authoritativeMarker);
      dispose();
    });
  }

  it('older failure cannot initiate a read over newer in-flight intent, even if its catch runs last', async () => {
    const { store, toggle, marker, getProject, dispose } = await setup();
    const older = toggle();
    const newer = store.beginStepIntent(A);
    store.mutate((items) => applyStepMarker(items, A, 11, 'x'));
    await store.settleFailedStep(older);
    expect(getProject).not.toHaveBeenCalled();
    expect(marker()).toBe('x');
    await store.settleFailedStep(newer);
    expect(marker()).toBe(' ');
    expect(getProject).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('overlapping failures settle by original intent order, not read completion order', async () => {
    const { store, toggle, marker, getProject, dispose } = await setup();
    const olderRead = deferred<Project | null>();
    const newerRead = deferred<Project | null>();
    getProject.mockReturnValueOnce(olderRead.promise).mockReturnValueOnce(newerRead.promise);
    const olderRepair = store.settleFailedStep(toggle());
    const newer = store.beginStepIntent(A);
    store.mutate((items) => applyStepMarker(items, A, 11, 'x'));
    const newerRepair = store.settleFailedStep(newer);
    newerRead.resolve(stepRow('!'));
    await newerRepair;
    olderRead.resolve(stepRow(' '));
    await olderRepair;
    expect(marker()).toBe('!');
    dispose();
  });

  it('a local intent invalidates an older watcher lookup and held list read', async () => {
    const { store, ownership, toggle, marker, listProjects, dispose } = await setup();
    const heldList = deferred<Project[]>();
    listProjects.mockReturnValueOnce(heldList.promise);
    const listRead = store.reload();
    const event: TreeEvent = { kind: 'project', op: 'change', path: A };
    const ticket = ownership.registerBatch([event]).get(event)!;
    toggle();
    ownership.settle(ticket, () => [stepRow('!')]);
    expect(marker()).toBe('~');
    heldList.resolve([stepRow('!')]);
    await listRead;
    // The coalesced trailing list is authoritative; the held one never paints.
    expect(marker()).not.toBe('!');
    dispose();
  });

  it('an accepted full list supersedes a repair and a pre-repair list cannot paint after settlement', async () => {
    const { store, toggle, marker, getProject, listProjects, dispose } = await setup();
    const read = deferred<Project | null>();
    getProject.mockReturnValueOnce(read.promise);
    const repair = store.settleFailedStep(toggle());
    listProjects.mockResolvedValueOnce([stepRow('!')]);
    await store.reload();
    read.resolve(stepRow(' '));
    await repair;
    expect(marker()).toBe('!');

    const oldList = deferred<Project[]>();
    listProjects.mockReturnValueOnce(oldList.promise).mockResolvedValue([stepRow('~')]);
    const listRead = store.reload();
    getProject.mockResolvedValueOnce(stepRow('~'));
    await store.settleFailedStep(toggle());
    oldList.resolve([stepRow(' ')]);
    await listRead;
    expect(marker()).toBe('~');
    dispose();
  });

  it('unlink during a repair removes the row without resurrection; null repair uses removal semantics', async () => {
    const { store, ownership, toggle, getProject, dispose } = await setup();
    const read = deferred<Project | null>();
    getProject.mockReturnValueOnce(read.promise);
    const repair = store.settleFailedStep(toggle());
    ownership.registerBatch([{ kind: 'project', op: 'unlink', path: A }]);
    store.mutate(() => []);
    read.resolve(stepRow(' '));
    await repair;
    expect(store.projects()).toEqual([]);
    store.mutate(() => [stepRow(' ')]);
    getProject.mockResolvedValueOnce(null);
    await store.settleFailedStep(toggle());
    expect(store.projects()).toEqual([]);
    dispose();
  });

  it('departure and return cancel held reads and prevent a late rejection initiating a new-context read', async () => {
    const { store, toggle, marker, getProject, setConceptionPath, dispose } = await setup();
    const read = deferred<Project | null>();
    getProject.mockReturnValueOnce(read.promise);
    const original = toggle();
    const repair = store.settleFailedStep(original);
    store.depart();
    setConceptionPath('/next');
    setConceptionPath('/c');
    await flushEffects();
    store.mutate(() => [stepRow('!')]);
    read.resolve(stepRow(' '));
    await repair;
    await store.settleFailedStep(original);
    expect(getProject).toHaveBeenCalledTimes(1);
    expect(marker()).toBe('!');
    dispose();
  });

  it('disposal cancels both a pending repair and a late failure before its read', async () => {
    const { store, toggle, marker, getProject, dispose } = await setup();
    const read = deferred<Project | null>();
    getProject.mockReturnValueOnce(read.promise);
    const original = toggle();
    const repair = store.settleFailedStep(original);
    dispose();
    read.resolve(stepRow(' '));
    await repair;
    await store.settleFailedStep(original);
    expect(getProject).toHaveBeenCalledTimes(1);
    expect(marker()).toBe('~');
  });

  it('departure/return also invalidates a watcher lookup captured before departure', async () => {
    const { store, ownership, marker, setConceptionPath, dispose } = await setup();
    const event: TreeEvent = { kind: 'project', op: 'change', path: A };
    const ticket = ownership.registerBatch([event]).get(event)!;
    store.depart();
    setConceptionPath('/next');
    setConceptionPath('/c');
    await flushEffects();
    store.mutate(() => [stepRow('!')]);
    ownership.settle(ticket, () => [stepRow(' ')]);
    expect(marker()).toBe('!');
    dispose();
  });

  it('repair read failure explicitly rejects and restores the pre-chain snapshot, never another failed optimism', async () => {
    const { store, toggle, marker, getProject, dispose } = await setup();
    const older = toggle();
    const newer = store.beginStepIntent(A);
    store.mutate((items) => applyStepMarker(items, A, 11, 'x'));
    getProject.mockRejectedValueOnce(new Error('read unavailable'));
    await expect(store.settleFailedStep(newer)).rejects.toThrow(
      'Showing previous snapshot; refresh to retry.',
    );
    await store.settleFailedStep(older);
    expect(marker()).toBe(' ');
    expect(store.projects()[0].stepCounts.todo).toBe(1);
    expect(getProject).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('a superseded repair rejection cannot roll back or report a new-context repair error', async () => {
    const { store, toggle, marker, getProject, dispose } = await setup();
    const read = deferred<Project | null>();
    getProject.mockReturnValueOnce(read.promise);
    const repair = store.settleFailedStep(toggle());
    store.beginStepIntent(A);
    store.mutate((items) => applyStepMarker(items, A, 11, 'x'));
    read.reject(new Error('obsolete read error'));
    await expect(repair).resolves.toBeUndefined();
    expect(marker()).toBe('x');
    dispose();
  });
});
