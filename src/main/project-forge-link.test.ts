import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec } from './exec';
import { buildProjectForgeLink, getProjectForgeLink } from './project-forge-link';

const directory = 'projects/2026-10/2026-10-26-example';

describe('project forge links', () => {
  it.each([
    ['git@github.com:owner/repo.git', 'https://github.com/owner/repo/tree/feature%2Flinks/'],
    ['https://github.com/owner/repo', 'https://github.com/owner/repo/tree/feature%2Flinks/'],
    [
      'ssh://git@gitlab.com/group/nested/repo.git',
      'https://gitlab.com/group/nested/repo/-/tree/feature%2Flinks/',
    ],
    [
      'https://gitlab.com/group/nested/repo.git/',
      'https://gitlab.com/group/nested/repo/-/tree/feature%2Flinks/',
    ],
  ])('normalizes %s', (remote, prefix) => {
    expect(buildProjectForgeLink(remote, 'feature/links', directory)).toBe(prefix + directory);
  });

  it.each([
    '',
    'https://selfhost.example/group/repo',
    'file:///repo',
    'https://github.com/owner',
    'https://github.com/a/b?token=secret',
    'ssh://git@github.com:2222/a/b',
    'https://github.com/a/%2F',
  ])('rejects unsupported remote %s', (remote) => {
    expect(buildProjectForgeLink(remote, 'main', directory)).toBeNull();
  });

  it('encodes repository, branch and path safely', () => {
    expect(
      buildProjectForgeLink(
        'https://gitlab.com/a/repo%20name.git',
        'topic/#hash',
        'projects/a b/item#1',
      ),
    ).toBe('https://gitlab.com/a/repo%20name/-/tree/topic%2F%23hash/projects/a%20b/item%231');
  });

  it('reads the conception branch, hides absent origins and detached HEAD, and rejects escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'condash-forge-unit-'));
    const git = (...args: string[]) => exec('git', ['-C', root, ...args]);
    await git('init', '-b', 'conception/topic');
    await git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    );
    const item = join(root, directory);
    await mkdir(item, { recursive: true });
    const readme = join(item, 'README.md');
    await writeFile(readme, '---\nbranch: unrelated-code-branch\n---\n');
    expect(await getProjectForgeLink(root, readme)).toBeNull();
    await git('remote', 'add', 'origin', 'git@github.com:owner/repo.git');
    expect(await getProjectForgeLink(root, readme)).toBe(
      `https://github.com/owner/repo/tree/conception%2Ftopic/${directory}`,
    );
    await git('tag', 'conception/topic');
    expect((await git('symbolic-ref', '--quiet', '--short', 'HEAD')).stdout.trim()).toBe(
      'heads/conception/topic',
    );
    expect(await getProjectForgeLink(root, readme)).toBe(
      `https://github.com/owner/repo/tree/conception%2Ftopic/${directory}`,
    );
    await git('checkout', '--detach');
    expect(await getProjectForgeLink(root, readme)).toBeNull();
    const outside = await mkdtemp(join(tmpdir(), 'condash-forge-outside-'));
    await writeFile(join(outside, 'README.md'), 'outside');
    await symlink(outside, join(root, 'escape'));
    await expect(getProjectForgeLink(root, join(root, 'escape', 'README.md'))).rejects.toThrow();
  });
});
