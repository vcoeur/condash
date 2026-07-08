/**
 * Unit tests for `rootRepoFromApp` — the implicit-mode resolver that maps
 * an `apps:` entry from a project README to the canonical repo name in
 * `condash.json`. Apps may carry the conception's `#` display prefix and/or
 * an inner sub-path (`condash/frontend`); the worktree is always at the
 * top-level repo, so both layers are stripped.
 */
import { describe, expect, it } from 'vitest';
import {
  repoLookupMap,
  resolveAppRepo,
  rootRepoFromApp,
  isLongLivedBranch,
  type ConfigWithPaths,
} from './shared';

describe('rootRepoFromApp', () => {
  it('returns the bare name when already canonical', () => {
    expect(rootRepoFromApp('condash')).toBe('condash');
    expect(rootRepoFromApp('vcoeur.com')).toBe('vcoeur.com');
  });

  it('strips the leading `#` display prefix', () => {
    expect(rootRepoFromApp('#condash')).toBe('condash');
    expect(rootRepoFromApp('#vcoeur.com')).toBe('vcoeur.com');
  });

  it('strips inner sub-paths', () => {
    expect(rootRepoFromApp('condash/frontend')).toBe('condash');
    expect(rootRepoFromApp('alicepeintures.com/admin')).toBe('alicepeintures.com');
  });

  it('strips both `#` and sub-path together', () => {
    expect(rootRepoFromApp('#condash/frontend')).toBe('condash');
  });
});

describe('repoLookupMap + resolveAppRepo (handle/alias resolution)', () => {
  // A repo whose `#handle` (`vcoeur`) differs from its directory name
  // (`vcoeur.com`) — the only shape that breaks a name-only lookup.
  const config: ConfigWithPaths = {
    workspace_path: '/ws',
    repositories: [
      { handle: 'vcoeur', path: 'vcoeur.com', aliases: ['vcoeur.com'] },
      { name: 'condash' },
      // Collision: this repo's handle equals the *name* of the next repo.
      { handle: 'foo', name: 'bar' },
      { name: 'foo' },
    ],
  };

  it('indexes a repo by directory name, handle, and alias', () => {
    const map = repoLookupMap(config);
    expect(map.get('vcoeur.com')?.name).toBe('vcoeur.com'); // directory name
    expect(map.get('vcoeur')?.name).toBe('vcoeur.com'); // #handle
  });

  it('resolves a `#handle` token to the canonical directory name', () => {
    const map = repoLookupMap(config);
    expect(resolveAppRepo('#vcoeur', map)?.name).toBe('vcoeur.com');
    expect(resolveAppRepo('vcoeur', map)?.name).toBe('vcoeur.com');
  });

  it('resolves a directory-name or alias token too', () => {
    const map = repoLookupMap(config);
    expect(resolveAppRepo('#vcoeur.com', map)?.name).toBe('vcoeur.com');
    expect(resolveAppRepo('vcoeur.com', map)?.name).toBe('vcoeur.com');
    expect(resolveAppRepo('#condash', map)?.name).toBe('condash');
  });

  it('lets a real directory name win over another repo handle on collision', () => {
    const map = repoLookupMap(config);
    expect(resolveAppRepo('foo', map)?.name).toBe('foo');
  });

  it('returns null for a token that names no configured repo', () => {
    const map = repoLookupMap(config);
    expect(resolveAppRepo('#nope', map)).toBeNull();
  });
});

describe('isLongLivedBranch + matchBranchGlob', () => {
  it('defaults to protecting main and master', () => {
    expect(isLongLivedBranch('main', undefined).longLived).toBe(true);
    expect(isLongLivedBranch('master', undefined).longLived).toBe(true);
    expect(isLongLivedBranch('feature-xyz', undefined).longLived).toBe(false);
  });

  it('supports glob patterns', () => {
    const patterns = ['preprod', 'release/*', 'hotfix-?'];
    expect(isLongLivedBranch('preprod', patterns).longLived).toBe(true);
    expect(isLongLivedBranch('release/1.0', patterns).longLived).toBe(true);
    expect(isLongLivedBranch('hotfix-a', patterns).longLived).toBe(true);
    expect(isLongLivedBranch('hotfix-ab', patterns).longLived).toBe(false);
    expect(isLongLivedBranch('release', patterns).longLived).toBe(false);
    expect(isLongLivedBranch('feature-xyz', patterns).longLived).toBe(false);
  });

  it('treats literal characters in branch names as literals', () => {
    const patterns = ['release/1.0'];
    expect(isLongLivedBranch('release/1.0', patterns).longLived).toBe(true);
    expect(isLongLivedBranch('releaseX1.0', patterns).longLived).toBe(false);
  });

  it('reports the matched pattern', () => {
    const result = isLongLivedBranch('release/2.0', ['main', 'release/*']);
    expect(result.longLived).toBe(true);
    expect(result.matched).toBe('release/*');
  });
});
