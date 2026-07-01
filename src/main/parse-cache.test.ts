import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseReadmeCached,
  invalidateReadmeCache,
  clearReadmeCache,
  readmeCacheSize,
} from './parse-cache';

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

describe('parseReadmeCached', () => {
  let dir: string;
  let readme: string;

  beforeEach(async () => {
    clearReadmeCache();
    dir = await mkdtemp(join(tmpdir(), 'condash-parse-cache-'));
    const projectDir = join(dir, 'projects', '2026-07', '2026-07-01-sample');
    await mkdir(projectDir, { recursive: true });
    readme = join(projectDir, 'README.md');
    await writeFile(readme, README, 'utf8');
  });

  afterEach(async () => {
    clearReadmeCache();
    await rm(dir, { recursive: true, force: true });
  });

  it('parses on first call and returns the same object on an unchanged file', async () => {
    const first = await parseReadmeCached(readme);
    const second = await parseReadmeCached(readme);
    // Identity: a cache hit returns the memoised object — it did not re-parse.
    expect(second).toBe(first);
    expect(first.title).toBe('Sample');
    expect(first.stepCounts.done).toBe(1);
    expect(first.stepCounts.todo).toBe(1);
    expect(readmeCacheSize()).toBe(1);
  });

  it('re-parses after the file mtime changes', async () => {
    const first = await parseReadmeCached(readme);
    // Force a strictly later mtime, independent of filesystem timestamp
    // resolution.
    const { mtimeMs } = await stat(readme);
    const later = new Date(mtimeMs + 5000);
    await utimes(readme, later, later);
    const second = await parseReadmeCached(readme);
    expect(second).not.toBe(first);
    expect(readmeCacheSize()).toBe(1);
  });

  it('re-parses after invalidateReadmeCache', async () => {
    const first = await parseReadmeCached(readme);
    invalidateReadmeCache(readme);
    expect(readmeCacheSize()).toBe(0);
    const second = await parseReadmeCached(readme);
    expect(second).not.toBe(first);
  });

  it('invalidate is a no-op for an uncached path', () => {
    expect(() => invalidateReadmeCache(join(dir, 'nope', 'README.md'))).not.toThrow();
    expect(readmeCacheSize()).toBe(0);
  });

  it('reflects edited content only after invalidation', async () => {
    // Pin a fixed integer-ms mtime so `utimes` round-trips it exactly (stat
    // reports sub-ms precision; Date carries only integer ms).
    const pinned = new Date(1_700_000_000_000);
    await utimes(readme, pinned, pinned);
    const first = await parseReadmeCached(readme);
    expect(first.stepCounts.done).toBe(1);
    // Edit the file but restore the same mtime → a stale hit still serves the
    // old parse (the mtime key deliberately doesn't diff content).
    await writeFile(readme, README.replace('- [ ] two', '- [x] two'), 'utf8');
    await utimes(readme, pinned, pinned);
    const stale = await parseReadmeCached(readme);
    expect(stale).toBe(first);
    // Now invalidate → next call re-reads and sees both steps done.
    invalidateReadmeCache(readme);
    const fresh = await parseReadmeCached(readme);
    expect(fresh.stepCounts.done).toBe(2);
  });

  it('clearReadmeCache drops every entry', async () => {
    await parseReadmeCached(readme);
    expect(readmeCacheSize()).toBe(1);
    clearReadmeCache();
    expect(readmeCacheSize()).toBe(0);
  });
});
