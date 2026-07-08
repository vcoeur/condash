import { describe, expect, it, vi } from 'vitest';

// watcher-status imports electron (BrowserWindow) at module load; stub it so the
// pure `describeWatcherError` can be tested without an Electron runtime.
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

import { describeWatcherError } from './watcher-status';

describe('describeWatcherError (W3)', () => {
  it('gives an inotify-raise hint for EMFILE / ENOSPC exhaustion', () => {
    for (const code of ['EMFILE', 'ENOSPC']) {
      const msg = describeWatcherError(Object.assign(new Error('boom'), { code }), 'repo /x');
      expect(msg).toContain(code);
      expect(msg).toMatch(/inotify/i);
      expect(msg).toContain('repo /x');
    }
  });

  it('falls back to a generic message with an F5 hint for other errors', () => {
    const msg = describeWatcherError(new Error('disk gone'), 'conception tree');
    expect(msg).toContain('conception tree');
    expect(msg).toContain('disk gone');
    expect(msg).toMatch(/F5/);
  });

  it('tolerates a non-Error thrown value', () => {
    const msg = describeWatcherError('weird', 'repo /y');
    expect(msg).toContain('weird');
    expect(msg).toContain('repo /y');
  });
});
