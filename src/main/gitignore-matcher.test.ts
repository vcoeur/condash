import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildGitignoreMatcher, readRuleText } from './gitignore-matcher';

const execFileAsync = promisify(execFile);

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

describe('buildGitignoreMatcher — build-dir floor is directory-only (W1)', () => {
  const ig = matcher(''); // floor only, no gitignore rules

  it('ignores dist/build/target DIRECTORIES and their contents', () => {
    expect(ig('dist', true)).toBe(true);
    expect(ig('build', true)).toBe(true);
    expect(ig('target', true)).toBe(true);
    // Non-final match → the segment is a directory by definition (blocks descent).
    expect(ig('dist/main/index.js')).toBe(true);
    expect(ig('src/build/out.o')).toBe(true);
    expect(ig('target/debug/app')).toBe(true);
    // Separator-suffixed variants stay ignored (dist-electron, build-out).
    expect(ig('dist-electron', true)).toBe(true);
    expect(ig('dist-cli/x')).toBe(true);
    expect(ig('build-out/x')).toBe(true);
  });

  it('keeps FILES named dist/build.rs/target watched (W1)', () => {
    expect(ig('dist', false)).toBe(false);
    expect(ig('build.rs', false)).toBe(false);
    expect(ig('target', false)).toBe(false);
    // No stats on a final-only match → stay watched, the conservative choice.
    expect(ig('dist')).toBe(false);
    expect(ig('target')).toBe(false);
  });

  it('does not suppress source names that merely start with dist/build (W1)', () => {
    expect(ig('src/builder.ts', false)).toBe(false);
    expect(ig('distance.py', false)).toBe(false);
    expect(ig('docs/building.md', false)).toBe(false);
  });

  it('watches the src/distribution/ tree — a real dir, not a build output (W1)', () => {
    expect(ig('src/distribution', true)).toBe(false);
    expect(ig('src/distribution/module.ts')).toBe(false);
  });

  it('word boundary: a NON-alphanumeric continuation is a build dir, alnum is source (W1)', () => {
    // The boundary class is `[^a-zA-Z0-9]`, so `_` / `.` / `-` after dist/build
    // are separators → still a build dir (ignored). A same-named FILE stays
    // watched (the floor is directory-only).
    expect(ig('dist_tmp', true)).toBe(true);
    expect(ig('dist.old', true)).toBe(true);
    expect(ig('build.2024', true)).toBe(true);
    expect(ig('dist_tmp', false)).toBe(false);
    // An alphanumeric continuation is a longer real word → watched even as a dir.
    expect(ig('builder', true)).toBe(false);
    expect(ig('distro', true)).toBe(false);
  });

  it('`target` is an exact segment — `targets/` is not a build dir (W1)', () => {
    expect(ig('targets', true)).toBe(false);
    expect(ig('targets/x.ts')).toBe(false);
  });

  it('still ignores .git / .condash / node_modules regardless of stats', () => {
    expect(ig('.condash', true)).toBe(true);
    expect(ig('.git/index')).toBe(true);
    expect(ig('node_modules/pkg/x.js')).toBe(true);
  });
});

describe('readRuleText — source precedence order (W2)', () => {
  let root: string;
  let globalExcludes: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'condash-gitignore-w2-'));
    await mkdir(join(root, '.git', 'info'), { recursive: true });
    globalExcludes = join(root, 'global-excludes');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('a repo .gitignore negation overrides a lower-precedence global exclude', async () => {
    // Global excludes ignores every *.log; the repo re-includes server.log. Git
    // tracks server.log, so the matcher must watch it — only true when sources
    // are concatenated in ASCENDING precedence (global first, .gitignore last),
    // because the `ignore` package is last-match-wins (W2).
    await writeFile(globalExcludes, '*.log\n');
    await writeFile(join(root, '.gitignore'), '!server.log\n');
    const m = buildGitignoreMatcher(root, readRuleText(root, globalExcludes));
    expect(m.ignores(join(root, 'server.log'), false)).toBe(false); // re-included
    expect(m.ignores(join(root, 'debug.log'), false)).toBe(true); // still ignored
  });

  it('.git/info/exclude also outranks the global exclude', async () => {
    await writeFile(globalExcludes, '*.log\n');
    await writeFile(join(root, '.git', 'info', 'exclude'), '!keep.log\n');
    const m = buildGitignoreMatcher(root, readRuleText(root, globalExcludes));
    expect(m.ignores(join(root, 'keep.log'), false)).toBe(false);
  });
});

describe('buildGitignoreMatcher — parity with real `git check-ignore` (M8b)', () => {
  // Neutralise the host's global / system git config (e.g. a user
  // core.excludesFile) so git sees only the fixture's own rules — the same
  // rule set the matcher reads via readRuleText(root, null).
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  let root: string;

  // { rel, dir } — every path is materialised so the matcher gets an accurate
  // isDirectory and git check-ignore matches against a real tree.
  const MATRIX: { rel: string; dir: boolean }[] = [
    { rel: 'README.md', dir: false },
    { rel: 'src/index.ts', dir: false },
    { rel: 'debug.log', dir: false },
    { rel: 'keep.log', dir: false },
    { rel: 'secret.txt', dir: false },
    { rel: 'node_modules', dir: true },
    { rel: 'dist', dir: true },
    { rel: 'dist/bundle.js', dir: false },
    { rel: 'build', dir: true },
    { rel: 'target', dir: true },
    { rel: 'coverage', dir: true },
    { rel: '.venv', dir: true },
    { rel: 'docs/building.md', dir: false },
    { rel: 'distance.py', dir: false },
    { rel: 'src/distribution/mod.ts', dir: false },
  ];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'condash-gitignore-parity-'));
    await execFileAsync('git', ['init', '-q'], { cwd: root, env: gitEnv });
    // Include the floor conventions so git and the matcher's hardcoded floor
    // agree on node_modules/dist/build/target; add ordinary rules + a negation.
    await writeFile(
      join(root, '.gitignore'),
      [
        'node_modules/',
        'dist/',
        'build/',
        'target/',
        'coverage/',
        '.venv/',
        '*.log',
        '!keep.log',
        'secret.txt',
      ].join('\n') + '\n',
    );
    for (const { rel, dir } of MATRIX) {
      const full = join(root, rel);
      if (dir) {
        await mkdir(full, { recursive: true });
      } else {
        await mkdir(join(full, '..'), { recursive: true });
        await writeFile(full, 'x');
      }
    }
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function gitIgnores(rel: string): Promise<boolean> {
    try {
      await execFileAsync('git', ['check-ignore', '-q', rel], { cwd: root, env: gitEnv });
      return true; // exit 0 → ignored
    } catch (err) {
      if ((err as { code?: number }).code === 1) return false; // exit 1 → not ignored
      throw err;
    }
  }

  it('matcher verdict equals git check-ignore across the path matrix', async () => {
    const m = buildGitignoreMatcher(root, readRuleText(root, null));
    for (const { rel, dir } of MATRIX) {
      const isDir = (await stat(join(root, rel))).isDirectory();
      expect(isDir).toBe(dir);
      const expected = await gitIgnores(rel);
      const actual = m.ignores(join(root, rel), isDir);
      expect({ rel, ignored: actual }).toEqual({ rel, ignored: expected });
    }
  });
});
