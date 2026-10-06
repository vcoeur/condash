import { describe, expect, it } from 'vitest';
import { createSnapshotOwner } from './status-bar-ownership';

/** Flush microtasks so a settled read's bookkeeping has run. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Owner + fetch queue: every fetch takes one deferred out of the queue. */
function makeOwner() {
  const applied: string[] = [];
  const queue: Deferred<string>[] = [];
  const owner = createSnapshotOwner<string>({
    fetch: () => {
      const d = deferred<string>();
      queue.push(d);
      return d.promise;
    },
    apply: (value) => applied.push(value),
  });
  return { owner, applied, queue };
}

describe('createSnapshotOwner — context generation', () => {
  it('an old-context reply resolving after a conception switch never applies', async () => {
    const { owner, applied, queue } = makeOwner();
    void owner.refresh(); // old-context read, held
    expect(queue).toHaveLength(1);

    void owner.recontext(); // switch: new read issued
    await flush();
    expect(queue).toHaveLength(2);

    queue[1]!.resolve('new-root');
    await flush();
    expect(applied).toEqual(['new-root']);

    // The old-root reply resolves last — it must not paint.
    queue[0]!.resolve('old-root');
    await flush();
    expect(applied).toEqual(['new-root']);
  });

  it('new-context replies resolving first leave nothing for the old replies to paint', async () => {
    const { owner, applied, queue } = makeOwner();
    void owner.refresh(); // read 1 (old context), held
    void owner.recontext(); // read 2 (new context)
    void owner.recontext(); // read 3 (another switch)
    await flush();
    expect(queue).toHaveLength(3);

    queue[2]!.resolve('third');
    queue[1]!.resolve('second');
    queue[0]!.resolve('first');
    await flush();
    expect(applied).toEqual(['third']);
  });
});

describe('createSnapshotOwner — single flight, one trailing read', () => {
  it('a trigger during a flight coalesces into exactly one trailing read', async () => {
    const { owner, applied, queue } = makeOwner();
    const first = owner.refresh(); // poll read, held
    void owner.refresh(); // push lands during the flight → trailing owed
    void owner.refresh(); // another trigger → still one trailing read
    expect(queue).toHaveLength(1);

    queue[0]!.resolve('stale');
    await first;
    // Held reply applied, then exactly one trailing read for the burst.
    expect(applied).toEqual(['stale']);
    expect(queue).toHaveLength(2);

    queue[1]!.resolve('fresh');
    await flush();
    expect(applied).toEqual(['stale', 'fresh']);

    // Quiet interval: nothing further reads.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(queue).toHaveLength(2);
  });

  it('a context switch during a flight does not owe the old context a trailing read', async () => {
    const { owner, queue } = makeOwner();
    void owner.refresh(); // old-context read held
    void owner.recontext(); // switch — old flight dead, new read issued
    await flush();
    expect(queue).toHaveLength(2);
    queue[1]!.resolve('new');
    await flush();
    expect(queue).toHaveLength(2); // no trailing read for the dead flight
  });
});

describe('createSnapshotOwner — failure retains last-good', () => {
  it('a failed read leaves the applied snapshot intact and does not retry on its own', async () => {
    const { owner, applied, queue } = makeOwner();
    const first = owner.refresh();
    queue[0]!.resolve('good');
    await first;
    expect(applied).toEqual(['good']);

    const second = owner.refresh();
    queue[1]!.reject(new Error('boom'));
    await second;
    await flush();
    expect(applied).toEqual(['good']); // last-good intact
    expect(queue).toHaveLength(2); // no unconditional retry
  });

  it('a trigger queued behind a failed read still gets its trailing read', async () => {
    const { owner, applied, queue } = makeOwner();
    const first = owner.refresh();
    queue[0]!.resolve('good');
    await first;

    const second = owner.refresh();
    void owner.refresh(); // trigger during the second read
    queue[1]!.reject(new Error('boom'));
    await second;
    await flush();
    // The failure retained last-good, but the trigger's trailing read ran.
    expect(applied).toEqual(['good']);
    expect(queue).toHaveLength(3);
    queue[2]!.resolve('trailing');
    await flush();
    expect(applied).toEqual(['good', 'trailing']);
  });
});

describe('createSnapshotOwner — dispose', () => {
  it('dispose suppresses applies and trailing scheduling; repeated dispose is tolerated', async () => {
    const { owner, applied, queue } = makeOwner();
    const first = owner.refresh();
    void owner.refresh(); // trailing owed
    owner.dispose();
    owner.dispose();

    queue[0]!.resolve('stale');
    await first;
    await flush();
    expect(applied).toEqual([]);
    expect(queue).toHaveLength(1); // no trailing read scheduled
  });

  it('refresh after dispose is a no-op', async () => {
    const { owner, queue } = makeOwner();
    owner.dispose();
    await owner.refresh();
    await owner.recontext();
    expect(queue).toHaveLength(0);
  });
});

describe('createSnapshotOwner — coalesced callers', () => {
  it('a coalesced refresh resolves with the in-flight read; its trigger is serviced by the trailing read', async () => {
    const { owner, queue } = makeOwner();
    const first = owner.refresh();
    const coalesced = owner.refresh(); // same flight; one trailing read owed
    let settled = false;
    void coalesced.then(() => {
      settled = true;
    });
    queue[0]!.resolve('v');
    await first;
    await flush();
    expect(settled).toBe(true);
    // The coalesced trigger did not start a concurrent read — its trailing
    // read starts only after the flight settled.
    expect(queue).toHaveLength(2);
    queue[1]!.resolve('trailing');
    await flush();
    expect(queue).toHaveLength(2);
  });
});
