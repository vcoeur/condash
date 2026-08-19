/**
 * `searchProjectReadmes` — the Projects-pane filter bar's search. It has to
 * behave like a filter, not a ranked search: every matching README comes back
 * (no hit cap), notes never make an item match, a term matches the README
 * content or the item's slug but never the rest of the path (`readme`, `md`, a
 * month directory), and the returned values are the posix README paths the
 * renderer already holds as `Project.path`. Both index states are covered — the
 * on-disk fallback of the boot gap and the live index.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toPosix } from '../../shared/path';
import { searchProjectReadmes } from './index';
import { clearSearchIndex, rebuildSearchIndex } from './index-cache';

describe('searchProjectReadmes', () => {
  let dir: string;
  const readmes: string[] = [];

  const seedItem = async (slug: string, readmeBody: string, noteBody?: string): Promise<string> => {
    const item = join(dir, 'projects', '2026-07', slug);
    await mkdir(join(item, 'notes'), { recursive: true });
    const readme = join(item, 'README.md');
    await writeFile(readme, readmeBody);
    if (noteBody !== undefined) await writeFile(join(item, 'notes', '01-note.md'), noteBody);
    return toPosix(readme);
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'condash-readme-filter-'));
    readmes.length = 0;
    readmes.push(await seedItem('2026-07-01-alpha', '# Alpha\n\nfilterword in the body\n'));
    readmes.push(
      await seedItem(
        '2026-07-02-beta',
        '# Beta\n\nnothing here\n',
        '# Note\n\nfilterword only in a note\n',
      ),
    );
    readmes.push(await seedItem('2026-07-03-gamma', '# Gamma\n\nFilterWord again, mixed case\n'));
    await mkdir(join(dir, 'knowledge'), { recursive: true });
    await writeFile(join(dir, 'knowledge', 'k.md'), '# K\n\nfilterword in knowledge\n');
    clearSearchIndex();
  });

  afterEach(async () => {
    clearSearchIndex();
    await rm(dir, { recursive: true, force: true });
  });

  const expectReadmeOnlyMatches = async (): Promise<void> => {
    const paths = await searchProjectReadmes(dir, 'filterword');
    // alpha + gamma match on their README; beta's note is not consulted; the
    // knowledge file is out of scope entirely.
    expect([...paths].sort()).toEqual([readmes[0], readmes[2]].sort());
    for (const p of paths) expect(p.endsWith('/README.md')).toBe(true);
  };

  it('returns matching README paths from the on-disk scan before the index is built', async () => {
    await expectReadmeOnlyMatches();
  });

  it('returns the same paths from the live index', async () => {
    await rebuildSearchIndex(dir);
    await expectReadmeOnlyMatches();
  });

  it('matches the item slug, but never the rest of the path', async () => {
    for (const build of [false, true]) {
      if (build) await rebuildSearchIndex(dir);
      // `gamma` names one item by its slug; its README body never says so.
      expect(await searchProjectReadmes(dir, 'gamma')).toEqual([readmes[2]]);
      // Path-only tokens: the README file name, its extension and the
      // projects root match nothing on their own…
      for (const token of ['readme', 'md', 'projects']) {
        expect(await searchProjectReadmes(dir, token), token).toEqual([]);
      }
      // …while the dated slug prefix does — every seeded item is a 2026-07
      // slug, so a month reads as a filter, by design.
      expect((await searchProjectReadmes(dir, '2026-07')).sort()).toEqual([...readmes].sort());
      // AND across terms, each satisfiable by content or slug.
      expect(await searchProjectReadmes(dir, 'gamma mixed')).toEqual([readmes[2]]);
      expect(await searchProjectReadmes(dir, 'gamma nothing')).toEqual([]);
    }
  });

  it('accepts a lower-case readme.md file name', async () => {
    const item = join(dir, 'projects', '2026-07', '2026-07-05-lower');
    await mkdir(item, { recursive: true });
    const readme = join(item, 'readme.md');
    await writeFile(readme, '# Lower\n\nlowerword\n');
    for (const build of [false, true]) {
      if (build) await rebuildSearchIndex(dir);
      expect(await searchProjectReadmes(dir, 'lowerword')).toEqual([toPosix(readme)]);
    }
  });

  it('returns nothing for a blank or all-stopword query', async () => {
    expect(await searchProjectReadmes(dir, '')).toEqual([]);
    expect(await searchProjectReadmes(dir, '   ')).toEqual([]);
  });

  it('is not capped at the ranked search hit limit', async () => {
    // 120 matching items — more than search()'s RAW_HIT_CAP of 100.
    const expected: string[] = [];
    for (let i = 0; i < 120; i++) {
      expected.push(
        await seedItem(
          `2026-07-04-many-${String(i).padStart(3, '0')}`,
          `# Many ${i}\n\nmanyword\n`,
        ),
      );
    }
    await rebuildSearchIndex(dir);
    const paths = await searchProjectReadmes(dir, 'manyword');
    expect(paths.length).toBe(120);
    expect(new Set(paths)).toEqual(new Set(expected));
  });
});
