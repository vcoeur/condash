/**
 * Unit tests for `rootRepoFromApp` — the implicit-mode resolver that maps
 * an `apps:` entry from a project README to the canonical repo name in
 * `condash.json`. Apps may carry the conception's `@` display prefix and/or
 * an inner sub-path (`condash/frontend`); the worktree is always at the
 * top-level repo, so both layers are stripped.
 */
import { describe, expect, it } from 'vitest';
import { rootRepoFromApp } from './shared';

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
