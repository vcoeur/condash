import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toPosix } from '../../shared/path';
import { parseQuery } from './query';
import {
  applyIndexFsEvent,
  clearSearchIndex,
  rebuildSearchIndex,
  searchIndex,
} from './index-cache';

const ALL = () => true;
/** Match the renderer's scope-pill semantics. */
const only =
  (...scopes: string[]) =>
  (s: string) =>
    scopes.includes(s);

function hitPaths(conception: string, query: string, wants: (s: string) => boolean): string[] {
  const out = searchIndex(conception, parseQuery(query), wants);
  return (out ?? []).map((m) => m.hit.path);
}

describe('search index-cache', () => {
  let dir: string;
  let readme: string;
  let note: string;
  let knowledge: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'condash-idx-'));
    const item = join(dir, 'projects', '2026-06', '2026-06-03-foo');
    await mkdir(join(item, 'notes'), { recursive: true });
    await mkdir(join(dir, 'knowledge'), { recursive: true });
    readme = join(item, 'README.md');
    note = join(item, 'notes', '01-design.md');
    knowledge = join(dir, 'knowledge', 'topic.md');
    await writeFile(readme, '# Foo\n\nalphaword body\n');
    await writeFile(note, '# Design\n\ngammaword detail\n');
    await writeFile(knowledge, '# Topic\n\ndeltaword reference\n');
    await rebuildSearchIndex(dir);
  });

  afterEach(async () => {
    clearSearchIndex();
    await rm(dir, { recursive: true, force: true });
  });

  it('indexes READMEs, project notes, and knowledge', () => {
    expect(hitPaths(dir, 'alphaword', ALL)).toEqual([toPosix(readme)]);
    // Project notes are indexed even though the renderer watcher classifies
    // them as `unknown`.
    expect(hitPaths(dir, 'gammaword', ALL)).toEqual([toPosix(note)]);
    expect(hitPaths(dir, 'deltaword', ALL)).toEqual([toPosix(knowledge)]);
  });

  it('honours the scope filter', () => {
    expect(hitPaths(dir, 'deltaword', only('projects'))).toEqual([]);
    expect(hitPaths(dir, 'deltaword', only('knowledge'))).toEqual([toPosix(knowledge)]);
    expect(hitPaths(dir, 'alphaword', only('projects'))).toEqual([toPosix(readme)]);
  });

  it('returns null when no index is built for the conception', () => {
    expect(searchIndex('/some/other/conception', parseQuery('alphaword'), ALL)).toBeNull();
    clearSearchIndex();
    expect(searchIndex(dir, parseQuery('alphaword'), ALL)).toBeNull();
  });

  it('incrementally adds a new note', async () => {
    const added = join(dir, 'projects', '2026-06', '2026-06-03-foo', 'notes', '02-more.md');
    await writeFile(added, 'epsilonword\n');
    await applyIndexFsEvent(dir, 'add', added);
    expect(hitPaths(dir, 'epsilonword', ALL)).toEqual([toPosix(added)]);
  });

  it('incrementally reflects a change', async () => {
    await writeFile(readme, '# Foo\n\nzetaword body\n');
    await applyIndexFsEvent(dir, 'change', readme);
    expect(hitPaths(dir, 'zetaword', ALL)).toEqual([toPosix(readme)]);
    expect(hitPaths(dir, 'alphaword', ALL)).toEqual([]);
  });

  it('incrementally drops an unlinked file', async () => {
    await applyIndexFsEvent(dir, 'unlink', note);
    expect(hitPaths(dir, 'gammaword', ALL)).toEqual([]);
  });

  it('ignores non-indexed paths (local/, dotfiles)', async () => {
    const item = join(dir, 'projects', '2026-06', '2026-06-03-foo');
    const inLocal = join(item, 'local', 'scratch.md');
    await mkdir(join(item, 'local'), { recursive: true });
    await writeFile(inLocal, 'etaword\n');
    await applyIndexFsEvent(dir, 'add', inLocal);
    expect(hitPaths(dir, 'etaword', ALL)).toEqual([]);
  });
});
