/**
 * Deferred boot search-index rebuild (review finding S8). At boot the watcher
 * attaches but the full-tree index rebuild is deferred to after `ready-to-show`
 * + an idle tick. In the gap the in-memory index is unbuilt, so `search()` must
 * still return hits by falling back to the on-disk scan. This test drives that
 * gap explicitly (no rebuild yet) and then confirms the same query keeps working
 * once the index is live.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toPosix } from '../../shared/path';
import { search } from './index';
import { clearSearchIndex, rebuildSearchIndex, searchIndex } from './index-cache';
import { parseQuery } from './query';

describe('search falls back to a disk scan while the index is unbuilt (S8)', () => {
  let dir: string;
  let readme: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'condash-deferidx-'));
    const item = join(dir, 'projects', '2026-07', '2026-07-08-foo');
    await mkdir(item, { recursive: true });
    readme = join(item, 'README.md');
    await writeFile(readme, '# Foo\n\ndeferredword body\n');
    // The boot gap: watcher attached, index not yet rebuilt.
    clearSearchIndex();
  });

  afterEach(async () => {
    clearSearchIndex();
    await rm(dir, { recursive: true, force: true });
  });

  it('returns hits from the on-disk scan before rebuildSearchIndex has run', async () => {
    // Precondition: no in-memory index for this conception (the deferred-rebuild
    // gap S8 introduces between the watcher attach and the idle-tick rebuild).
    expect(searchIndex(dir, parseQuery('deferredword'), () => true)).toBeNull();
    const results = await search(dir, 'deferredword');
    expect(results.hits.map((h) => h.path)).toContain(toPosix(readme));
  });

  it('returns the same hit once the deferred rebuild has run', async () => {
    await rebuildSearchIndex(dir);
    // Now the in-memory index is live.
    expect(searchIndex(dir, parseQuery('deferredword'), () => true)).not.toBeNull();
    const results = await search(dir, 'deferredword');
    expect(results.hits.map((h) => h.path)).toContain(toPosix(readme));
  });
});
