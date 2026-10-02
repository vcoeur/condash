import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ supported: true, show: vi.fn(), construct: vi.fn() }));
vi.mock('electron', () => ({
  Notification: class {
    static isSupported(): boolean {
      return h.supported;
    }
    constructor(options: unknown) {
      h.construct(options);
    }
    show(): void {
      h.show();
    }
  },
}));
import { notifyBlockedSync } from './notification';
beforeEach(() => {
  h.supported = true;
  h.show.mockReset();
  h.construct.mockReset();
});
describe('Electron blocked-sync notification adapter', () => {
  it('delivers the actual count and first detected time', () => {
    const since = 1_700_000_000_000;
    notifyBlockedSync('/tmp/fixture-conception', { waitingCommits: 7, since });
    expect(h.construct).toHaveBeenCalledWith({
      title: 'condash: integration needed — fixture-conception',
      body: expect.stringContaining(
        `7 commit(s) waiting to push. First detected ${new Date(since).toLocaleString()}`,
      ),
    });
    expect(h.show).toHaveBeenCalledTimes(1);
  });
  it('reports an unknown count explicitly and no-ops on unsupported desktops', () => {
    notifyBlockedSync('/tmp/fixture', { waitingCommits: null, since: 1 });
    expect(h.construct).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('count unknown') }),
    );
    h.supported = false;
    notifyBlockedSync('/tmp/fixture', { waitingCommits: 0, since: 1 });
    expect(h.show).toHaveBeenCalledTimes(1);
  });
});
