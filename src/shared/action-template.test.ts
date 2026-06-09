import { describe, expect, it } from 'vitest';
import { globalContext, projectContext, substitute } from './action-template';
import type { ProjectLike } from './action-template';

describe('projectContext', () => {
  const baseProject: ProjectLike = {
    slug: '2026-05-17-project-card-actions-dropdown',
    title: 'Configurable actions dropdown on project cards',
    kind: 'project',
    status: 'now',
    apps: ['condash', 'conception'],
    path: '/home/alice/src/vcoeur/conception/projects/2026-05/2026-05-17-project-card-actions-dropdown',
    branch: 'project-card-actions-dropdown',
    base: 'main',
  };

  it('extracts every standard field', () => {
    const ctx = projectContext(baseProject);
    expect(ctx.slug).toBe('2026-05-17-project-card-actions-dropdown');
    expect(ctx.shortSlug).toBe('project-card-actions-dropdown');
    expect(ctx.title).toBe('Configurable actions dropdown on project cards');
    expect(ctx.branch).toBe('project-card-actions-dropdown');
    expect(ctx.base).toBe('main');
    expect(ctx.kind).toBe('project');
    expect(ctx.status).toBe('now');
    expect(ctx.date).toBe('2026-05-17');
    expect(ctx.apps).toBe('condash, conception');
    expect(ctx.firstApp).toBe('condash');
    expect(ctx.path).toBe(baseProject.path);
  });

  it('computes relPath when conceptionPath is provided', () => {
    const ctx = projectContext(baseProject, '/home/alice/src/vcoeur/conception');
    expect(ctx.relPath).toBe('projects/2026-05/2026-05-17-project-card-actions-dropdown');
  });

  it('leaves path unchanged when conceptionPath does not match', () => {
    const ctx = projectContext(baseProject, '/other/root');
    expect(ctx.relPath).toBe(baseProject.path);
  });

  it('leaves path unchanged when conceptionPath is absent', () => {
    const ctx = projectContext(baseProject);
    expect(ctx.relPath).toBe(baseProject.path);
  });

  it('normalises null branch and base to empty strings', () => {
    const ctx = projectContext({ ...baseProject, branch: null, base: null });
    expect(ctx.branch).toBe('');
    expect(ctx.base).toBe('');
  });

  it('computes shortSlug for a slug without date prefix', () => {
    const ctx = projectContext({ ...baseProject, slug: 'no-date-prefix' });
    expect(ctx.shortSlug).toBe('no-date-prefix');
  });

  it('uses empty string for apps when the array is empty', () => {
    const ctx = projectContext({ ...baseProject, apps: [] });
    expect(ctx.apps).toBe('');
    expect(ctx.firstApp).toBe('');
  });
});

describe('globalContext', () => {
  it('extracts today and conception from conceptionPath', () => {
    const ctx = globalContext('2026-05-18', '/home/alice/src/vcoeur/conception');
    expect(ctx.today).toBe('2026-05-18');
    expect(ctx.conception).toBe('conception');
    expect(ctx.conceptionPath).toBe('/home/alice/src/vcoeur/conception');
  });

  it('falls back to empty conception name for a bare slash', () => {
    const ctx = globalContext('2026-05-18', '/');
    expect(ctx.conception).toBe('');
  });
});

describe('substitute', () => {
  it('replaces known placeholders', () => {
    expect(substitute('work on {slug}', { slug: 'foo' })).toBe('work on foo');
  });

  it('replaces multiple occurrences of the same token', () => {
    expect(substitute('{slug} and {slug}', { slug: 'x' })).toBe('x and x');
  });

  it('replaces different known tokens in one pass', () => {
    expect(substitute('{a} {b}', { a: '1', b: '2' })).toBe('1 2');
  });

  it('leaves unknown tokens verbatim', () => {
    expect(substitute('test {unknown}', { slug: 'foo' })).toBe('test {unknown}');
  });

  it('leaves a typo token verbatim so it remains visible', () => {
    expect(substitute('{slgu}', { slug: 'foo' })).toBe('{slgu}');
  });

  it('substitutes the empty string for known-but-missing tokens', () => {
    expect(substitute('{empty}', { empty: '' })).toBe('');
  });

  it('handles templates with no placeholders', () => {
    expect(substitute('plain text', { slug: 'foo' })).toBe('plain text');
  });

  it('handles empty templates', () => {
    expect(substitute('', { slug: 'foo' })).toBe('');
  });

  it('processes project-scoped tokens against a full context bag', () => {
    const ctx = {
      slug: '2026-05-17-foo',
      shortSlug: 'foo',
      title: 'Foo project',
      branch: 'feat-x',
      base: 'main',
      kind: 'project',
      status: 'now',
      date: '2026-05-17',
      apps: 'condash',
      firstApp: 'condash',
      path: '/home/alice/src/foo',
      relPath: 'projects/foo',
    };
    expect(substitute('{shortSlug} on {branch} against {base}', ctx)).toBe(
      'foo on feat-x against main',
    );
  });

  it('processes global tokens against a global context bag', () => {
    const ctx = { today: '2026-05-18', conception: 'conception', conceptionPath: '/home/alice' };
    expect(substitute('start project for {today} in {conception}', ctx)).toBe(
      'start project for 2026-05-18 in conception',
    );
  });

  describe('{KEY:default} fallback', () => {
    it('uses the context value over the default when present', () => {
      expect(substitute('{AREA:docs/}', { AREA: 'src/' })).toBe('src/');
    });

    it('falls back to the default when the key is absent', () => {
      expect(substitute('{AREA:docs/}', {})).toBe('docs/');
    });

    it('uses an empty default for {KEY:}', () => {
      expect(substitute('a{X:}b', {})).toBe('ab');
    });

    it('allows spaces in the default value', () => {
      expect(substitute('focus: {AREA:CLAUDE.md and docs/}', {})).toBe(
        'focus: CLAUDE.md and docs/',
      );
    });

    it('leaves a default-less unknown token verbatim', () => {
      expect(substitute('{UNSET}', {})).toBe('{UNSET}');
    });

    it('prefers an empty-string context value over the default', () => {
      expect(substitute('{AREA:docs/}', { AREA: '' })).toBe('');
    });

    it('resolves a mix of filled, defaulted, and verbatim tokens in one pass', () => {
      expect(substitute('{a} {b:two} {c}', { a: 'one' })).toBe('one two {c}');
    });
  });

  describe('code-like fragments are not markers', () => {
    it('leaves a jq object construction verbatim (default starting with whitespace)', () => {
      const recipe = `jq -r '{key: .sid, value: .}' sessions.json`;
      expect(substitute(recipe, { key: 'X', value: 'Y' })).toBe(recipe);
    });

    it('leaves a generic {KEY: value} with a space after the colon verbatim', () => {
      expect(substitute('{KEY: not a marker}', { KEY: 'filled' })).toBe('{KEY: not a marker}');
    });

    it('leaves ${FOO:-bar} shell parameter expansion verbatim', () => {
      expect(substitute('echo ${FOO:-bar}', { FOO: 'x' })).toBe('echo ${FOO:-bar}');
      expect(substitute('echo ${FOO:-bar}', {})).toBe('echo ${FOO:-bar}');
    });

    it('still treats {KEY:-dash} as a marker when not preceded by $', () => {
      expect(substitute('{FOO:-bar}', {})).toBe('-bar');
      expect(substitute('{FOO:-bar}', { FOO: 'x' })).toBe('x');
    });

    it('a marker directly after a literal $ still resolves when its default has no leading -', () => {
      expect(substitute('cost: ${PRICE:0}', { PRICE: '5' })).toBe('cost: $5');
      expect(substitute('cost: ${PRICE:0}', {})).toBe('cost: $0');
    });

    it('normal markers in the same template still resolve around the code fragments', () => {
      expect(substitute(`run {cmd} | jq '{key: .sid}' # \${HOME:-/root}`, { cmd: 'list' })).toBe(
        `run list | jq '{key: .sid}' # \${HOME:-/root}`,
      );
    });
  });
});
