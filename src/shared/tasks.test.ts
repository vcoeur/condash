import { describe, expect, it } from 'vitest';
import type { ProjectLike } from './action-template';
import { substitute } from './action-template';
import {
  appContext,
  extractMarkers,
  isAppToken,
  isProjectToken,
  isProvidedToken,
  projectTokenContext,
} from './tasks';

describe('extractMarkers', () => {
  it('returns ordered, unique markers with their defaults', () => {
    expect(extractMarkers('Review {APP}. Focus {AREA:CLAUDE.md}. Tag {APP}.')).toEqual([
      { key: 'APP', default: '' },
      { key: 'AREA', default: 'CLAUDE.md' },
    ]);
  });

  it('keeps the first occurrence default when a key repeats', () => {
    expect(extractMarkers('{X:first} then {X:second}')).toEqual([{ key: 'X', default: 'first' }]);
  });

  it('returns [] for a prompt with no markers', () => {
    expect(extractMarkers('plain prompt, no markers')).toEqual([]);
  });

  it('parses reserved and plain markers side by side', () => {
    expect(extractMarkers('{PROJECT_PATH} for {PROJECT} on {BRANCH_HINT:main}')).toEqual([
      { key: 'PROJECT_PATH', default: '' },
      { key: 'PROJECT', default: '' },
      { key: 'BRANCH_HINT', default: 'main' },
    ]);
  });

  it('skips jq-object fragments (default starting with whitespace)', () => {
    expect(extractMarkers(`jq '{key: .sid, value: .}' then {AREA:docs/}`)).toEqual([
      { key: 'AREA', default: 'docs/' },
    ]);
  });

  it('skips ${FOO:-bar} shell parameter expansions but keeps plain {FOO:-bar}', () => {
    expect(extractMarkers('echo ${FOO:-bar}')).toEqual([]);
    expect(extractMarkers('{FOO:-bar}')).toEqual([{ key: 'FOO', default: '-bar' }]);
  });
});

describe('reserved token predicates', () => {
  it('recognises the {APP_*} family', () => {
    expect(isAppToken('APP')).toBe(true);
    expect(isAppToken('APP_PATH')).toBe(true);
    expect(isAppToken('APP_NAME')).toBe(true);
    expect(isAppToken('AREA')).toBe(false);
  });

  it('recognises the {PROJECT_*} family', () => {
    expect(isProjectToken('PROJECT')).toBe(true);
    expect(isProjectToken('PROJECT_BRANCH')).toBe(true);
    expect(isProjectToken('PROJECT_TITLE')).toBe(true);
    expect(isProjectToken('PROMPT')).toBe(false);
  });

  it('recognises the provided {TABS} / {UPDATED_TABS} tokens (capability 2)', () => {
    expect(isProvidedToken('TABS')).toBe(true);
    expect(isProvidedToken('UPDATED_TABS')).toBe(true);
    expect(isProvidedToken('APP')).toBe(false);
    expect(isProvidedToken('AREA')).toBe(false);
  });
});

describe('substitute with the provided tab vars', () => {
  it('injects the open-tab JSON for a {TABS} marker', () => {
    const tabs = JSON.stringify([{ sid: 't-a', cwd: '/x', repo: 'condash', cmd: 'agedum claude' }]);
    expect(substitute('Tabs: {TABS}', { TABS: tabs })).toBe(`Tabs: ${tabs}`);
  });

  it('injects the changed-tab subset for an {UPDATED_TABS} marker', () => {
    const all = JSON.stringify([{ sid: 't-a' }, { sid: 't-b' }]);
    const updated = JSON.stringify([{ sid: 't-b' }]);
    expect(
      substitute('All {TABS} / new {UPDATED_TABS}', { TABS: all, UPDATED_TABS: updated }),
    ).toBe(`All ${all} / new ${updated}`);
  });
});

describe('appContext', () => {
  it('builds the {APP_*} family with the #alias as the bare value', () => {
    expect(appContext({ name: 'condash', path: '/home/alice/src/vcoeur/condash' })).toEqual({
      APP: '#condash',
      APP_NAME: 'condash',
      APP_PATH: '/home/alice/src/vcoeur/condash',
    });
  });

  it('returns an empty bag when no app is chosen', () => {
    expect(appContext(null)).toEqual({});
  });
});

describe('projectTokenContext', () => {
  const project: ProjectLike = {
    slug: '2026-05-23-condash-tasks-pane',
    title: 'condash Tasks pane',
    kind: 'project',
    status: 'now',
    apps: ['condash'],
    path: '/home/alice/src/vcoeur/conception/projects/2026-05/2026-05-23-condash-tasks-pane',
    branch: 'condash-tasks-pane',
    base: 'main',
  };

  it('builds the {PROJECT_*} family with the slug as the bare value', () => {
    const ctx = projectTokenContext(project, '/home/alice/src/vcoeur/conception');
    expect(ctx).toEqual({
      PROJECT: '2026-05-23-condash-tasks-pane',
      PROJECT_SLUG: '2026-05-23-condash-tasks-pane',
      PROJECT_PATH: 'projects/2026-05/2026-05-23-condash-tasks-pane',
      PROJECT_BRANCH: 'condash-tasks-pane',
      PROJECT_BASE: 'main',
      PROJECT_TITLE: 'condash Tasks pane',
    });
  });

  it('returns an empty bag when no project is chosen', () => {
    expect(projectTokenContext(null)).toEqual({});
  });
});

describe('end-to-end substitution', () => {
  it('fills a prompt from app + project + plain fields, defaulting the rest', () => {
    const ctx = {
      ...appContext({ name: 'condash', path: '/home/alice/src/vcoeur/condash' }),
      ...projectTokenContext(
        {
          slug: '2026-05-23-x',
          title: 'X',
          kind: 'project',
          status: 'now',
          apps: ['condash'],
          path: '/c/projects/2026-05/2026-05-23-x',
          branch: 'x',
          base: 'main',
        },
        '/c',
      ),
      AREA: 'docs/',
    };
    const prompt = 'In {APP_PATH} on {PROJECT_BRANCH}: review {AREA} and {EXTRA:nothing}.';
    expect(substitute(prompt, ctx)).toBe(
      'In /home/alice/src/vcoeur/condash on x: review docs/ and nothing.',
    );
  });
});
