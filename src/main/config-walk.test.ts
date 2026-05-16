import { describe, expect, it } from 'vitest';
import {
  isSectionMarker,
  resolveCwd,
  walkRepos,
  type ConfigShape,
  type RawRepo,
  type RepoLookup,
} from './config-walk';

function collect(config: ConfigShape): RepoLookup[] {
  const out: RepoLookup[] = [];
  walkRepos(config, (e) => {
    out.push(e);
  });
  return out;
}

describe('walkRepos sections', () => {
  it('threads the current section through every emitted entry', () => {
    const config: ConfigShape = {
      workspace_path: '/ws',
      repositories: [
        { section: 'Sites' },
        { name: 'alicepeintures.com' },
        'vcoeur.com',
        { section: 'Tools' },
        { name: 'condash', submodules: ['frontend'] },
      ],
    };
    const flat = collect(config);
    expect(flat.map((e) => e.display)).toEqual([
      'alicepeintures.com',
      'vcoeur.com',
      'condash',
      'condash/frontend',
    ]);
    expect(flat.map((e) => e.section)).toEqual(['Sites', 'Sites', 'Tools', 'Tools']);
  });

  it('leaves `section` undefined for repos that precede the first marker', () => {
    const config: ConfigShape = {
      repositories: ['standalone', { section: 'Later' }, 'grouped'],
    };
    const flat = collect(config);
    expect(flat.map((e) => [e.display, e.section])).toEqual([
      ['standalone', undefined],
      ['grouped', 'Later'],
    ]);
  });

  it('emits nothing for a config without any repos at all', () => {
    expect(collect({})).toEqual([]);
    expect(collect({ repositories: [] })).toEqual([]);
  });

  it('treats consecutive markers by adopting the latest section', () => {
    const config: ConfigShape = {
      repositories: [{ section: 'First' }, { section: 'Second' }, 'only'],
    };
    const flat = collect(config);
    expect(flat).toHaveLength(1);
    expect(flat[0].section).toBe('Second');
  });
});

describe('resolveCwd', () => {
  it('joins workspace + name when no explicit path is given', () => {
    expect(resolveCwd('/ws', undefined, 'foo')).toBe('/ws/foo');
  });

  it('returns an absolute name unchanged', () => {
    expect(resolveCwd('/ws', undefined, '/abs/foo')).toBe('/abs/foo');
  });

  it('returns an absolute explicit path unchanged, ignoring workspace and name', () => {
    expect(resolveCwd('/ws', undefined, 'display-only', '/mnt/backup/foo')).toBe('/mnt/backup/foo');
  });

  it('resolves a relative explicit path under workspace_path', () => {
    expect(resolveCwd('/ws', undefined, 'display', 'custom/foo')).toBe('/ws/custom/foo');
  });

  it('resolves a relative explicit path under <workspace>/<parent> for submodules', () => {
    expect(resolveCwd('/ws', 'mono', 'display', 'pkg/sub')).toBe('/ws/mono/pkg/sub');
  });

  it('falls back to name as the path when explicit path is undefined', () => {
    expect(resolveCwd('/ws', 'mono', 'sub')).toBe('/ws/mono/sub');
  });

  it('handles a missing workspace by returning name relative to root', () => {
    expect(resolveCwd(undefined, undefined, 'foo')).toBe('foo');
  });
});

describe('walkRepos with explicit path', () => {
  it('threads `entry.path` through to `cwd`', () => {
    const config: ConfigShape = {
      workspace_path: '/ws',
      repositories: [
        { name: 'display-name', path: '/mnt/backup/elsewhere' },
        { name: 'rel', path: 'custom/loc' },
      ],
    };
    const flat = collect(config);
    expect(flat.map((e) => [e.display, e.cwd])).toEqual([
      ['display-name', '/mnt/backup/elsewhere'],
      ['rel', '/ws/custom/loc'],
    ]);
  });
});

describe('isSectionMarker', () => {
  it('discriminates section markers from repo objects and strings', () => {
    const marker: RawRepo = { section: 'Sites' };
    const repo: RawRepo = { name: 'condash' };
    const bare: RawRepo = 'standalone';
    expect(isSectionMarker(marker)).toBe(true);
    expect(isSectionMarker(repo)).toBe(false);
    expect(isSectionMarker(bare)).toBe(false);
  });
});
