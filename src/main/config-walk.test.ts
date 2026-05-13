import { describe, expect, it } from 'vitest';
import {
  isSectionMarker,
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
