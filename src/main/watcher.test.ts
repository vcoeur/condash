import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setWatchedConception } from './watcher';
import { applyIndexFsEvent, clearSearchIndex } from './search/index-cache';
import { safeSend } from './safe-send';

const watchers = vi.hoisted(
  () =>
    [] as { callbacks: Map<string, (...args: any[]) => void>; close: ReturnType<typeof vi.fn> }[],
);
vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn(() => {
      const watcher = {
        callbacks: new Map(),
        close: vi.fn().mockResolvedValue(undefined),
        on(name: string, callback: (...args: any[]) => void) {
          this.callbacks.set(name, callback);
          return this;
        },
      };
      watchers.push(watcher);
      return watcher;
    }),
  },
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: {} }] },
}));
vi.mock('./safe-send', () => ({ safeSend: vi.fn() }));
vi.mock('./watcher-status', () => ({ reportWatcherError: vi.fn() }));
vi.mock('./condash-dir-migrate', () => ({
  migrateLegacyConfig: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./scope-partition-migrate', () => ({
  partitionSettingsScopes: vi.fn().mockResolvedValue({}),
  scopeMigrationDidWork: () => false,
}));
vi.mock('./conception-paths', () => ({
  resolveConceptionPaths: () => ({ resources: 'resources', skills: '.agents/skills' }),
}));
vi.mock('./search/index-cache', () => ({
  applyIndexFsEvent: vi.fn().mockResolvedValue(undefined),
  clearSearchIndex: vi.fn(),
  rebuildSearchIndex: vi.fn().mockResolvedValue(undefined),
  isReadmePath: () => false,
}));
vi.mock('./tab-mentions-source', () => ({
  clearMentionNeedles: vi.fn(),
  invalidateMentionNeedles: vi.fn(),
}));
vi.mock('./parse-cache', () => ({ clearReadmeCache: vi.fn(), invalidateReadmeCache: vi.fn() }));

beforeEach(async () => {
  vi.useFakeTimers();
  vi.mocked(applyIndexFsEvent).mockReset().mockResolvedValue(undefined);
  await setWatchedConception('/c', { deferIndexBuild: true });
  vi.mocked(safeSend).mockClear();
  vi.mocked(clearSearchIndex).mockClear();
});
afterEach(async () => {
  await setWatchedConception(null);
  vi.useRealTimers();
});
const emit = (path: string) => watchers.at(-1)!.callbacks.get('all')!('change', path);
const delivered = () =>
  vi
    .mocked(safeSend)
    .mock.calls.flatMap((call) => call[2] as import('../shared/types').TreeEvent[]);

it('retains exact pending note/task events across same-root configuration edits', async () => {
  emit('/c/projects/2026-10/one/notes/a.md');
  emit('/c/tasks/one/prompt.md');
  emit('/c/.condash/settings.json');
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(250);
  expect(delivered()).toContainEqual({
    kind: 'project',
    op: 'change',
    path: '/c/projects/2026-10/one/README.md',
    changedPath: '/c/projects/2026-10/one/notes/a.md',
  });
  expect(delivered()).toContainEqual({ kind: 'tasks' });
});

it('keeps the same watcher and search index alive across repeated configuration edits', async () => {
  const first = watchers.at(-1)!;
  const count = watchers.length;
  emit('/c/.condash/settings.json');
  emit('/c/.condash/settings.json');
  await vi.advanceTimersByTimeAsync(250);
  expect(first.close).not.toHaveBeenCalled();
  expect(watchers).toHaveLength(count);
  expect(clearSearchIndex).not.toHaveBeenCalled();
  expect(delivered().every((event) => event.kind === 'config')).toBe(true);
});

it('keeps receiving exact note/task callbacks delivered after a configuration batch', async () => {
  const first = watchers.at(-1)!;
  emit('/c/.condash/settings.json');
  await vi.advanceTimersByTimeAsync(250);
  first.callbacks.get('all')!('change', '/c/tasks/one/prompt.md');
  first.callbacks.get('all')!('change', '/c/projects/2026-10/one/notes/later.md');
  await vi.advanceTimersByTimeAsync(250);
  expect(first.close).not.toHaveBeenCalled();
  expect(delivered()).toContainEqual({ kind: 'tasks' });
  expect(delivered()).toContainEqual({
    kind: 'project',
    op: 'change',
    path: '/c/projects/2026-10/one/README.md',
    changedPath: '/c/projects/2026-10/one/notes/later.md',
  });
});

it('retains a captured held batch across configuration edits, with later batches ordered', async () => {
  let release!: () => void;
  vi.mocked(applyIndexFsEvent).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  emit('/c/projects/2026-10/one/notes/a.md');
  emit('/c/tasks/one/prompt.md');
  await vi.advanceTimersByTimeAsync(250);
  expect(safeSend).not.toHaveBeenCalled();
  emit('/c/.condash/settings.json');
  await vi.advanceTimersByTimeAsync(0);
  emit('/c/projects/2026-10/one/notes/b.md');
  await vi.advanceTimersByTimeAsync(250);
  expect(delivered().filter((event) => event.kind === 'project')).toEqual([]);
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(
    delivered()
      .filter((event) => event.kind === 'project')
      .map((event) => event.changedPath),
  ).toEqual(['/c/projects/2026-10/one/notes/a.md', '/c/projects/2026-10/one/notes/b.md']);
  expect(delivered()).toContainEqual({ kind: 'tasks' });
});

it('retains received exact/task events on the same-root error re-arm route', async () => {
  const first = watchers.at(-1)!;
  emit('/c/projects/2026-10/one/notes/error.md');
  emit('/c/tasks/one/prompt.md');
  first.callbacks.get('error')!(new Error('local watcher failure'));
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(250);
  expect(delivered()).toContainEqual({
    kind: 'project',
    op: 'change',
    path: '/c/projects/2026-10/one/README.md',
    changedPath: '/c/projects/2026-10/one/notes/error.md',
  });
  expect(delivered()).toContainEqual({ kind: 'tasks' });
});

it('a queued same-root re-arm cannot retarget itself to a genuinely new root', async () => {
  await setWatchedConception('/queued-repair', { deferIndexBuild: true });
  const before = watchers.length;
  watchers.at(-1)!.callbacks.get('error')!(new Error('queued watcher failure'));
  await setWatchedConception('/other', { deferIndexBuild: true });
  await vi.advanceTimersByTimeAsync(250);
  expect(watchers).toHaveLength(before + 1);
  expect(safeSend).not.toHaveBeenCalled();
});

it('a root departure during held re-arm close cannot attach or publish the old root', async () => {
  await setWatchedConception('/closing-repair', { deferIndexBuild: true });
  const first = watchers.at(-1)!;
  const before = watchers.length;
  let release!: () => void;
  first.close.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  emit('/closing-repair/projects/2026-10/one/notes/a.md');
  emit('/closing-repair/tasks/one/prompt.md');
  first.callbacks.get('error')!(new Error('held close watcher failure'));
  await vi.advanceTimersByTimeAsync(0);
  await setWatchedConception('/other', { deferIndexBuild: true });
  release();
  await vi.advanceTimersByTimeAsync(250);
  expect(watchers).toHaveLength(before + 1);
  expect(safeSend).not.toHaveBeenCalled();
});

it('waits for captured index completion and retains paths/tasks beside unknown', async () => {
  let release!: () => void;
  vi.mocked(applyIndexFsEvent).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  emit('/c/projects/2026-10/one/notes/a.md');
  emit('/c/tasks/one/prompt.md');
  emit('/c/knowledge/random.txt');
  emit('/c/projects/2026-10/one/notes/b.md');
  await vi.advanceTimersByTimeAsync(250);
  expect(safeSend).not.toHaveBeenCalled();
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.mocked(safeSend).mock.calls[0][2]).toEqual([
    {
      kind: 'project',
      op: 'change',
      path: '/c/projects/2026-10/one/README.md',
      changedPath: '/c/projects/2026-10/one/notes/a.md',
    },
    { kind: 'tasks' },
    {
      kind: 'project',
      op: 'change',
      path: '/c/projects/2026-10/one/README.md',
      changedPath: '/c/projects/2026-10/one/notes/b.md',
    },
    { kind: 'unknown' },
  ]);
});
it('serializes batches and drops publication when the root departs', async () => {
  let release!: () => void;
  vi.mocked(applyIndexFsEvent).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  emit('/c/knowledge/one.md');
  await vi.advanceTimersByTimeAsync(250);
  emit('/c/knowledge/two.md');
  await vi.advanceTimersByTimeAsync(250);
  expect(safeSend).not.toHaveBeenCalled();
  await setWatchedConception('/other', { deferIndexBuild: true });
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(safeSend).not.toHaveBeenCalled();
});
it('clears failed incremental RAM before publishing, but not a replacement root', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.mocked(applyIndexFsEvent).mockRejectedValueOnce(new Error('index failure'));
  emit('/c/knowledge/one.md');
  await vi.advanceTimersByTimeAsync(250);
  expect(clearSearchIndex).toHaveBeenCalledTimes(1);
  expect(safeSend).toHaveBeenCalledTimes(1);
  let reject!: (error: Error) => void;
  vi.mocked(applyIndexFsEvent).mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  emit('/c/knowledge/two.md');
  await setWatchedConception('/other', { deferIndexBuild: true });
  vi.mocked(clearSearchIndex).mockClear();
  reject(new Error('departed failure'));
  await vi.advanceTimersByTimeAsync(250);
  expect(clearSearchIndex).not.toHaveBeenCalled();
  error.mockRestore();
});
