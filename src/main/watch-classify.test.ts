import { describe, expect, it } from 'vitest';
import { buildWatchPaths, classify, type RootSet } from './watch-classify';

const paths = buildWatchPaths('/c');
const roots: RootSet = { resources: '/c/resources', skills: '/c/.agents/skills' };
const cl = (event: Parameters<typeof classify>[0], path: string) =>
  classify(event, path, roots, paths);

const README = '/c/projects/2026-07/slug/README.md';

describe('classify — project card events', () => {
  it('routes a README change/add/unlink to a project event on that card', () => {
    expect(cl('change', README)).toEqual({ kind: 'project', op: 'change', path: README });
    expect(cl('add', README)).toEqual({ kind: 'project', op: 'add', path: README });
    expect(cl('unlink', README)).toEqual({ kind: 'project', op: 'unlink', path: README });
  });
});

describe('classify — in-project files become a scoped card patch (R1)', () => {
  it('patches the card on a note edit — never the whole dashboard', () => {
    expect(cl('change', '/c/projects/2026-07/slug/notes/01-x.md')).toEqual({
      kind: 'project',
      op: 'change',
      path: README,
    });
  });

  it('maps a note unlink to a card patch, NOT a card removal', () => {
    // The README still exists; only a note went away — the card must survive.
    expect(cl('unlink', '/c/projects/2026-07/slug/notes/01-x.md')).toEqual({
      kind: 'project',
      op: 'change',
      path: README,
    });
  });

  it('treats any other in-project file (local/, nested) as a card patch', () => {
    expect(cl('change', '/c/projects/2026-07/slug/local/shot.png')).toEqual({
      kind: 'project',
      op: 'change',
      path: README,
    });
  });
});

describe('classify — index regens are ignored, not a full reload (R1)', () => {
  it('ignores the projects root index.md', () => {
    expect(cl('change', '/c/projects/index.md')).toEqual({ kind: 'ignore' });
  });

  it('ignores a per-month index.md', () => {
    expect(cl('change', '/c/projects/2026-07/index.md')).toEqual({ kind: 'ignore' });
  });
});

describe('classify — project dir add/remove reloads only projects (R1)', () => {
  it('classifies a new project dir as projects-reload', () => {
    expect(cl('addDir', '/c/projects/2026-07/newslug')).toEqual({ kind: 'projects-reload' });
  });

  it('classifies a notes/ dir appearing as projects-reload', () => {
    expect(cl('addDir', '/c/projects/2026-07/slug/notes')).toEqual({ kind: 'projects-reload' });
  });

  it('classifies a removed project dir as projects-reload', () => {
    expect(cl('unlinkDir', '/c/projects/2026-07/slug')).toEqual({ kind: 'projects-reload' });
  });

  it('keeps dir events outside every known tree as the true catch-all', () => {
    expect(cl('addDir', '/c/some-repo/subdir')).toEqual({ kind: 'unknown' });
    expect(cl('unlinkDir', '/c/.git/objects')).toEqual({ kind: 'unknown' });
  });
});

describe('classify — dir add/remove under knowledge/ & resources/ scope-reloads (B3)', () => {
  it('routes a knowledge subdir add/remove to a scoped knowledge reload, not unknown', () => {
    expect(cl('addDir', '/c/knowledge/topics/x')).toEqual({
      kind: 'knowledge',
      op: 'add',
      path: '/c/knowledge/topics/x',
    });
    expect(cl('unlinkDir', '/c/knowledge/topics/x')).toEqual({
      kind: 'knowledge',
      op: 'unlink',
      path: '/c/knowledge/topics/x',
    });
  });

  it('routes a resources subdir add/remove to a scoped resources reload, not unknown', () => {
    expect(cl('addDir', '/c/resources/newdir')).toEqual({
      kind: 'resources',
      op: 'add',
      path: '/c/resources/newdir',
    });
    expect(cl('unlinkDir', '/c/resources/local/shots')).toEqual({
      kind: 'resources',
      op: 'unlink',
      path: '/c/resources/local/shots',
    });
  });
});

describe('classify — unchanged routing for the other panes', () => {
  it('knowledge markdown', () => {
    expect(cl('change', '/c/knowledge/topics/x.md')).toEqual({
      kind: 'knowledge',
      op: 'change',
      path: '/c/knowledge/topics/x.md',
    });
  });

  it('config settings.json', () => {
    expect(cl('change', '/c/.condash/settings.json')).toEqual({
      kind: 'config',
      path: '/c/.condash/settings.json',
    });
  });

  it('conception-level AGENTS.md → skills', () => {
    expect(cl('change', '/c/AGENTS.md')).toEqual({
      kind: 'skills',
      op: 'change',
      path: '/c/AGENTS.md',
    });
  });

  it('resources file', () => {
    expect(cl('change', '/c/resources/file.pdf')).toEqual({
      kind: 'resources',
      op: 'change',
      path: '/c/resources/file.pdf',
    });
  });

  it('a genuinely unrecognised file stays unknown', () => {
    expect(cl('change', '/c/random.txt')).toEqual({ kind: 'unknown' });
    expect(cl('change', '/c/README.md')).toEqual({ kind: 'unknown' });
  });
});
