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
});
