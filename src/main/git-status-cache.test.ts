/**
 * Tests for the dirty-count cache: concurrent misses coalesce onto one
 * in-flight `git status`, an invalidate during flight discards the completing
 * result, and the 3 s TTL still governs completed entries (internals §3).
 * `simple-git` is mocked so the tests control exactly when "git" resolves.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { simpleGit } from 'simple-git';
import { getDirtyCount, invalidateAll, invalidateForPath } from './git-status-cache';

vi.mock('simple-git', () => ({ simpleGit: vi.fn() }));

interface Deferred {
  promise: Promise<string>;
  resolve: (out: string) => void;
}

function deferred(): Deferred {
  let resolve!: (out: string) => void;
  const promise = new Promise<string>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let rawMock: Mock;

beforeEach(() => {
  invalidateAll();
  rawMock = vi.fn();
  (simpleGit as unknown as Mock).mockReturnValue({ raw: rawMock });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getDirtyCount coalescing', () => {
  it('coalesces concurrent misses onto a single git status', async () => {
    const d = deferred();
    rawMock.mockReturnValue(d.promise);
    const p1 = getDirtyCount('/coalesce-a');
    const p2 = getDirtyCount('/coalesce-a');
    // Let the async computation reach its git call before asserting. The
    // dirty-count path lazy-imports `simple-git` (kept off the pre-window boot
    // graph), so the first call crosses an extra async hop — poll for the git
    // call rather than assume a fixed tick. Coalescing guarantees it settles at
    // exactly one invocation.
    await vi.waitFor(() => expect(rawMock).toHaveBeenCalledTimes(1));
    d.resolve(' M a.ts\n M b.ts\n');
    expect(await p1).toBe(2);
    expect(await p2).toBe(2);
    // A follow-up read within the TTL serves the cached value — still one
    // git invocation in total.
    expect(await getDirtyCount('/coalesce-a')).toBe(2);
    expect(rawMock).toHaveBeenCalledTimes(1);
  });

  it('keeps subtree-scoped and unscoped lookups on separate slots', async () => {
    // Scoped lookups issue `rev-parse --show-prefix` first, so resolve every
    // raw call immediately here.
    rawMock.mockImplementation((args: string[]) =>
      Promise.resolve(args[0] === 'rev-parse' ? '' : ' M a.ts\n'),
    );
    await getDirtyCount('/coalesce-b');
    await getDirtyCount('/coalesce-b', { scopeToSubtree: true });
    // 1 status (unscoped) + prefix lookup & status (scoped) = 3 raw calls.
    expect(rawMock).toHaveBeenCalledTimes(3);
  });

  it('invalidateForPath during flight discards the completing result', async () => {
    const d = deferred();
    rawMock.mockReturnValueOnce(d.promise);
    const inFlight = getDirtyCount('/coalesce-c');
    invalidateForPath('/coalesce-c');
    d.resolve(' M a.ts\n');
    // The in-flight caller still gets its (now possibly stale) answer…
    expect(await inFlight).toBe(1);
    // …but the cache was not repopulated: the next lookup re-runs git and
    // sees the new state.
    rawMock.mockResolvedValueOnce(' M a.ts\n M b.ts\n');
    expect(await getDirtyCount('/coalesce-c')).toBe(2);
    expect(rawMock).toHaveBeenCalledTimes(2);
  });

  it('expires completed entries after the TTL', async () => {
    vi.useFakeTimers();
    rawMock.mockResolvedValue(' M a.ts\n');
    expect(await getDirtyCount('/coalesce-d')).toBe(1);
    expect(rawMock).toHaveBeenCalledTimes(1);
    // Inside the 3 s window: cached.
    vi.advanceTimersByTime(2_000);
    expect(await getDirtyCount('/coalesce-d')).toBe(1);
    expect(rawMock).toHaveBeenCalledTimes(1);
    // Past it: recomputed.
    vi.advanceTimersByTime(2_000);
    expect(await getDirtyCount('/coalesce-d')).toBe(1);
    expect(rawMock).toHaveBeenCalledTimes(2);
  });
});
