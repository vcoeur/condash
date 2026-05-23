import { describe, expect, it } from 'vitest';
import { isIgnoredSourceArtifact } from './source-artifacts';

describe('isIgnoredSourceArtifact', () => {
  it('flags dpkg conffile residue', () => {
    for (const name of [
      'body.md.dpkg-new',
      'body.md.dpkg-tmp',
      'spec.yaml.dpkg-old',
      'claude.yaml.dpkg-dist',
      'common.md.dpkg-bak',
    ]) {
      expect(isIgnoredSourceArtifact(name)).toBe(true);
    }
  });

  it('flags ucf / rpm / patch / editor / temp litter', () => {
    for (const name of [
      'foo.ucf-new',
      'foo.ucf-dist',
      'foo.rpmnew',
      'foo.rpmsave',
      'foo.orig',
      'foo.rej',
      'foo.bak',
      'foo.swp',
      'foo~',
      'body.md.1700000000000.4242.tmp',
    ]) {
      expect(isIgnoredSourceArtifact(name)).toBe(true);
    }
  });

  it('keeps real skill source files', () => {
    for (const name of ['body.md', 'spec.yaml', 'claude.yaml', 'close.md', 'foo.sh', 'image.png']) {
      expect(isIgnoredSourceArtifact(name)).toBe(false);
    }
  });
});
