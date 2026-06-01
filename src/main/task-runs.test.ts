import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isTaskRunPath,
  listTaskRuns,
  rotateTaskRuns,
  taskRunDir,
  taskRunLogPath,
} from './task-runs';
import { condashLogsRoot } from './condash-dir';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'condash-taskruns-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seedRun(trigger: 'scheduled' | 'manual', slug: string, name: string): void {
  const dir = taskRunDir(root, trigger, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), '# condash: {"sid":"x"}\n\nbody\n');
}

describe('taskRunLogPath', () => {
  it('builds .condash/<trigger>/<slug>/YYYYMMDD-HHMMSS-<sid>.txt', () => {
    const p = taskRunLogPath(
      root,
      'scheduled',
      'sample-task',
      't-abc',
      new Date('2026-05-31T09:08:07'),
    );
    expect(p).toContain(join('.condash', 'scheduled', 'sample-task'));
    expect(p.endsWith('20260531-090807-t-abc.txt')).toBe(true);
  });
});

describe('rotateTaskRuns', () => {
  it('keeps the newest N run files, prunes the rest', async () => {
    const slug = 'sample-task';
    for (let i = 1; i <= 8; i++) {
      seedRun('scheduled', slug, `2026053${i}-090807-t-${i}.txt`);
    }
    await rotateTaskRuns(taskRunDir(root, 'scheduled', slug), 5);
    const remaining = readdirSync(taskRunDir(root, 'scheduled', slug)).sort();
    expect(remaining.length).toBe(5);
    // Newest five (suffix 4..8) survive; oldest (1..3) pruned.
    expect(remaining[0]).toContain('-t-4.txt');
    expect(remaining.at(-1)).toContain('-t-8.txt');
  });

  it('is a no-op on a missing dir', async () => {
    await expect(rotateTaskRuns(taskRunDir(root, 'manual', 'nope'))).resolves.toBeUndefined();
  });
});

describe('listTaskRuns', () => {
  it('groups by trigger+slug, runs newest-first', async () => {
    seedRun('scheduled', 'sample-task', '20260531-090801-t-a.txt');
    seedRun('scheduled', 'sample-task', '20260531-090802-t-b.txt');
    seedRun('manual', 'sample-task', '20260531-090803-t-c.txt');
    const groups = await listTaskRuns(root);
    const scheduled = groups.find((g) => g.trigger === 'scheduled')!;
    expect(scheduled.taskSlug).toBe('sample-task');
    expect(scheduled.runs.map((r) => r.sid)).toEqual(['t-b', 't-a']); // newest first
    expect(scheduled.runs[0].day).toBe('2026-05-31');
    expect(scheduled.runs[0].time).toBe('09:08:02');
    expect(groups.some((g) => g.trigger === 'manual')).toBe(true);
  });

  it('returns [] when the store is empty', async () => {
    expect(await listTaskRuns(root)).toEqual([]);
  });

  it('ignores files that are not run-shaped', async () => {
    seedRun('scheduled', 'sample-task', 'not-a-run.txt');
    expect(await listTaskRuns(root)).toEqual([]);
  });
});

describe('isTaskRunPath', () => {
  it('accepts a .txt under a task-run dir', () => {
    expect(isTaskRunPath(root, taskRunLogPath(root, 'manual', 's', 't-a'))).toBe(true);
  });
  it('rejects a normal logs path and non-.txt', () => {
    expect(
      isTaskRunPath(root, join(condashLogsRoot(root), '2026', '05', '31', '090807-t-a.txt')),
    ).toBe(false);
    expect(isTaskRunPath(root, taskRunDir(root, 'manual', 's') + '/run.log')).toBe(false);
  });
});
