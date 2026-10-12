import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planFileRewrites, planReferenceRewrites, renameProjectCore } from './rename-project';
import { regenerateIndex } from './index-tree';
import { projectsStrategy } from './index-projects';
import { writeProjectReadme } from '../cli/commands/test-helpers';

const OLD = '2026-10-12-old-one';
const NEW = '2026-10-12-renamed-one';

describe('planFileRewrites (pure planner)', () => {
  it('rewrites the four wikilink terminator shapes', () => {
    const content = [
      'Link [[2026-10-12-old-one]] inline.',
      'Label [[2026-10-12-old-one|the plan]] and anchor [[2026-10-12-old-one#steps]].',
      'Path inside a wikilink [[2026-10-12-old-one/notes/01-x]].',
    ].join('\n');
    const plan = planFileRewrites('a.md', content, OLD, NEW);
    expect(plan).not.toBeNull();
    expect(plan?.content).toBe(
      [
        'Link [[2026-10-12-renamed-one]] inline.',
        'Label [[2026-10-12-renamed-one|the plan]] and anchor [[2026-10-12-renamed-one#steps]].',
        'Path inside a wikilink [[2026-10-12-renamed-one/notes/01-x]].',
      ].join('\n'),
    );
    expect(plan?.edits.map((e) => e.line)).toEqual([1, 2, 2, 3]);
  });

  it('never matches past the slug boundary — `-foo` rename leaves `-foo-bar` alone', () => {
    // The issue's mandatory case: renaming `…-old-one` must not touch
    // `…-old-one-bar`, in any of the three shapes.
    const content = [
      'Wikilink [[2026-10-12-old-one-bar]] stays.',
      'Path projects/2026-10/2026-10-12-old-one-bar/README.md stays.',
      'Parent: 2026-10-12-old-one-bar stays.',
    ].join('\n');
    const plan = planFileRewrites('a.md', content, OLD, NEW);
    expect(plan).toBeNull();
  });

  it('leaves short-form wikilinks untouched (substring collisions by design)', () => {
    const content = 'See [[old-one]] and [[renamed-one]] — neither is a full dated slug.';
    expect(planFileRewrites('a.md', content, OLD, NEW)).toBeNull();
  });

  it('rewrites parent fields in both header shapes, bare or backticked', () => {
    const content = [
      '---',
      'date: 2026-10-13',
      `parent: ${OLD}`,
      '---',
      '',
      '# Child',
      '',
      `**Parent**: \`${OLD}\` (the plan this spins off from)`,
    ].join('\n');
    const plan = planFileRewrites('child.md', content, OLD, NEW);
    expect(plan?.content).toBe(
      [
        '---',
        'date: 2026-10-13',
        `parent: ${NEW}`,
        '---',
        '',
        '# Child',
        '',
        `**Parent**: \`${NEW}\` (the plan this spins off from)`,
      ].join('\n'),
    );
  });

  it('rewrites path text with and without a trailing slash, including inside backticks', () => {
    const content = [
      `Read [the plan](../../projects/2026-10/${OLD}/README.md) first.`,
      `Verified: 2026-10-12 — \`projects/2026-10/${OLD}\` on main.`,
      `Plain text projects/2026-10/${OLD} mention.`,
    ].join('\n');
    const plan = planFileRewrites('k.md', content, OLD, NEW);
    expect(plan?.content).toBe(
      [
        `Read [the plan](../../projects/2026-10/${NEW}/README.md) first.`,
        `Verified: 2026-10-12 — \`projects/2026-10/${NEW}\` on main.`,
        `Plain text projects/2026-10/${NEW} mention.`,
      ].join('\n'),
    );
    expect(plan?.edits).toHaveLength(3);
  });

  it('preserves CRLF line endings (byte-local replace)', () => {
    const content = `# A\r\n\r\nSee [[${OLD}]].\r\n`;
    const plan = planFileRewrites('a.md', content, OLD, NEW);
    expect(plan?.content).toBe(`# A\r\n\r\nSee [[${NEW}]].\r\n`);
  });

  it('reports 1-based line numbers across several matches', () => {
    const content = [
      'line one',
      '',
      `[[${OLD}]] and [[${OLD}|again]]`,
      'line four',
      `projects/2026-10/${OLD}`,
    ].join('\n');
    const plan = planFileRewrites('a.md', content, OLD, NEW);
    expect(plan?.edits.map((e) => e.line)).toEqual([3, 3, 5]);
  });

  it('returns null for content without matches', () => {
    expect(planFileRewrites('a.md', 'nothing here', OLD, NEW)).toBeNull();
  });
});

describe('planReferenceRewrites', () => {
  it('collects only files with edits, in input order', () => {
    const plans = planReferenceRewrites(
      [
        { file: 'clean.md', content: 'no refs' },
        { file: 'hit.md', content: `[[${OLD}]]` },
      ],
      OLD,
      NEW,
    );
    expect(plans.map((p) => p.file)).toEqual(['hit.md']);
  });
});

describe('renameProjectCore (driver)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(`${process.env.TMPDIR ?? '/tmp'}`, 'condash-rename-test-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  /** A tree with one item referenced from knowledge, docs, and a child item
   *  in all four shapes, plus gitignored content inside the item. */
  async function seedTree(): Promise<void> {
    await writeProjectReadme(root, 'old-one', {
      date: '2026-10-12',
      kind: 'project',
      status: 'now',
      title: 'Old one',
    });
    const localDir = join(root, 'projects', '2026-10', OLD, 'local');
    await fs.mkdir(localDir, { recursive: true });
    await fs.writeFile(join(localDir, 'render.png'), 'gitignored bytes\n');
    await fs.mkdir(join(root, 'knowledge', 'topics'), { recursive: true });
    await fs.writeFile(
      join(root, 'knowledge', 'topics', 'ref.md'),
      [
        `Linked [[${OLD}|the plan]] and plain path projects/2026-10/${OLD}/README.md.`,
        `Short wikilink [[old-one]] must survive.`,
        `Neighbour [[2026-10-12-old-one-bar]] must survive.`,
      ].join('\n'),
      'utf8',
    );
    await fs.mkdir(join(root, 'docs'), { recursive: true });
    await fs.writeFile(
      join(root, 'docs', 'note.md'),
      `parent-ish path text: projects/2026-10/${OLD} end.\n`,
      'utf8',
    );
    await writeProjectReadme(root, 'old-one-bar', {
      date: '2026-10-13',
      kind: 'project',
      status: 'now',
      title: 'Neighbour',
      body: `## Notes\n\nSpin-off of [[${OLD}]] — see projects/2026-10/${OLD}/README.md.\n`,
    });
    // A child item whose YAML parent points at the renamed item.
    const childDir = join(root, 'projects', '2026-10', '2026-10-14-child');
    await fs.mkdir(childDir, { recursive: true });
    await fs.writeFile(
      join(childDir, 'README.md'),
      `---\ndate: 2026-10-14\nkind: project\nstatus: now\nparent: ${OLD}\n---\n\n# Child\n`,
      'utf8',
    );
    // Lay down a pre-existing month index so the rename hits the engine's
    // suspected-rename path (old bullet dropped, new bullet refused) — exactly
    // the shape a real tree is in. The verb must still land the new bullet.
    await regenerateIndex(root, projectsStrategy);
  }

  it('moves the dir (gitignored local/ included), rewrites references, regenerates indexes', async () => {
    await seedTree();
    const report = await renameProjectCore(root, OLD, 'renamed-one');

    expect(report.dryRun).toBe(false);
    expect(report.moved).toEqual({
      from: `projects/2026-10/${OLD}`,
      to: 'projects/2026-10/2026-10-12-renamed-one',
    });

    // Dir moved, gitignored content moved with it.
    await expect(fs.stat(join(root, 'projects', '2026-10', OLD))).rejects.toThrow();
    const newDir = join(root, 'projects', '2026-10', NEW);
    await expect(fs.stat(join(newDir, 'README.md'))).resolves.toBeTruthy();
    await expect(fs.stat(join(newDir, 'local', 'render.png'))).resolves.toBeTruthy();

    // References rewritten.
    const knowledge = await fs.readFile(join(root, 'knowledge', 'topics', 'ref.md'), 'utf8');
    expect(knowledge).toContain(`[[${NEW}|the plan]]`);
    expect(knowledge).toContain(`projects/2026-10/${NEW}/README.md`);
    expect(knowledge).toContain('[[old-one]] must survive');
    expect(knowledge).toContain('[[2026-10-12-old-one-bar]] must survive');
    const docs = await fs.readFile(join(root, 'docs', 'note.md'), 'utf8');
    expect(docs).toContain(`projects/2026-10/${NEW} end.`);
    const child = await fs.readFile(join(childReadme(root)), 'utf8');
    expect(child).toContain(`parent: ${NEW}`);

    // The neighbour item referencing OLD is rewritten in the covered shapes;
    // its own name (`-bar`) is untouched, and a bare-slug prose mention is
    // left alone (bare text is none of the three reference shapes).
    const neighbour = await fs.readFile(
      join(root, 'projects', '2026-10', '2026-10-13-old-one-bar', 'README.md'),
      'utf8',
    );
    expect(neighbour).toContain(`Spin-off of [[${NEW}]] — see projects/2026-10/${NEW}/README.md.`);
    expect(neighbour).not.toContain(OLD);

    // Indexes regenerated: the month index carries a bullet for the new
    // item and none for the old one. (Bullet *descriptions* of OTHER items
    // are draft-time snapshots — one quoting the old slug persists until
    // re-curated; that's the index engine's existing semantics.)
    const monthIndex = await fs.readFile(join(root, 'projects', '2026-10', 'index.md'), 'utf8');
    expect(monthIndex).toContain('`2026-10-12-renamed-one/`');
    expect(monthIndex).not.toContain('`2026-10-12-old-one/`');

    // Mutating-verb convention + regen summary.
    await expect(fs.stat(join(root, 'projects', '.index-dirty'))).resolves.toBeTruthy();
    expect(report.indexes).toMatchObject({ tree: 'projects' });
    expect(report.edits.length).toBeGreaterThan(3);
  });

  it('rewrites the moved item’s own files at their new location', async () => {
    await seedTree();
    const notesDir = join(root, 'projects', '2026-10', OLD, 'notes');
    await fs.mkdir(notesDir);
    await fs.writeFile(join(notesDir, '01-x.md'), `Self-reference [[${OLD}]].\n`, 'utf8');

    await renameProjectCore(root, OLD, 'renamed-one');

    const note = await fs.readFile(
      join(root, 'projects', '2026-10', NEW, 'notes', '01-x.md'),
      'utf8',
    );
    expect(note).toBe(`Self-reference [[${NEW}]].\n`);
  });

  it('changes nothing under --dry-run', async () => {
    await seedTree();
    const knowledgeBefore = await fs.readFile(join(root, 'knowledge', 'topics', 'ref.md'), 'utf8');
    const readmeBefore = await fs.readFile(
      join(root, 'projects', '2026-10', OLD, 'README.md'),
      'utf8',
    );

    const report = await renameProjectCore(root, OLD, 'renamed-one', { dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.indexes).toBeUndefined();
    await expect(fs.stat(join(root, 'projects', '2026-10', OLD))).resolves.toBeTruthy();
    await expect(
      fs.stat(join(root, 'projects', '2026-10', '2026-10-12-renamed-one')),
    ).rejects.toThrow();
    expect(await fs.readFile(join(root, 'knowledge', 'topics', 'ref.md'), 'utf8')).toBe(
      knowledgeBefore,
    );
    expect(await fs.readFile(join(root, 'projects', '2026-10', OLD, 'README.md'), 'utf8')).toBe(
      readmeBefore,
    );
    // Dry-run still reports where files will land, including the moved item's own.
    expect(
      report.edits.every(
        (e) => !e.file.includes(OLD) || e.file.startsWith(`projects/2026-10/${NEW}/`),
      ),
    ).toBe(true);
  });

  it('rejects an invalid new slug, identity renames, and an existing target dir', async () => {
    await seedTree();
    await expect(renameProjectCore(root, OLD, 'Bad_Slug')).rejects.toMatchObject({
      exitCode: 3,
    });
    await expect(renameProjectCore(root, OLD, 'old-one')).rejects.toMatchObject({ exitCode: 3 });
    await expect(renameProjectCore(root, OLD, OLD)).rejects.toMatchObject({ exitCode: 3 });
    // Target dir already present.
    await fs.mkdir(join(root, 'projects', '2026-10', '2026-10-12-taken'));
    await expect(renameProjectCore(root, OLD, 'taken')).rejects.toMatchObject({ exitCode: 3 });
  });

  it('rejects a folder without a date prefix (out of scope by design)', async () => {
    const undated = join(root, 'projects', '2026-10', 'undated');
    await fs.mkdir(undated, { recursive: true });
    await fs.writeFile(join(undated, 'README.md'), '# Undated\n', 'utf8');
    await expect(renameProjectCore(root, 'undated', 'moved')).rejects.toMatchObject({
      exitCode: 3,
    });
  });
});

function childReadme(root: string): string {
  return join(root, 'projects', '2026-10', '2026-10-14-child', 'README.md');
}
