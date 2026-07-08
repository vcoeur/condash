import { describe, expect, it } from 'vitest';
import { buildGitignoreMatcher } from './gitignore-matcher';

const ROOT = '/repo';
const abs = (rel: string) => `${ROOT}/${rel}`;

/** Build a matcher and a terse `ig(rel, isDir?)` probe over absolute paths. */
function matcher(ruleText: string) {
  const m = buildGitignoreMatcher(ROOT, ruleText);
  return (rel: string, isDirectory?: boolean) => m.ignores(abs(rel), isDirectory);
}

describe('buildGitignoreMatcher — hardcoded floor (gitignore-independent)', () => {
  const ig = matcher(''); // no gitignore rules at all

  it('always ignores .condash (the self-trigger loop fix)', () => {
    expect(ig('.condash', true)).toBe(true);
    expect(ig('.condash/logs/2026/07/08/x.txt')).toBe(true);
  });

  it('always ignores .git, node_modules, dist*, build*, target', () => {
    expect(ig('.git', true)).toBe(true);
    expect(ig('.git/index')).toBe(true);
    expect(ig('node_modules', true)).toBe(true);
    expect(ig('node_modules/pkg/index.js')).toBe(true);
    expect(ig('dist', true)).toBe(true);
    expect(ig('dist-electron/main/index.js')).toBe(true);
    expect(ig('build', true)).toBe(true);
    expect(ig('build-out/x')).toBe(true);
    expect(ig('target', true)).toBe(true);
    expect(ig('target/debug/bin')).toBe(true);
  });

  it('ignores the floor dirs nested anywhere, not just at the root', () => {
    expect(ig('src/node_modules/x.js')).toBe(true);
    expect(ig('a/b/.condash/state.json')).toBe(true);
  });

  it('does NOT blanket-ignore other dot-directories (they may be tracked)', () => {
    expect(ig('.github', true)).toBe(false);
    expect(ig('.github/workflows/ci.yml')).toBe(false);
    expect(ig('.agents/skills/x.md')).toBe(false);
  });
});

describe('buildGitignoreMatcher — pattern semantics', () => {
  it('honours a plain name match (and its descendants)', () => {
    const ig = matcher('.venv\n');
    expect(ig('.venv', true)).toBe(true);
    expect(ig('.venv/lib/python3/site.py')).toBe(true);
    expect(ig('venv', true)).toBe(false); // different name
  });

  it('honours a dir-only pattern `foo/` — dir + contents, not a same-named file', () => {
    const ig = matcher('coverage/\n');
    // The directory node itself must be blocked (so chokidar won't descend).
    expect(ig('coverage', true)).toBe(true);
    // Its contents are ignored regardless of stats.
    expect(ig('coverage/report.html')).toBe(true);
    // A *file* named `coverage` is NOT matched by a dir-only pattern.
    expect(ig('coverage', false)).toBe(false);
  });

  it('honours a leading-slash anchor (root-relative only)', () => {
    // `generated` avoids colliding with the `build*` floor so this isolates
    // the gitignore anchor semantics.
    const ig = matcher('/generated\n');
    expect(ig('generated', true)).toBe(true);
    expect(ig('sub/generated', true)).toBe(false); // anchored to root
  });

  it('honours `*` globs at any depth', () => {
    const ig = matcher('*.pyc\n');
    expect(ig('a/b/c.pyc')).toBe(true);
    expect(ig('a/b/c.py')).toBe(false);
  });

  it('honours negation (`!`) re-includes', () => {
    const ig = matcher('*.log\n!keep.log\n');
    expect(ig('debug.log')).toBe(true);
    expect(ig('keep.log')).toBe(false);
  });

  it('lets the floor win even when gitignore would not match', () => {
    // gitignore says nothing about .condash; the floor still ignores it.
    const ig = matcher('*.log\n');
    expect(ig('.condash/logs/x.txt')).toBe(true);
  });
});

describe('buildGitignoreMatcher — ancestor-ignored paths', () => {
  it('ignores a deep descendant of an ignored directory', () => {
    const ig = matcher('.venv/\n');
    expect(ig('.venv', true)).toBe(true);
    expect(ig('.venv/lib/python3.12/site-packages/pip/__init__.py')).toBe(true);
  });
});

describe('buildGitignoreMatcher — root and out-of-root paths', () => {
  const ig = buildGitignoreMatcher(ROOT, 'node_modules\n');

  it('never ignores the watch root itself (chokidar must watch it)', () => {
    expect(ig.ignores(ROOT, true)).toBe(false);
  });

  it('never ignores a path outside the watch root', () => {
    expect(ig.ignores('/other/node_modules/x.js')).toBe(false);
    expect(ig.ignores('/rep', true)).toBe(false); // prefix-but-not-under
  });

  it('keeps ordinary tracked files unignored', () => {
    expect(ig.ignores(abs('src/main/index.ts'), false)).toBe(false);
    expect(ig.ignores(abs('README.md'), false)).toBe(false);
  });
});

describe('buildGitignoreMatcher — rebuild semantics on rule change', () => {
  it('reflects new rules when a fresh matcher is built (the .gitignore-edit path)', () => {
    const before = buildGitignoreMatcher(ROOT, '');
    expect(before.ignores(abs('secrets.env'), false)).toBe(false);
    // Simulate a .gitignore edit adding a rule → repo-watchers rebuilds.
    const after = buildGitignoreMatcher(ROOT, 'secrets.env\n');
    expect(after.ignores(abs('secrets.env'), false)).toBe(true);
  });
});
