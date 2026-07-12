/**
 * Tests for the status-bar sync snapshot: the pure `parseRecentCommits`
 * (field split + unpushed marking) and one real-git integration of
 * `getSyncStatusSnapshot` (pending count + recent commits with no upstream).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exec } from '../exec';
import { invalidateAll } from '../git-status-cache';
import { LOG_FIELD_SEP, getSyncStatusSnapshot, parseRecentCommits } from './status-snapshot';

describe('parseRecentCommits', () => {
  const line = (sha: string, subject: string, when: string): string =>
    [sha, subject, when].join(LOG_FIELD_SEP);

  it('returns an empty array for empty output', () => {
    expect(parseRecentCommits('', 0)).toEqual([]);
  });

  it('splits sha / subject / relative-time and marks the newest `ahead` unpushed', () => {
    const out = [
      line('aaa', 'newest', '1 minute ago'),
      line('bbb', 'middle', '2 hours ago'),
      line('ccc', 'oldest', '3 days ago'),
    ].join('\n');
    const commits = parseRecentCommits(out, 2);
    expect(commits).toEqual([
      { sha: 'aaa', subject: 'newest', relativeTime: '1 minute ago', pushed: false },
      { sha: 'bbb', subject: 'middle', relativeTime: '2 hours ago', pushed: false },
      { sha: 'ccc', subject: 'oldest', relativeTime: '3 days ago', pushed: true },
    ]);
  });

  it('marks every commit pushed when ahead is 0', () => {
    const out = line('aaa', 'only', 'just now');
    expect(parseRecentCommits(out, 0)).toEqual([
      { sha: 'aaa', subject: 'only', relativeTime: 'just now', pushed: true },
    ]);
  });

  it('tolerates a subject containing spaces and preserves it verbatim', () => {
    const out = line('aaa', 'feat: add a thing, and more', '5 minutes ago');
    expect(parseRecentCommits(out, 0)[0].subject).toBe('feat: add a thing, and more');
  });
});

describe('getSyncStatusSnapshot (real git)', () => {
  let repo: string;

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'condash-sync-snap-'));
    await exec('git', ['init', '-b', 'main'], { cwd: repo });
    await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    await exec('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'one\n', 'utf8');
    await exec('git', ['add', 'a.txt'], { cwd: repo });
    await exec('git', ['commit', '-m', 'first commit'], { cwd: repo });
    // One uncommitted file → pendingCount 1.
    writeFileSync(join(repo, 'b.txt'), 'two\n', 'utf8');
    invalidateAll();
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('counts pending files and lists recent commits with no upstream', async () => {
    const snapshot = await getSyncStatusSnapshot(repo);
    expect(snapshot.pendingCount).toBe(1);
    expect(snapshot.ahead).toBe(0);
    expect(snapshot.hasUpstream).toBe(false);
    expect(snapshot.recentCommits).toHaveLength(1);
    expect(snapshot.recentCommits[0].subject).toBe('first commit');
    // No upstream → nothing is "ahead" → the commit reads as pushed.
    expect(snapshot.recentCommits[0].pushed).toBe(true);
  });
});
