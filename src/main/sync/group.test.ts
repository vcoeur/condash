import { describe, expect, it } from 'vitest';
import { classifyPath, commitGroups, INDEX_COMMIT_SUBJECT, META_COMMIT_SUBJECT } from './group';

describe('classifyPath', () => {
  it('assigns files under an item dir to that item', () => {
    expect(classifyPath('projects/2026-07/2026-07-10-foo/README.md')).toEqual({
      kind: 'item',
      item: '2026-07-10-foo',
    });
    expect(classifyPath('projects/2026-07/2026-07-10-foo/notes/01-design.md')).toEqual({
      kind: 'item',
      item: '2026-07-10-foo',
    });
  });

  it("keeps an item's own index.md with the item, not the index commit", () => {
    // Segment count is the discriminator: 4 segments is inside an item,
    // 3 is the month's generated index.
    expect(classifyPath('projects/2026-07/2026-07-10-foo/index.md')).toEqual({
      kind: 'item',
      item: '2026-07-10-foo',
    });
    expect(classifyPath('projects/2026-07/index.md')).toEqual({ kind: 'index' });
  });

  it('routes every generated index to the index group', () => {
    expect(classifyPath('projects/index.md')).toEqual({ kind: 'index' });
    expect(classifyPath('knowledge/index.md')).toEqual({ kind: 'index' });
    expect(classifyPath('knowledge/topics/security/index.md')).toEqual({ kind: 'index' });
  });

  it('routes knowledge body files to the knowledge group', () => {
    expect(classifyPath('knowledge/internal/condash.md')).toEqual({ kind: 'knowledge' });
    expect(classifyPath('knowledge/topics/ops/git.md')).toEqual({ kind: 'knowledge' });
  });

  it('flags in-tree paths that match no known shape', () => {
    expect(classifyPath('projects/stray.md')).toEqual({ kind: 'unresolved' });
    expect(classifyPath('projects/not-a-month/thing.md')).toEqual({ kind: 'unresolved' });
    expect(classifyPath('projects/2026-07/not-an-item/x.md')).toEqual({ kind: 'unresolved' });
    expect(classifyPath('projects/2026-07/README.md')).toEqual({ kind: 'unresolved' });
    expect(classifyPath('knowledge')).toEqual({ kind: 'unresolved' });
  });

  it('routes every tracked non-tree path to the meta group (gitignore filters upstream)', () => {
    // classifyPath is a pure function on the string and does not know about
    // gitignore; the sweeper only ever hands it paths git status surfaced, so
    // ignored views (`.claude/*`, `CLAUDE.md`, …) never actually reach it. The
    // catch-all is what stops any tracked non-tree file from being stranded.
    expect(classifyPath('AGENTS.md')).toEqual({ kind: 'meta' });
    expect(classifyPath('README.md')).toEqual({ kind: 'meta' });
    expect(classifyPath('.gitignore')).toEqual({ kind: 'meta' });
    expect(classifyPath('.gitattributes')).toEqual({ kind: 'meta' });
    expect(classifyPath('.agents/skills/projects/SKILL.md')).toEqual({ kind: 'meta' });
    expect(classifyPath('.claude/settings.json')).toEqual({ kind: 'meta' });
    expect(classifyPath('.pi/settings.json')).toEqual({ kind: 'meta' });
    expect(classifyPath('opencode.json')).toEqual({ kind: 'meta' });
    expect(classifyPath('resources/reference/spec.pdf')).toEqual({ kind: 'meta' });
    expect(classifyPath('tasks/report.json')).toEqual({ kind: 'meta' });
  });
});

describe('commitGroups', () => {
  it('emits one group per item, sorted, with knowledge last', () => {
    const groups = commitGroups([
      'knowledge/internal/condash.md',
      'projects/2026-07/2026-07-10-zeta/README.md',
      'projects/2026-06/2026-06-01-alpha/README.md',
      'projects/2026-07/2026-07-10-zeta/notes/01-x.md',
    ]);

    expect(groups.map((g) => g.key)).toEqual(['2026-06-01-alpha', '2026-07-10-zeta', 'knowledge']);
    expect(groups.map((g) => g.subject)).toEqual([
      '2026-06-01-alpha: sync',
      '2026-07-10-zeta: sync',
      'knowledge: sync',
    ]);
    expect(groups[1].paths).toEqual([
      'projects/2026-07/2026-07-10-zeta/README.md',
      'projects/2026-07/2026-07-10-zeta/notes/01-x.md',
    ]);
  });

  it('gathers root structural files into one meta commit, after knowledge', () => {
    const groups = commitGroups([
      'AGENTS.md',
      'knowledge/internal/condash.md',
      'projects/2026-07/2026-07-10-zeta/README.md',
      '.agents/skills/projects/SKILL.md',
      '.gitignore',
    ]);

    expect(groups.map((g) => g.key)).toEqual(['2026-07-10-zeta', 'knowledge', 'meta']);
    const meta = groups[groups.length - 1];
    expect(meta.subject).toBe('meta: sync');
    expect(meta.paths).toEqual(['.agents/skills/projects/SKILL.md', '.gitignore', 'AGENTS.md']);
  });

  it('drops index and unresolved paths', () => {
    expect(commitGroups(['projects/index.md', 'projects/stray.md'])).toEqual([]);
  });

  it('returns nothing for an empty sweep', () => {
    expect(commitGroups([])).toEqual([]);
  });

  it('names the index and meta commits distinctly from any item', () => {
    expect(INDEX_COMMIT_SUBJECT).toBe('indexes: sync');
    expect(META_COMMIT_SUBJECT).toBe('meta: sync');
  });
});
