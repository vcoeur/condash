import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exec } from '../exec';
import { regenerateIndex } from '../index-tree';
import { projectsStrategy } from '../index-projects';
import { knowledgeStrategy } from '../index-knowledge';
import { writeProjectReadme } from '../../cli/commands/test-helpers';
import { safeMerge } from './safe-merge';
import { syncCommit, syncRun } from './run';

vi.mock('../exec', async (original) => {
  const actual = await original<typeof import('../exec')>();
  return { ...actual, exec: vi.fn(actual.exec) };
});

let savedGlobal: string | undefined;
let savedSystem: string | undefined;
beforeAll(() => {
  savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  savedSystem = process.env.GIT_CONFIG_SYSTEM;
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
});
afterAll(() => {
  if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
  if (savedSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
  else process.env.GIT_CONFIG_SYSTEM = savedSystem;
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd })).stdout.trim();
}
async function write(root: string, path: string, text: string): Promise<void> {
  const target = join(root, path);
  await fs.mkdir(join(target, '..'), { recursive: true });
  await fs.writeFile(target, text);
}
async function commit(root: string): Promise<string> {
  await git(root, 'add', '-A');
  await git(root, 'commit', '-qm', 'fixture change');
  return git(root, 'rev-parse', 'HEAD');
}
async function regenerate(root: string): Promise<void> {
  await regenerateIndex(root, projectsStrategy);
  await regenerateIndex(root, knowledgeStrategy);
}

describe('safe merge against a bare remote and two clones', () => {
  let scratch: string;
  let local: string;
  let remoteClone: string;
  let bare: string;
  const nestedIndex = 'knowledge/topics/deep/index.md';
  const monthIndex = 'projects/2026-07/index.md';
  beforeEach(async () => {
    scratch = await fs.mkdtemp(join(tmpdir(), 'condash-safe-test-'));
    local = join(scratch, 'local');
    remoteClone = join(scratch, 'second');
    bare = join(scratch, 'remote.git');
    await fs.mkdir(local);
    await git(local, 'init', '-qb', 'main');
    await git(local, 'config', 'user.name', 'Fixture');
    await git(local, 'config', 'user.email', 'fixture@example.com');
    await write(
      local,
      '.gitignore',
      'projects/.index-dirty\nknowledge/.index-dirty\nignored.txt\n',
    );
    await writeProjectReadme(local, 'alpha', {
      date: '2026-07-10',
      kind: 'project',
      status: 'now',
      apps: ['condash'],
    });
    await write(local, 'knowledge/topics/deep/base.md', '# Base\n\nBase reference.\n');
    await regenerate(local);
    // A curated row provides a preservation assertion distinct from the draft rows.
    const raw = await fs.readFile(join(local, nestedIndex), 'utf8');
    await write(local, nestedIndex, raw.replace(' <!-- draft -->', ''));
    await commit(local);
    await git(scratch, 'init', '--bare', '-qb', 'main', bare);
    await git(local, 'remote', 'add', 'origin', bare);
    await git(local, 'push', '-qu', 'origin', 'main');
    await git(scratch, 'clone', '-q', bare, remoteClone);
    await git(remoteClone, 'config', 'user.name', 'Fixture');
    await git(remoteClone, 'config', 'user.email', 'fixture@example.com');
  });
  afterEach(async () => {
    vi.mocked(exec).mockRestore();
    await fs.rm(scratch, { recursive: true, force: true });
  });

  async function diverge(): Promise<[string, string]> {
    await writeProjectReadme(local, 'local', {
      date: '2026-07-11',
      kind: 'project',
      status: 'now',
      apps: ['condash'],
    });
    await writeProjectReadme(remoteClone, 'remote', {
      date: '2026-07-12',
      kind: 'project',
      status: 'review',
      apps: ['condash'],
    });
    await write(local, 'knowledge/topics/deep/local.md', '# Local\n\nLocal reference.\n');
    await write(remoteClone, 'knowledge/topics/deep/remote.md', '# Remote\n\nRemote reference.\n');
    await regenerate(local);
    await regenerate(remoteClone);
    const index = await fs.readFile(join(remoteClone, nestedIndex), 'utf8');
    await write(
      remoteClone,
      nestedIndex,
      index
        .replace('*Base reference.*', '*Remote curated reference.*')
        .replace('# ', 'Remote introduction.\n\n# '),
    );
    const localTip = await commit(local);
    const remoteTip = await commit(remoteClone);
    await git(remoteClone, 'push', '-q');
    await git(local, 'fetch', '-q');
    return [localTip, remoteTip];
  }

  it('joins zero-conflict divergence with two parents and ordinary push', async () => {
    await write(local, 'local.txt', 'local\n');
    await write(remoteClone, 'remote.txt', 'remote\n');
    const localTip = await commit(local);
    const remoteTip = await commit(remoteClone);
    await git(remoteClone, 'push', '-q');
    const report = await syncRun(local, {
      dryRun: false,
      push: true,
      quietPeriodSeconds: 90,
      integration: 'safe-merge',
    });
    expect(report.integrateError).toBeNull();
    expect(report.pushed).toBe(true);
    expect((await git(local, 'show', '-s', '--format=%P', 'HEAD')).split(' ')).toEqual([
      localTip,
      remoteTip,
    ]);
    expect(await git(bare, 'rev-parse', 'main')).toBe(await git(local, 'rev-parse', 'HEAD'));
  });

  it('regenerates month and nested knowledge conflicts and retains clean remote prose/curation', async () => {
    const tips = await diverge();
    const report = await syncRun(local, {
      dryRun: false,
      push: true,
      quietPeriodSeconds: 90,
      integration: 'safe-merge',
    });
    expect(report.integrateError).toBeNull();
    expect(report.diverged).toBe(false);
    expect(report.pushed).toBe(true);
    expect((await git(local, 'show', '-s', '--format=%P', 'HEAD')).split(' ')).toEqual(tips);
    for (const tip of tips) await git(local, 'merge-base', '--is-ancestor', tip, 'HEAD');
    const month = await fs.readFile(join(local, monthIndex), 'utf8');
    expect(month).toContain('2026-07-11-local/README.md');
    expect(month).toContain('2026-07-12-remote/README.md');
    const knowledge = await fs.readFile(join(local, nestedIndex), 'utf8');
    expect(knowledge).toContain('(local.md)');
    expect(knowledge).toContain('(remote.md)');
    expect(knowledge).toContain('Remote introduction.');
    expect(knowledge).toContain('*Remote curated reference.*');
    expect(
      vi.mocked(exec).mock.calls.filter(([, args]) => args[0] === 'merge-file').length,
    ).toBeGreaterThanOrEqual(2);
    expect(await git(local, 'status', '--porcelain')).toBe('');
  });

  it.each(['local', 'remote', 'both', 'body-comments'])(
    'refuses conflicting annotated drafted rows (%s), preserving original commits/tree/index',
    async (annotationSide) => {
      const initial = '# Deep\n\n- [`base.md`](base.md) — *Base reference.* <!-- draft -->\n';
      await write(local, nestedIndex, initial);
      await commit(local);
      await git(local, 'push', '-q');
      await git(remoteClone, 'pull', '--ff-only');
      for (const [root, side] of [
        [local, 'local'],
        [remoteClone, 'remote'],
      ] as const) {
        const annotated =
          annotationSide === side ||
          annotationSide === 'both' ||
          annotationSide === 'body-comments';
        const comment = annotated ? `<!-- ${side} human annotation -->` : '';
        const row =
          annotationSide === 'body-comments'
            ? `- [\`base.md\`](base.md) — *${side} ${comment} description.* <!-- draft -->`
            : `- [\`base.md\`](base.md) — *${side} description.* ${comment} <!-- draft -->`;
        await write(root, nestedIndex, '# Deep\n\n' + row + '\n');
      }
      const localTip = await commit(local);
      const remoteTip = await commit(remoteClone);
      await git(remoteClone, 'push', '-q');
      await git(local, 'fetch', '-q');
      const originalIndex = await fs.readFile(join(local, nestedIndex), 'utf8');
      const tree = await git(local, 'write-tree');
      await expect(safeMerge(local)).rejects.toThrow(
        /prose or curated-row conflict|changes human content/,
      );
      expect(await git(local, 'rev-parse', 'HEAD')).toBe(localTip);
      expect(await git(local, 'write-tree')).toBe(tree);
      expect(await fs.readFile(join(local, nestedIndex), 'utf8')).toBe(originalIndex);
      expect(await git(local, 'status', '--porcelain')).toBe('');
      expect(await git(bare, 'rev-parse', 'main')).toBe(remoteTip);
      for (const [tip, side] of [
        [localTip, 'local'],
        [remoteTip, 'remote'],
      ] as const) {
        if (
          annotationSide === side ||
          annotationSide === 'both' ||
          annotationSide === 'body-comments'
        ) {
          expect(await git(local, 'show', `${tip}:${nestedIndex}`)).toContain(
            `<!-- ${side} human annotation -->`,
          );
        }
      }
    },
  );

  it.each(['trailing', 'body'])(
    'refuses regeneration that would lose a clean remote %s annotation alongside generated conflicts',
    async (position) => {
      await diverge();
      const original = await fs.readFile(join(remoteClone, nestedIndex), 'utf8');
      const comment = '<!-- clean remote human annotation -->';
      const annotated = original
        .split('\n')
        .map((line) =>
          line.includes('(remote.md)')
            ? position === 'trailing'
              ? line.replace(' <!-- draft -->', ` ${comment} <!-- draft -->`)
              : line.replace('*Remote reference.*', `*Remote ${comment} reference.*`)
            : line,
        )
        .join('\n');
      expect(annotated).toContain(comment);
      await write(remoteClone, nestedIndex, annotated);
      const remoteTip = await commit(remoteClone);
      await git(remoteClone, 'push', '-q');
      await git(local, 'fetch', '-q');
      const head = await git(local, 'rev-parse', 'HEAD');
      const tree = await git(local, 'write-tree');
      const before = await fs.readFile(join(local, nestedIndex), 'utf8');
      await expect(safeMerge(local)).rejects.toThrow('regeneration that changes human content');
      expect(vi.mocked(exec).mock.calls.some(([, args]) => args[0] === 'merge-file')).toBe(true);
      expect(await git(local, 'rev-parse', 'HEAD')).toBe(head);
      expect(await git(local, 'write-tree')).toBe(tree);
      expect(await fs.readFile(join(local, nestedIndex), 'utf8')).toBe(before);
      expect(await git(local, 'status', '--porcelain')).toBe('');
      expect(await git(local, 'show', `${remoteTip}:${nestedIndex}`)).toContain(comment);
      expect(await git(bare, 'rev-parse', 'main')).toBe(remoteTip);
    },
  );

  it('retains a clean remote annotation after the draft marker when regeneration can preserve it', async () => {
    await diverge();
    const original = await fs.readFile(join(remoteClone, nestedIndex), 'utf8');
    const row = original.split('\n').find((line) => line.includes('(remote.md)'))!;
    const annotated = row + ' <!-- keep clean remote annotation -->';
    await write(remoteClone, nestedIndex, original.replace(row, annotated));
    const remoteTip = await commit(remoteClone);
    await git(remoteClone, 'push', '-q');
    await git(local, 'fetch', '-q');
    const localTip = await git(local, 'rev-parse', 'HEAD');
    await safeMerge(local);
    const merged = await fs.readFile(join(local, nestedIndex), 'utf8');
    expect(merged.split('\n')).toContain(annotated);
    expect(merged).toContain('(local.md)');
    expect(merged).toContain('(remote.md)');
    expect((await git(local, 'show', '-s', '--format=%P', 'HEAD')).split(' ')).toEqual([
      localTip,
      remoteTip,
    ]);
    await git(local, 'push', '-q');
    expect(await git(bare, 'rev-parse', 'main')).toBe(await git(local, 'rev-parse', 'HEAD'));
  });

  it.each([
    'prose',
    'curated',
    'README',
    'item-index',
    'delete',
    'rename',
    'symlink',
    'executable',
    'directory',
  ])('refuses %s conflicts without changing the original tips/tree/index', async (kind) => {
    const path =
      kind === 'README'
        ? 'projects/2026-07/2026-07-10-alpha/README.md'
        : kind === 'item-index'
          ? 'projects/2026-07/2026-07-10-alpha/index.md'
          : nestedIndex;
    if (kind === 'item-index') {
      await write(local, path, 'base\n');
      await commit(local);
      await git(local, 'push', '-q');
      await git(remoteClone, 'pull', '--ff-only');
    }
    const base = await fs.readFile(join(local, path), 'utf8');
    if (kind === 'delete') await fs.unlink(join(local, path));
    else if (kind === 'rename') await git(local, 'mv', path, 'knowledge/topics/deep/renamed.md');
    else if (kind === 'symlink') {
      await fs.unlink(join(local, path));
      await fs.symlink('base.md', join(local, path));
    } else if (kind === 'directory') {
      await fs.unlink(join(local, path));
      await write(local, path + '/body.md', '# Replaced by a directory\n');
    } else {
      await write(
        local,
        path,
        kind === 'curated'
          ? base.replace('Base reference', 'Local curated')
          : `Local prose\n${base}`,
      );
      if (kind === 'executable') await fs.chmod(join(local, path), 0o755);
    }
    await write(
      remoteClone,
      path,
      kind === 'curated'
        ? base.replace('Base reference', 'Remote curated')
        : `Remote prose\n${base}`,
    );
    const localTip = await commit(local);
    await commit(remoteClone);
    await git(remoteClone, 'push', '-q');
    await git(local, 'fetch', '-q');
    const tree = await git(local, 'write-tree');
    await expect(safeMerge(local)).rejects.toThrow(/refuses|refused/);
    expect(await git(local, 'rev-parse', 'HEAD')).toBe(localTip);
    expect(await git(local, 'write-tree')).toBe(tree);
    expect(await git(local, 'status', '--porcelain')).toBe('');
  });

  it.each([
    'dirty',
    'staged',
    'partially-staged',
    'assume-unchanged',
    'skip-worktree',
    'untracked',
    'ignored',
  ])('preserves %s user obstruction', async (kind) => {
    await diverge();
    const target =
      kind === 'ignored' ? 'ignored.txt' : kind === 'untracked' ? 'new.txt' : nestedIndex;
    const bytes = 'user work, never discard\n';
    await write(local, target, bytes);
    if (kind === 'partially-staged') {
      await write(local, target, 'original staged bytes\n');
      await git(local, 'add', target);
      await write(local, target, bytes);
    } else if (kind === 'staged') await git(local, 'add', target);
    if (kind === 'assume-unchanged' || kind === 'skip-worktree') {
      await git(local, 'update-index', `--${kind}`, target);
    }
    if (kind === 'ignored') {
      await write(remoteClone, target, 'remote tracked\n');
      await git(remoteClone, 'add', '-f', target);
      await git(remoteClone, 'commit', '-qm', 'tracked obstruction');
      await git(remoteClone, 'push', '-q');
      await git(local, 'fetch', '-q');
    }
    const head = await git(local, 'rev-parse', 'HEAD');
    const tree = await git(local, 'write-tree');
    const status = await git(local, 'status', '--porcelain');
    await expect(safeMerge(local)).rejects.toThrow();
    expect(await fs.readFile(join(local, target), 'utf8')).toBe(bytes);
    expect(await git(local, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git(local, 'write-tree')).toBe(tree);
    expect(await git(local, 'status', '--porcelain')).toBe(status);
  });

  it('invalidates preflight when user work appears during object import', async () => {
    await diverge();
    const real = (await vi.importActual<typeof import('../exec')>('../exec')).exec;
    vi.mocked(exec).mockImplementation(async (file, args, options) => {
      const result = await real(file, args, options);
      if (options?.cwd === local && args.includes('--no-write-fetch-head')) {
        await write(local, 'user-race.txt', 'concurrent user\n');
      }
      return result;
    });
    const head = await git(local, 'rev-parse', 'HEAD');
    await expect(safeMerge(local)).rejects.toThrow(/clean working tree/);
    expect(await git(local, 'rev-parse', 'HEAD')).toBe(head);
    expect(await fs.readFile(join(local, 'user-race.txt'), 'utf8')).toBe('concurrent user\n');
  });

  it.each(['HEAD', 'upstream', 'operation'])(
    'invalidates preflight when %s changes during import',
    async (kind) => {
      await diverge();
      const real = (await vi.importActual<typeof import('../exec')>('../exec')).exec;
      const head = await git(local, 'rev-parse', 'HEAD');
      let updatedHead = head;
      vi.mocked(exec).mockImplementation(async (file, args, options) => {
        const result = await real(file, args, options);
        if (options?.cwd === local && args.includes('--no-write-fetch-head')) {
          if (kind === 'HEAD') {
            await real('git', ['commit', '--allow-empty', '-qm', 'concurrent user commit'], {
              cwd: local,
            });
            updatedHead = (await real('git', ['rev-parse', 'HEAD'], { cwd: local })).stdout.trim();
          } else if (kind === 'upstream') {
            await real('git', ['update-ref', 'refs/remotes/origin/main', head], { cwd: local });
          } else await fs.writeFile(join(local, '.git/MERGE_HEAD'), head + '\n');
        }
        return result;
      });
      await expect(safeMerge(local)).rejects.toThrow(/invalidated|operation is in progress/);
      expect(await git(local, 'rev-parse', 'HEAD')).toBe(updatedHead);
      expect(await git(local, 'status', '--porcelain')).toBe('');
    },
  );

  it('refuses unsupported Git without attempting recovery', async () => {
    await diverge();
    const real = (await vi.importActual<typeof import('../exec')>('../exec')).exec;
    vi.mocked(exec).mockImplementation((file, args, options) =>
      args[0] === '--version'
        ? Promise.resolve({ stdout: 'git version 2.28.0\n', stderr: '' })
        : real(file, args, options),
    );
    const head = await git(local, 'rev-parse', 'HEAD');
    await expect(safeMerge(local)).rejects.toThrow('Git 2.29 or newer');
    expect(await git(local, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('refuses non-text merge attributes rather than union-merging human conflicts', async () => {
    await diverge();
    await write(remoteClone, '.gitattributes', '*.md merge=union\n');
    await commit(remoteClone);
    await git(remoteClone, 'push', '-q');
    await git(local, 'fetch', '-q');
    await expect(safeMerge(local)).rejects.toThrow('non-text merge attributes');
  });

  it.each(['dry-run', 'no-push', 'off', 'ff-only', 'no-upstream'])(
    'preserves the %s no-recovery contract',
    async (contract) => {
      await diverge();
      if (contract === 'no-upstream') await git(local, 'branch', '--unset-upstream');
      const head = await git(local, 'rev-parse', 'HEAD');
      const report = await syncRun(local, {
        dryRun: contract === 'dry-run',
        push: contract !== 'no-push',
        quietPeriodSeconds: 90,
        integration: contract === 'off' ? 'off' : contract === 'ff-only' ? 'ff-only' : 'safe-merge',
      });
      expect(await git(local, 'rev-parse', 'HEAD')).toBe(head);
      expect(report.pushed).toBe(false);
      expect(
        vi.mocked(exec).mock.calls.some(([, args]) => args.includes('--no-write-fetch-head')),
      ).toBe(false);
      if (contract === 'ff-only') expect(report.diverged).toBe(true);
    },
  );

  it('reports the waiting count after locally committed settled work, not before', async () => {
    await diverge();
    await write(local, 'settled.txt', 'settled local work\n');
    const when = new Date(Date.now() - 3600_000);
    await fs.utimes(join(local, 'settled.txt'), when, when);
    const report = await syncRun(local, {
      dryRun: false,
      push: true,
      quietPeriodSeconds: 90,
      integration: 'safe-merge',
    });
    expect(report.diverged).toBe(true);
    expect(report.commits.length).toBe(1);
    expect(report.ahead).toBe(2);
    expect(await git(local, 'rev-list', '--count', '@{upstream}..HEAD')).toBe('2');
  });

  it('keeps quiet-period work untouched while refusing dirty-checkout recovery', async () => {
    await diverge();
    await write(local, 'warm.txt', 'mid-write\n');
    const head = await git(local, 'rev-parse', 'HEAD');
    const report = await syncRun(local, {
      dryRun: false,
      push: true,
      quietPeriodSeconds: 3600,
      integration: 'safe-merge',
    });
    expect(report.skipped).toContainEqual({ path: 'warm.txt', reason: 'quiet-period' });
    expect(report.commits).toEqual([]);
    expect(await git(local, 'rev-parse', 'HEAD')).toBe(head);
    expect(await fs.readFile(join(local, 'warm.txt'), 'utf8')).toBe('mid-write\n');
  });

  it('retains a recovered merge after a second real push race and retries next sweep', async () => {
    await diverge();
    const real = (await vi.importActual<typeof import('../exec')>('../exec')).exec;
    let race = true;
    vi.mocked(exec).mockImplementation(async (file, args, options) => {
      if (race && options?.cwd === local && args[0] === 'push') {
        race = false;
        await write(remoteClone, 'raced.txt', 'second remote push\n');
        await real('git', ['add', '-A'], { cwd: remoteClone });
        await real('git', ['commit', '-qm', 'second push race'], { cwd: remoteClone });
        await real('git', ['push', '-q'], { cwd: remoteClone });
      }
      return real(file, args, options);
    });
    const first = await syncRun(local, {
      dryRun: false,
      push: true,
      quietPeriodSeconds: 90,
      integration: 'safe-merge',
    });
    expect(first.pushError).toBeTruthy();
    const retained = await git(local, 'rev-parse', 'HEAD');
    const second = await syncRun(local, {
      dryRun: false,
      push: true,
      quietPeriodSeconds: 90,
      integration: 'safe-merge',
    });
    expect(second.pushed).toBe(true);
    await git(local, 'merge-base', '--is-ancestor', retained, 'HEAD');
  });

  it('syncCommit retains item-only scope while safe recovery waits for dirty work', async () => {
    await diverge();
    const item = 'projects/2026-07/2026-07-10-alpha';
    await write(local, item + '/notes/01-change.md', 'item milestone\n');
    await write(local, 'foreign.txt', 'foreign staged\n');
    await git(local, 'add', 'foreign.txt');
    const report = await syncCommit(local, item, 'Milestone fixture', {
      dryRun: false,
      push: true,
      integration: 'safe-merge',
    });
    expect(report.commits[0].paths).toEqual([item + '/notes/01-change.md']);
    expect(report.diverged).toBe(true);
    expect(await git(local, 'diff', '--cached', '--name-only')).toBe('foreign.txt');
    expect(report.ahead).toBe(2);
  });

  it('cleans its disposable repository after a real Git preflight refusal', async () => {
    await diverge();
    const real = (await vi.importActual<typeof import('../exec')>('../exec')).exec;
    let disposable = '';
    vi.mocked(exec).mockImplementation(async (file, args, options) => {
      if (args[0] === 'init' && options?.cwd !== local) disposable = String(options?.cwd);
      if (args[0] === 'merge' && args.includes('--no-commit')) {
        return real(file, ['merge', '--no-commit', 'missing-fixture-ref'], options);
      }
      return real(file, args, options);
    });
    const head = await git(local, 'rev-parse', 'HEAD');
    await expect(safeMerge(local)).rejects.toThrow();
    expect(disposable).toContain('condash-safe-merge-');
    await expect(fs.stat(join(disposable, '..'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await git(local, 'rev-parse', 'HEAD')).toBe(head);
  });
});
