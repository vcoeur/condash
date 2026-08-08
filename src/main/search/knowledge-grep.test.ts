/**
 * Tests for the knowledge body-file grep.
 *
 * The behaviour these pin is the fix for a real miss: a multi-word query used to
 * be matched as one literal phrase, so a question phrased in the reader's own
 * words found nothing even when the answer was one token away.
 */
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { grepKnowledgeBodies } from './knowledge-grep';

let conceptionPath: string;
let knowledgeRoot: string;

async function writeBody(relPath: string, content: string): Promise<void> {
  const full = join(knowledgeRoot, relPath);
  await fs.mkdir(join(full, '..'), { recursive: true });
  await fs.writeFile(full, content, 'utf8');
}

beforeEach(async () => {
  conceptionPath = await mkdtemp(join(tmpdir(), 'condash-grep-'));
  knowledgeRoot = join(conceptionPath, 'knowledge');
  await fs.mkdir(knowledgeRoot, { recursive: true });
});

afterEach(async () => {
  await rm(conceptionPath, { recursive: true, force: true });
});

describe('grepKnowledgeBodies', () => {
  it('matches a multi-word query token by token, not as a literal phrase', async () => {
    // The exact phrase appears in no file — matching it literally found nothing,
    // which is the miss this function exists to fix. `overlay` is spread around
    // so the rare `focusin` is what carries the query.
    await writeBody('topics/menu.md', '# Menu\n\nThe focusin event misses body.\n');
    await writeBody('topics/peek.md', '# Peek\n\nAn overlay card.\n');
    await writeBody('topics/modal.md', '# Modal\n\nAnother overlay.\n');
    const matches = await grepKnowledgeBodies(
      knowledgeRoot,
      conceptionPath,
      'focusin overlay dismissal',
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].snippet).toMatch(/focusin/);
    expect(matches[0].relPath).toBe('knowledge/topics/menu.md');
  });

  it('ranks a line carrying more query tokens above one carrying fewer', async () => {
    await writeBody('topics/one.md', '# One\n\nalpha alone.\n');
    await writeBody('topics/two.md', '# Two\n\nalpha and beta together.\n');
    const matches = await grepKnowledgeBodies(knowledgeRoot, conceptionPath, 'alpha beta');
    expect(matches[0].relPath).toBe('knowledge/topics/two.md');
    expect(matches[0].score).toBeGreaterThan(matches[1].score);
  });

  it('ranks an exact-phrase line above one that merely has both tokens', async () => {
    await writeBody('topics/split.md', '# Split\n\nalpha then later beta.\n');
    await writeBody('topics/exact.md', '# Exact\n\nalpha beta as written.\n');
    const matches = await grepKnowledgeBodies(knowledgeRoot, conceptionPath, 'alpha beta');
    expect(matches[0].relPath).toBe('knowledge/topics/exact.md');
  });

  it('ranks the rare token above the one in every file', async () => {
    // `review` is in every file; `focusin` in one. The useful hit must lead
    // even though both lines match a query token.
    await writeBody('topics/a.md', '# A\n\nreview notes.\n');
    await writeBody('topics/b.md', '# B\n\nreview notes.\n');
    await writeBody('topics/c.md', '# C\n\nreview notes and focusin.\n');
    const matches = await grepKnowledgeBodies(knowledgeRoot, conceptionPath, 'review focusin');
    expect(matches[0].relPath).toBe('knowledge/topics/c.md');
    expect(matches[0].score).toBeGreaterThan(matches[1].score);
  });

  it('weights a token in one file above the same token spread across many', async () => {
    await writeBody('topics/rare.md', '# Rare\n\nzebra sighting.\n');
    for (const name of ['a', 'b', 'c', 'd']) {
      await writeBody(`topics/${name}.md`, `# ${name}\n\ncommon sighting.\n`);
    }
    const rare = await grepKnowledgeBodies(knowledgeRoot, conceptionPath, 'zebra');
    const common = await grepKnowledgeBodies(knowledgeRoot, conceptionPath, 'common');
    expect(rare[0].score).toBeGreaterThan(common[0].score);
  });

  it('finds an inflection the query did not use', async () => {
    // Nobody searches in the tense the author wrote. Exact substring matching
    // ranked the one relevant line 64th of 67 on the real tree.
    await writeBody('topics/menu.md', '# Menu\n\nThe card being dismissed re-arms itself.\n');
    const matches = await grepKnowledgeBodies(knowledgeRoot, conceptionPath, 'dismissal');
    expect(matches.length).toBe(1);
    expect(matches[0].snippet).toMatch(/dismissed/);
  });

  it('does not stem a short token into a broader one', async () => {
    await writeBody('topics/a.md', '# A\n\nthe undo path.\n');
    await writeBody('topics/b.md', '# B\n\nan undocumented flag.\n');
    const matches = await grepKnowledgeBodies(knowledgeRoot, conceptionPath, 'undo');
    // `undo` is 4 chars, matched whole — but as a substring it still reaches
    // `undocumented`, which is the documented cost of substring matching.
    expect(matches.length).toBe(2);
  });

  it('honours the limit', async () => {
    await writeBody('topics/many.md', '# Many\n\nzebra\nzebra\nzebra\n');
    const matches = await grepKnowledgeBodies(knowledgeRoot, conceptionPath, 'zebra', 2);
    expect(matches.length).toBe(2);
  });

  it('returns nothing for a whitespace-only query', async () => {
    await writeBody('topics/a.md', '# A\n\nzebra.\n');
    expect(await grepKnowledgeBodies(knowledgeRoot, conceptionPath, '   ')).toEqual([]);
  });
});
