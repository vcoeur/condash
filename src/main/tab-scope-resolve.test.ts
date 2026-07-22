import { beforeEach, describe, expect, it, vi } from 'vitest';

// Only `readFileSync` is stubbed; the rest of `node:fs` stays real so the other
// tab-scope helpers in the sibling suite are unaffected.
const readFileSync = vi.hoisted(() => vi.fn());
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  readFileSync,
}));

const { resolveScopeCgroup } = await import('./tab-scope');

/** condash's own app scope — what `/proc/<pid>/cgroup` reports for a child that
 *  `systemd-run` has exec'd but not yet migrated into its unit. */
const PARENT = '/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-condash-42.scope';
const UNIT = 'condash-term-t-abc123.scope';
const OWN_UNIT = `/user.slice/user-1000.slice/user@1000.service/app.slice/${UNIT}`;

/** Feed `/proc/<pid>/cgroup` contents in order, repeating the last entry. */
function cgroupReads(...paths: string[]): void {
  let call = 0;
  readFileSync.mockImplementation(() => {
    const path = paths[Math.min(call, paths.length - 1)];
    call += 1;
    return `0::${path}\n`;
  });
}

describe('resolveScopeCgroup', () => {
  beforeEach(() => {
    readFileSync.mockReset();
  });

  it('waits for the migration instead of caching the parent cgroup', async () => {
    // The regression this whole module exists for: `systemd-run --scope` execs
    // before the user manager has created the unit, so the first reads return
    // condash's OWN app scope. Resolving on the first read gave every tab the
    // same foreign path — one identical memory figure per row, and death
    // verdicts derived from condash's counters rather than the tab's.
    cgroupReads(PARENT, PARENT, PARENT, OWN_UNIT);

    await expect(resolveScopeCgroup(4242, UNIT)).resolves.toBe(OWN_UNIT);
    expect(readFileSync).toHaveBeenCalledTimes(4);
  });

  it('never returns a path belonging to another unit', async () => {
    // A sibling tab's scope is a valid cgroup that a "changed from the parent"
    // check would happily accept. Matching the unit name rejects it.
    const sibling =
      '/user.slice/user-1000.slice/user@1000.service/app.slice/condash-term-t-999.scope';
    cgroupReads(sibling);

    await expect(resolveScopeCgroup(4242, UNIT, hasRetries(2))).resolves.toBeUndefined();
  });

  it('gives up when the session dies during migration', async () => {
    // A tab that dies before migrating must not hold the poll open, and must
    // not acquire a path afterwards.
    cgroupReads(PARENT);

    await expect(resolveScopeCgroup(4242, UNIT, hasRetries(3))).resolves.toBeUndefined();
    // One read per liveness-permitted pass, plus the final read that finds the
    // session gone.
    expect(readFileSync.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('returns undefined when the pid is already gone', async () => {
    readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    await expect(resolveScopeCgroup(4242, UNIT, hasRetries(1))).resolves.toBeUndefined();
  });
});

/** An `isAlive` that permits `count` retries then reports the session gone, so a
 *  negative case terminates on liveness rather than on the 3 s timeout. */
function hasRetries(count: number): () => boolean {
  let left = count;
  return () => left-- > 0;
}
