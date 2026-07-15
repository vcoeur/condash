import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toPosix } from '../shared/path';
import { parseReadme, parseReadmeWithHeader } from './parse';
import {
  parseReadmesWithDiskCache,
  loadParseCache,
  writeParseCache,
  parseCacheFilePath,
  PARSE_CACHE_VERSION,
} from './parse-cache-disk';

/** Reduce a value to its structural shape: primitives → their `typeof`, arrays
 *  → a one-element `[elementShape]` (or `[]` when empty), objects → their keys
 *  (sorted) mapped to sub-shapes. Values drop out, so the result is a stable
 *  fingerprint of the *shape* of what the cache persists. */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.length ? [shapeOf(value[0])] : [];
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = shapeOf((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value === null ? 'null' : typeof value;
}

// A fixture that populates every optional field (apps, branch, base, summary via
// Goal, steps, deliverables, a closed timeline) so the fingerprint below covers
// the whole persisted shape, not just the fields a minimal README happens to set.
const RICH_README = `---
date: 2026-07-01
kind: project
status: done
apps:
  - condash
  - conception
branch: some-branch
base: main
---

# Rich Sample

## Goal

A rich sample.

## Steps

- [x] one
- [ ] two

## Deliverables

- [thing](notes/thing.md) — a deliverable

## Timeline

- 2026-07-01 — Project created.
- 2026-07-02 — Closed. shipped it.
`;

const README = `---
date: 2026-07-01
kind: project
status: now
---

# Sample

## Goal

A sample project.

## Steps

- [x] one
- [ ] two
`;

// A fixed integer-ms mtime that round-trips exactly through `utimes` (stat
// reports sub-ms precision; Date carries only integer ms), so a re-pin
// reproduces the same key the cache stored.
const PINNED = new Date(1_700_000_000_000);

describe('parseReadmesWithDiskCache', () => {
  let root: string;
  let readme: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'condash-parse-disk-'));
    // Shape the temp dir like a conception root so condashDir/parseCacheFilePath
    // resolve `<root>/.condash/cache/readme-parse.json`.
    await mkdir(join(root, '.condash'), { recursive: true });
    const projectDir = join(root, 'projects', '2026-07', '2026-07-01-sample');
    await mkdir(projectDir, { recursive: true });
    readme = join(projectDir, 'README.md');
    await writeFile(readme, README, 'utf8');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('serves an unchanged README from the disk cache (stat-only hit)', async () => {
    await utimes(readme, PINNED, PINNED);
    const [first] = await parseReadmesWithDiskCache(root, [readme]);
    expect(first.project.stepCounts.done).toBe(1);

    // Edit the body but restore the same mtime → the mtime key still matches the
    // stored entry, so a fresh call serves the cached (stale) parse, proving it
    // read the cache file rather than re-reading the README.
    await writeFile(readme, README.replace('- [ ] two', '- [x] two'), 'utf8');
    await utimes(readme, PINNED, PINNED);
    const [second] = await parseReadmesWithDiskCache(root, [readme]);
    expect(second.project.stepCounts.done).toBe(1);
  });

  it('re-parses when only the size changes (same mtime) — the size key (P4)', async () => {
    await utimes(readme, PINNED, PINNED);
    const [first] = await parseReadmesWithDiskCache(root, [readme]);
    expect(first.project.stepCounts.done).toBe(1);

    // Complete the open step AND grow the file, then restore the SAME mtime.
    // With mtime-only keying this is a false hit; the size component catches it.
    await writeFile(
      readme,
      README.replace('- [ ] two', '- [x] two') + '\n<!-- padding changes the byte size -->\n',
      'utf8',
    );
    await utimes(readme, PINNED, PINNED);
    const [second] = await parseReadmesWithDiskCache(root, [readme]);
    expect(second.project.stepCounts.done).toBe(2);
  });

  it('re-parses when the README mtime changes', async () => {
    await utimes(readme, PINNED, PINNED);
    await parseReadmesWithDiskCache(root, [readme]);

    await writeFile(readme, README.replace('- [ ] two', '- [x] two'), 'utf8');
    const later = new Date(PINNED.getTime() + 5000);
    await utimes(readme, later, later);
    const [again] = await parseReadmesWithDiskCache(root, [readme]);
    expect(again.project.stepCounts.done).toBe(2);
  });

  it('falls through to a cold parse when the cache file is corrupt', async () => {
    const cachePath = parseCacheFilePath(root);
    await mkdir(join(root, '.condash', 'cache'), { recursive: true });
    await writeFile(cachePath, '{ this is not valid json', 'utf8');

    const [result] = await parseReadmesWithDiskCache(root, [readme]);
    // Correct parse despite the garbage file...
    expect(result.project.stepCounts.done).toBe(1);
    // ...and the run rewrote a valid, current cache over the corruption.
    const reloaded = await loadParseCache(root);
    expect(reloaded.get(toPosix(readme))?.project.stepCounts.done).toBe(1);
  });

  it('prunes entries for READMEs no longer in the live set on write', async () => {
    const ghost = toPosix(join(root, 'projects', '2026-01', '2026-01-01-gone', 'README.md'));
    const direct = await parseReadme(readme);
    await writeParseCache(
      root,
      new Map([[ghost, { mtimeMs: 1, size: 1, project: direct, header: { extra: {} } as never }]]),
    );

    await parseReadmesWithDiskCache(root, [readme]);
    const reloaded = await loadParseCache(root);
    expect(reloaded.has(ghost)).toBe(false);
    expect(reloaded.has(toPosix(readme))).toBe(true);
  });

  it('round-trips a parsed Project through a write then a fresh read', async () => {
    await parseReadmesWithDiskCache(root, [readme]);
    const reloaded = await loadParseCache(root);
    const entry = reloaded.get(toPosix(readme));
    const direct = await parseReadme(readme);
    expect(entry?.project).toEqual(direct);
    expect(entry?.header.date).toBe('2026-07-01');
  });

  it('writes a versioned cache file', async () => {
    await parseReadmesWithDiskCache(root, [readme]);
    const raw = JSON.parse(await readFile(parseCacheFilePath(root), 'utf8'));
    expect(raw.version).toBe(PARSE_CACHE_VERSION);
  });

  it('ignores a cache file written by a different format version', async () => {
    const cachePath = parseCacheFilePath(root);
    const { mtimeMs } = await stat(readme);
    const direct = await parseReadme(readme);
    await mkdir(join(root, '.condash', 'cache'), { recursive: true });
    // A future-version file carrying a bogus (all-done) parse must be discarded,
    // not trusted — a real parse of the on-disk README has one open step.
    await writeFile(
      cachePath,
      JSON.stringify({
        version: PARSE_CACHE_VERSION + 1,
        entries: {
          [toPosix(readme)]: {
            mtimeMs,
            project: { ...direct, stepCounts: { ...direct.stepCounts, done: 99, todo: 0 } },
            header: { extra: {} },
          },
        },
      }),
      'utf8',
    );

    const [result] = await parseReadmesWithDiskCache(root, [readme]);
    expect(result.project.stepCounts.done).toBe(1);
  });

  it('skips an entry missing the fields consumers dereference (F1 guard)', async () => {
    const cachePath = parseCacheFilePath(root);
    const { mtimeMs } = await stat(readme);
    await mkdir(join(root, '.condash', 'cache'), { recursive: true });
    // Valid JSON, matching mtime, but the project has only `slug` — the shape a
    // list/read consumer would throw on (project.apps.length / title.slice /
    // stepCounts, header.apps.length). loadParseCache must treat it as malformed
    // and drop it, not admit it to be served on the mtime hit.
    await writeFile(
      cachePath,
      JSON.stringify({
        version: PARSE_CACHE_VERSION,
        entries: { [toPosix(readme)]: { mtimeMs, project: { slug: 'x' }, header: { extra: {} } } },
      }),
      'utf8',
    );
    expect((await loadParseCache(root)).has(toPosix(readme))).toBe(false);
    // End to end: the thin entry is skipped, so the README is parsed cold and
    // the command returns correct output rather than throwing RUNTIME.
    const [result] = await parseReadmesWithDiskCache(root, [readme]);
    expect(result.project.stepCounts.done).toBe(1);
  });

  it('pins the persisted {project, header} shape to PARSE_CACHE_VERSION (F2 drift guard)', async () => {
    const richProjectDir = join(root, 'projects', '2026-07', '2026-07-01-rich');
    await mkdir(richProjectDir, { recursive: true });
    const richReadme = join(richProjectDir, 'README.md');
    await writeFile(richReadme, RICH_README, 'utf8');
    const { project, header } = await parseReadmeWithHeader(richReadme);
    const fingerprint = JSON.stringify(shapeOf({ project, header }));

    // If this fails because you changed the shape of `Project`/`HeaderFields` or
    // the parse output, a warm on-disk cache written by an older build would
    // serve the old shape. In the SAME commit: bump PARSE_CACHE_VERSION (so those
    // caches are discarded) and update EXPECTED below to the new fingerprint.
    const EXPECTED =
      '{"header":{"apps":["string"],"base":"string","branch":"string","date":"string","extra":{},"kind":"string","parent":"null","status":"string","title":"string"},"project":{"apps":["string"],"base":"string","branch":"string","closedAt":"string","deliverableCount":"number","deliverables":[{"description":"string","kind":"string","label":"string","path":"string"}],"kind":"string","lastActivity":"string","parent":"null","path":"string","slug":"string","status":"string","stepCounts":{"blocked":"number","doing":"number","done":"number","dropped":"number","todo":"number"},"steps":[{"lineIndex":"number","marker":"string","section":"string","text":"string"}],"summary":"string","timeline":[{"date":"string","text":"string"}],"title":"string"}}';
    expect({ fingerprint, version: PARSE_CACHE_VERSION }).toEqual({
      fingerprint: EXPECTED,
      version: PARSE_CACHE_VERSION,
    });
  });
});
