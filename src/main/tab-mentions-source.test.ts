import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The needle cache's staleness contract. The scorer is tested next door with
 * plain fixtures; what matters here is the lifecycle around it — a rebuild that
 * reads the tree over hundreds of milliseconds must not clear staleness for a
 * change it could not have seen.
 */

const h = vi.hoisted(() => ({
  findProjectReadmes: vi.fn(async () => ['/c/projects/2026-08/2026-08-01-alpha/README.md']),
  parseReadmeCached: vi.fn(async (path: string) => ({
    slug: path.split('/').at(-2),
    status: 'now',
    branch: null,
  })),
  getEffectiveConceptionConfig: vi.fn(async () => ({ long_lived_branches: [] })),
}));

vi.mock('./walk', () => ({ findProjectReadmes: h.findProjectReadmes }));
vi.mock('./parse-cache', () => ({ parseReadmeCached: h.parseReadmeCached }));
vi.mock('./effective-config', () => ({
  getEffectiveConceptionConfig: h.getEffectiveConceptionConfig,
}));

const CONCEPTION = '/c';

/** Let the fire-and-forget rebuild settle before asserting on the next call. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('mentionNeedles', () => {
  let source: typeof import('./tab-mentions-source');

  beforeEach(async () => {
    vi.clearAllMocks();
    // Module state is process-wide; a fresh registry per test keeps them
    // independent of each other's builds.
    vi.resetModules();
    source = await import('./tab-mentions-source');
  });

  it('serves nothing on the first call and the built set after', async () => {
    expect(source.mentionNeedles(CONCEPTION)).toEqual([]);
    await settle();
    expect(source.mentionNeedles(CONCEPTION).map((n) => n.slug)).toContain('2026-08-01-alpha');
  });

  it('does not rebuild while the set is fresh', async () => {
    source.mentionNeedles(CONCEPTION);
    await settle();
    source.mentionNeedles(CONCEPTION);
    source.mentionNeedles(CONCEPTION);
    await settle();
    expect(h.findProjectReadmes).toHaveBeenCalledTimes(1);
  });

  it('rebuilds after an invalidation', async () => {
    source.mentionNeedles(CONCEPTION);
    await settle();
    source.invalidateMentionNeedles();
    source.mentionNeedles(CONCEPTION);
    await settle();
    expect(h.findProjectReadmes).toHaveBeenCalledTimes(2);
  });

  it('does not strand a change that landed mid-build', async () => {
    // The regression this guards: without the invalidation counter, the
    // in-flight build clears staleness on completion and the write that arrived
    // while it was reading is never picked up — the set stays wrong until the
    // tree happens to change again.
    let releaseBuild: () => void = () => {};
    h.findProjectReadmes.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseBuild = resolve;
      });
      return ['/c/projects/2026-08/2026-08-01-alpha/README.md'];
    });

    source.mentionNeedles(CONCEPTION); // kicks the slow build
    source.invalidateMentionNeedles(); // a README lands while it reads
    releaseBuild();
    await settle();

    source.mentionNeedles(CONCEPTION);
    await settle();
    expect(h.findProjectReadmes).toHaveBeenCalledTimes(2);
  });

  it('serves nothing, and rebuilds, for a different conception', async () => {
    source.mentionNeedles(CONCEPTION);
    await settle();
    expect(source.mentionNeedles('/other')).toEqual([]);
    await settle();
    expect(h.findProjectReadmes).toHaveBeenLastCalledWith('/other');
  });

  it('clears to nothing when the conception goes away', async () => {
    source.mentionNeedles(CONCEPTION);
    await settle();
    expect(source.mentionNeedles(null)).toEqual([]);
    // Cleared, not merely unserved: coming back rebuilds rather than serving
    // the tree the user just left.
    source.mentionNeedles(CONCEPTION);
    await settle();
    expect(h.findProjectReadmes).toHaveBeenCalledTimes(2);
  });

  it('keeps the previous set when a rebuild throws', async () => {
    source.mentionNeedles(CONCEPTION);
    await settle();
    const before = source.mentionNeedles(CONCEPTION);
    h.findProjectReadmes.mockRejectedValueOnce(new Error('tree unreadable'));
    source.invalidateMentionNeedles();
    source.mentionNeedles(CONCEPTION);
    await settle();
    expect(source.mentionNeedles(CONCEPTION)).toEqual(before);
  });

  it('drops a README that will not parse instead of failing the build', async () => {
    h.findProjectReadmes.mockResolvedValueOnce([
      '/c/projects/2026-08/2026-08-01-alpha/README.md',
      '/c/projects/2026-08/2026-08-02-broken/README.md',
    ]);
    h.parseReadmeCached.mockImplementationOnce(async (path: string) => ({
      slug: path.split('/').at(-2),
      status: 'now',
      branch: null,
    }));
    h.parseReadmeCached.mockRejectedValueOnce(new Error('malformed header'));
    source.mentionNeedles(CONCEPTION);
    await settle();
    const slugs = source.mentionNeedles(CONCEPTION).map((n) => n.slug);
    expect(slugs).toContain('2026-08-01-alpha');
    expect(slugs).not.toContain('2026-08-02-broken');
  });
});
