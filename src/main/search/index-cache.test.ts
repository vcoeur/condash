import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toPosix } from '../../shared/path';
import { parseQuery } from './query';
import { prepareFile } from './match';
import { SKIP_DIR_NAMES } from './walk';
import {
  applyIndexFsEvent,
  clearSearchIndex,
  rebuildSearchIndex,
  searchIndex,
} from './index-cache';

// `prepareFile` is wrapped in a controllable mock (default: pass-through to
// the real implementation) so tests can hold a build open or slow down a
// single event's read — the levers behind the build-window-buffering and
// per-path-ordering regression tests below.
const actualMatch = await vi.importActual<typeof import('./match')>('./match');
vi.mock('./match', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./match')>();
  return { ...actual, prepareFile: vi.fn(actual.prepareFile) };
});
const prepareFileMock = vi.mocked(prepareFile);

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
    prepareFileMock.mockReset();
    prepareFileMock.mockImplementation(actualMatch.prepareFile);
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

  it('classifier skips every walker skip dir (membership parity)', async () => {
    expect(SKIP_DIR_NAMES.has('dist')).toBe(true);
    expect(SKIP_DIR_NAMES.has('target')).toBe(true);
    for (const skip of SKIP_DIR_NAMES) {
      const path = join(dir, 'knowledge', skip, 'doc.md');
      await mkdir(join(dir, 'knowledge', skip), { recursive: true });
      await writeFile(path, 'thetaword\n');
      await applyIndexFsEvent(dir, 'add', path);
    }
    expect(hitPaths(dir, 'thetaword', ALL)).toEqual([]);
  });

  it('event-applied index equals a fresh rebuild over the same tree', async () => {
    const item = join(dir, 'projects', '2026-06', '2026-06-03-foo');
    // Assorted adds: collected ones (note, deep knowledge) and ones the build
    // walker never surfaces (month-level loose file, dist/ and target/ dirs).
    const monthLoose = join(dir, 'projects', '2026-06', 'loose.md');
    const newNote = join(item, 'notes', '02-extra.md');
    const distFile = join(item, 'dist', 'bundle.md');
    const targetFile = join(dir, 'knowledge', 'target', 'doc.md');
    const deepKnowledge = join(dir, 'knowledge', 'sub', 'deep.md');
    await mkdir(join(item, 'dist'), { recursive: true });
    await mkdir(join(dir, 'knowledge', 'target'), { recursive: true });
    await mkdir(join(dir, 'knowledge', 'sub'), { recursive: true });
    for (const path of [monthLoose, newNote, distFile, targetFile, deepKnowledge]) {
      await writeFile(path, '# T\n\nparityword here\n');
    }
    await writeFile(readme, '# Foo\n\nparityword changed\n');
    await rm(note);

    const events: Array<[string, string]> = [
      ['add', monthLoose],
      ['add', newNote],
      ['add', distFile],
      ['add', targetFile],
      ['add', deepKnowledge],
      ['change', readme],
      ['unlink', note],
    ];
    for (const [eventName, path] of events) await applyIndexFsEvent(dir, eventName, path);

    const project = (wantsAll: typeof ALL) =>
      (searchIndex(dir, parseQuery('parityword'), wantsAll) ?? [])
        .map((m) => ({ path: m.hit.path, projectPath: m.hit.projectPath }))
        .sort((a, b) => a.path.localeCompare(b.path));

    const eventApplied = project(ALL);
    await rebuildSearchIndex(dir);
    const rebuilt = project(ALL);
    expect(eventApplied).toEqual(rebuilt);

    // Explicit membership: the loose month-level file and the skip-dir files
    // never enter the index; projectPath points at the item dir, not the file.
    expect(eventApplied.map((h) => h.path)).toEqual(
      [readme, deepKnowledge, newNote].map(toPosix).sort((a, b) => a.localeCompare(b)),
    );
    const noteHit = eventApplied.find((h) => h.path === toPosix(newNote));
    expect(noteHit?.projectPath).toBe(toPosix(item));
  });

  it('buffers events that arrive during a build and replays them after', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reachedGate = 0;
    prepareFileMock.mockImplementation(async (ref) => {
      // Read the (pre-event) content first, then hold the build open.
      const prepared = await actualMatch.prepareFile(ref);
      reachedGate++;
      await gate;
      return prepared;
    });

    const build = rebuildSearchIndex(dir);
    // Wait until all three files were read with their pre-event content.
    while (reachedGate < 3) await new Promise((resolve) => setTimeout(resolve, 5));

    await writeFile(readme, '# Foo\n\nmidbuildword body\n');
    const applied = applyIndexFsEvent(dir, 'change', readme);
    // Not applied synchronously — no index exists during the build window.
    expect(searchIndex(dir, parseQuery('midbuildword'), ALL)).toBeNull();

    prepareFileMock.mockImplementation(actualMatch.prepareFile);
    release();
    await Promise.all([build, applied]);

    // The replay re-read the file, so the index reflects the mid-build write
    // even though the walk captured the stale content.
    expect(hitPaths(dir, 'midbuildword', ALL)).toEqual([toPosix(readme)]);
    expect(hitPaths(dir, 'alphaword', ALL)).toEqual([]);
  });

  it('a newer build supersedes an in-flight build and its event buffer', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    prepareFileMock.mockImplementation(async (ref) => {
      const prepared = await actualMatch.prepareFile(ref);
      await gate;
      return prepared;
    });
    const build1 = rebuildSearchIndex(dir);
    const buffered = applyIndexFsEvent(dir, 'change', readme); // build-window event

    prepareFileMock.mockImplementation(actualMatch.prepareFile);
    const dir2 = await mkdtemp(join(tmpdir(), 'condash-idx2-'));
    await mkdir(join(dir2, 'knowledge'), { recursive: true });
    const other = join(dir2, 'knowledge', 'k.md');
    await writeFile(other, '# K\n\nomegaword\n');
    const build2 = rebuildSearchIndex(dir2);
    release();
    await Promise.all([build1, build2, buffered]);

    // The superseded build (and its buffer) left no trace; the new conception
    // is indexed.
    expect(searchIndex(dir, parseQuery('alphaword'), ALL)).toBeNull();
    expect(hitPaths(dir2, 'omegaword', ALL)).toEqual([toPosix(other)]);
    await rm(dir2, { recursive: true, force: true });
  });

  it('applies concurrent events for the same path in arrival order', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    // The first event's read is slow and deterministically returns the *old*
    // content, completing only after the gate opens.
    prepareFileMock.mockImplementationOnce(async (ref) => {
      const prepared = await actualMatch.prepareFile(ref);
      await firstGate;
      return prepared
        ? { ...prepared, raw: '# Foo\n\noldword body\n', lowerContent: '# foo\n\noldword body\n' }
        : prepared;
    });
    const first = applyIndexFsEvent(dir, 'change', readme);
    await writeFile(readme, '# Foo\n\nnewword body\n');
    const second = applyIndexFsEvent(dir, 'change', readme);
    releaseFirst();
    await Promise.all([first, second]);

    // Without per-path ordering the slow old read would complete last and
    // overwrite the newer content.
    expect(hitPaths(dir, 'newword', ALL)).toEqual([toPosix(readme)]);
    expect(hitPaths(dir, 'oldword', ALL)).toEqual([]);
  });
});
