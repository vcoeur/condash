import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { knowledgeStrategy } from './index-knowledge';
import { projectsStrategy } from './index-projects';
import { regenerateIndex } from './index-tree';

let conceptionDir: string;
let knowledgeDir: string;

beforeEach(async () => {
  conceptionDir = await mkdtemp(join(tmpdir(), 'condash-index-test-'));
  knowledgeDir = join(conceptionDir, 'knowledge');
  await fs.mkdir(knowledgeDir, { recursive: true });
});

afterEach(async () => {
  await rm(conceptionDir, { recursive: true, force: true });
});

async function writeFile(relPath: string, content: string): Promise<void> {
  const abs = join(conceptionDir, relPath);
  await fs.mkdir(join(abs, '..'), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
}

async function readFile(relPath: string): Promise<string> {
  return fs.readFile(join(conceptionDir, relPath), 'utf8');
}

describe('regenerateIndex (knowledge strategy)', () => {
  describe('drafted-leaf marker', () => {
    it('emits the <!-- draft --> marker on every newly-drafted leaf bullet', async () => {
      await writeFile(
        'knowledge/topics/index.md',
        '# Topics\n\nCross-cutting subjects.\n\n## Current files\n',
      );
      await writeFile(
        'knowledge/topics/sandbox-testing.md',
        '# Sandbox testing\n\nHow to drive vcoeur apps from the sandbox.\n\n## Recipe\n\nCall `condash run`.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy);

      const index = await readFile('knowledge/topics/index.md');
      expect(index).toMatch(
        /- \[`sandbox-testing\.md`\]\(sandbox-testing\.md\) — \*[^*]+\*\s+`\[[^\]]+\]` <!-- draft -->/,
      );
    });

    it('idempotent: running twice produces zero diff', async () => {
      await writeFile(
        'knowledge/topics/index.md',
        '# Topics\n\nCross-cutting subjects.\n\n## Current files\n',
      );
      await writeFile(
        'knowledge/topics/sandbox-testing.md',
        '# Sandbox testing\n\nHow to drive vcoeur apps.\n\n## Recipe\n\nCall the binary.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after1 = await readFile('knowledge/topics/index.md');
      const report = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after2 = await readFile('knowledge/topics/index.md');

      expect(after1).toBe(after2);
      expect(report.updated).toEqual([]);
      expect(report.created).toEqual([]);
    });
  });

  describe('tag-quality filter on initial draft', () => {
    it('strips stop-words and content-free verbs from H2-derived tags', async () => {
      await writeFile(
        'knowledge/topics/index.md',
        '# Topics\n\nCross-cutting subjects.\n\n## Current files\n',
      );
      await writeFile(
        'knowledge/topics/legal-privacy.md',
        // Headings that would slugify to junk: `the`, `summary`, `develop`,
        // `notes`, `2026-04`. Plus one good heading.
        '# Legal and privacy\n\nLegal pages and CNIL rules.\n\n## The summary\n\n## Develop\n\n## Notes\n\n## 2026-04\n\n## Caddy access log retention\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const index = await readFile('knowledge/topics/index.md');

      expect(index).not.toMatch(/\bthe\b/i);
      expect(index).not.toMatch(/\bsummary\b/i);
      expect(index).not.toMatch(/\bdevelop\b/i);
      expect(index).not.toMatch(/\b2026-04\b/);
      // Good heading survives, slug form is hyphenated.
      expect(index).toContain('caddy');
    });
  });

  describe('aggregation cap + curated/drafted distinction', () => {
    it('caps drafted subdir-bullet aggregation at 8 and surfaces the surplus', async () => {
      // Build a subtree under topics/ with 12 distinct legit tags spread
      // across 12 leaves (one tag each). When regenerating the root, the
      // drafted topics/ bullet must be capped at 8 with the rest in
      // overTagDropped.
      const tags = [
        'sandbox-testing',
        'caddy-access-log',
        'port-range-11111',
        'electron-builder',
        'pii-stripping',
        'condash',
        'playwright',
        'postgres-ports',
        'vite-config',
        'drizzle-kit',
        'github-pages',
        'tauri-action',
      ];
      await writeFile('knowledge/index.md', '# Knowledge\n\nRoot.\n\n## Structure\n');
      await writeFile('knowledge/topics/index.md', '# Topics\n\nIntro.\n\n## Current files\n');
      for (const tag of tags) {
        // Each leaf has a single H2 heading whose slug = the tag (single
        // token), forcing exactly one mined keyword per file.
        const h2 = tag.replace(/-/g, ' ');
        await writeFile(
          `knowledge/topics/${tag}.md`,
          `# ${h2}\n\nIntro for ${tag}.\n\n## ${h2}\n\nBody.\n`,
        );
      }

      const report = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const rootIndex = await readFile('knowledge/index.md');

      // The topics/ bullet should be present and capped.
      const bulletMatch = rootIndex.match(/- \[`topics\/`\][^\n]+/);
      expect(bulletMatch).not.toBeNull();
      const bullet = bulletMatch![0];
      const tagBlock = bullet.match(/`\[([^\]]+)\]`/);
      expect(tagBlock).not.toBeNull();
      const written = tagBlock![1].split(',').map((s) => s.trim());
      expect(written.length).toBe(8);

      // Report surfaces the dropped surplus on the topics/ bullet.
      const drop = report.overTagDropped.find((o) => o.entry === 'topics/');
      expect(drop).toBeDefined();
      expect(drop!.dropped.length).toBe(tags.length - 8);
    });

    it('leaves curated subdir bullets (no marker) untouched even when descendants change', async () => {
      // Hand-curated bullet: no marker, exactly two tags.
      await writeFile(
        'knowledge/index.md',
        '# Knowledge\n\nRoot.\n\n## Structure\n\n- [`topics/`](topics/index.md) — *cross-cutting topics.* `[curated-tag-one, curated-tag-two]`\n',
      );
      await writeFile('knowledge/topics/index.md', '# Topics\n\nIntro.\n\n## Current files\n');
      await writeFile(
        'knowledge/topics/sandbox-testing.md',
        '# Sandbox testing\n\nDrive apps from the sandbox.\n\n## Recipe\n\nDoes things.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const rootIndex = await readFile('knowledge/index.md');
      // Curated bullet preserved verbatim — no marker introduced, no descendant tags merged.
      expect(rootIndex).toContain(
        '- [`topics/`](topics/index.md) — *cross-cutting topics.* `[curated-tag-one, curated-tag-two]`',
      );
      expect(rootIndex).not.toContain('sandbox-testing');
      expect(rootIndex).not.toContain('<!-- draft -->');
    });

    it('--rewrite-aggregated promotes curated bullets to drafted and re-derives tags', async () => {
      await writeFile(
        'knowledge/index.md',
        '# Knowledge\n\nRoot.\n\n## Structure\n\n- [`topics/`](topics/index.md) — *cross-cutting topics.* `[stale-tag]`\n',
      );
      await writeFile('knowledge/topics/index.md', '# Topics\n\nIntro.\n\n## Current files\n');
      await writeFile(
        'knowledge/topics/sandbox-testing.md',
        '# Sandbox testing\n\nDrive apps from the sandbox.\n\n## Caddy access log\n\nSomething.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy, { rewriteAggregated: true });
      const rootIndex = await readFile('knowledge/index.md');

      // Marker added, stale-tag removed, descendant tags surfaced.
      expect(rootIndex).toContain('<!-- draft -->');
      expect(rootIndex).not.toContain('stale-tag');
      expect(rootIndex).toMatch(/topics\/.*caddy/);
    });

    it('drafted subdir bullet tracked across runs gets re-derived (junk leaks are healed)', async () => {
      // Initial run drafts the topics/ bullet (no on-disk bullet → engine
      // creates one with the marker).
      await writeFile('knowledge/index.md', '# Knowledge\n\nRoot.\n\n## Structure\n');
      await writeFile('knowledge/topics/index.md', '# Topics\n\nIntro.\n\n## Current files\n');
      await writeFile(
        'knowledge/topics/sandbox-testing.md',
        '# Sandbox testing\n\nFirst.\n\n## Caddy access log\n\nBody.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after1 = await readFile('knowledge/index.md');
      expect(after1).toContain('<!-- draft -->');

      // Add a second leaf with a junk tag at the source. Re-run: the junk
      // doesn't make it into the parent because the filter rejects it.
      await writeFile(
        'knowledge/topics/observability.md',
        '# Observability\n\nMetrics.\n\n## The summary\n\n## Caddy access log\n\nMore.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after2 = await readFile('knowledge/index.md');
      expect(after2).not.toMatch(/\b(?:the|summary)\b/i);
    });
  });

  describe('curated leaf bullet preserved', () => {
    it('does not touch curated leaf bullet (no marker) when re-running', async () => {
      await writeFile(
        'knowledge/topics/index.md',
        '# Topics\n\nIntro.\n\n## Current files\n\n- [`sandbox-testing.md`](sandbox-testing.md) — *Curated description.* `[curated-a, curated-b]`\n',
      );
      await writeFile(
        'knowledge/topics/sandbox-testing.md',
        '# Sandbox testing\n\nNew body.\n\n## Some heading\n\nText.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const index = await readFile('knowledge/topics/index.md');
      expect(index).toContain(
        '- [`sandbox-testing.md`](sandbox-testing.md) — *Curated description.* `[curated-a, curated-b]`',
      );
    });

    it('matches a bullet that carries a trailing curated HTML comment (no duplicate)', async () => {
      // Repro for issue #83: a curated bullet ending in `<!-- TBC -->` was
      // not recognised by the parser, so a re-run drafted a duplicate entry.
      await writeFile(
        'knowledge/topics/index.md',
        '# Topics\n\nIntro.\n\n## Current files\n\n- [`sandbox-testing.md`](sandbox-testing.md) — *Curated description.* `[curated-a]` <!-- TBC -->\n',
      );
      await writeFile(
        'knowledge/topics/sandbox-testing.md',
        '# Sandbox testing\n\nBody.\n\n## Recipe\n\nText.\n',
      );

      const report = await regenerateIndex(conceptionDir, knowledgeStrategy, { dryRun: true });
      // Dry-run must not surface `sandbox-testing.md` as `added` — the
      // existing entry matches in spite of the trailing HTML comment.
      const addedToTopics = report.updated
        .filter((u) => u.indexPath === 'knowledge/topics/index.md')
        .flatMap((u) => u.added);
      expect(addedToTopics).toEqual([]);

      // Real run: the curated bullet (with the trailing comment) is preserved
      // verbatim, no duplicate is introduced.
      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const index = await readFile('knowledge/topics/index.md');
      expect(index).toContain(
        '- [`sandbox-testing.md`](sandbox-testing.md) — *Curated description.* `[curated-a]` <!-- TBC -->',
      );
      // Only one bullet for this file.
      const occurrences = index.match(/sandbox-testing\.md/g) ?? [];
      // One in the link text, one in the URL → two on the single bullet line.
      expect(occurrences.length).toBe(2);
    });
  });
});

describe('regenerateIndex (projects strategy)', () => {
  describe('YAML-frontmatter item tags', () => {
    // Regression test for the bug filed in conception incident
    // 2026-05-09-condash-projects-index-yaml-tags. After the v2.16.0 YAML
    // migration, item-folder bullets in projects/YYYY-MM/index.md were
    // re-derived from the engine's descendant-aggregate map — but the
    // engine never recurses into item folders (they have no `index.md`),
    // so the aggregate was empty and tags came out as `[]`. The fix
    // re-routes leaf-item tags through `strategy.draftSubdirEntry`, which
    // reads the README via `parseHeader` and produces kind/status/apps.

    async function writeProjectsTree(): Promise<void> {
      await writeFile(
        'projects/2026-05/2026-05-09-feature/README.md',
        [
          '---',
          'date: 2026-05-09',
          'kind: project',
          'status: now',
          'apps:',
          '  - condash',
          '  - vcoeur.com',
          '---',
          '',
          '# Feature',
          '',
          '## Goal',
          '',
          'Ship a thing.',
          '',
        ].join('\n'),
      );
    }

    it('drafts an item bullet with kind/status/app tags from YAML frontmatter', async () => {
      await writeProjectsTree();
      await regenerateIndex(conceptionDir, projectsStrategy);
      const monthIndex = await readFile('projects/2026-05/index.md');
      // Tags must lead with kind, status, then app slugs.
      expect(monthIndex).toMatch(
        /- \[`2026-05-09-feature\/`\][^\n]+\*[^*]+\*\s+`\[project, now, condash, vcoeur-com\]`/,
      );
    });

    it('is idempotent: a second pass leaves the month and root indexes unchanged', async () => {
      await writeProjectsTree();
      await regenerateIndex(conceptionDir, projectsStrategy);
      const monthBefore = await readFile('projects/2026-05/index.md');
      const rootBefore = await readFile('projects/index.md');
      const second = await regenerateIndex(conceptionDir, projectsStrategy);
      expect(second.updated).toEqual([]);
      const monthAfter = await readFile('projects/2026-05/index.md');
      const rootAfter = await readFile('projects/index.md');
      expect(monthAfter).toBe(monthBefore);
      expect(rootAfter).toBe(rootBefore);
    });

    it('rolls item tags up to the month aggregate in a single pass', async () => {
      await writeProjectsTree();
      await regenerateIndex(conceptionDir, projectsStrategy);
      const rootIndex = await readFile('projects/index.md');
      // The month bullet's tag list must include at least one of the
      // items' tags — proves the aggregate sees the descendants on the
      // first pass.
      expect(rootIndex).toMatch(/- \[`2026-05\/`\][^\n]+`\[[^\]]*condash[^\]]*\]`/);
    });
  });

  describe('bullet stability when description carries bracket characters', () => {
    // Regression test for conception incident
    // 2026-05-23-condash-index-bullet-slug-reappend (vcoeur/condash#NNN).
    //
    // The original replaceTagsInBullet regex `/\s*`?\[[^\]]*\]`?\s*$/` allowed
    // the optional-backtick tag block to start matching from a `[` inside the
    // description text. When a project's auto-drafted description contained
    // an unclosed `[` (e.g. a clipped `["@<name>"]` cut mid-token), the
    // regex's leftmost match swallowed the closing italic `*` and the real
    // tag block, leaving a malformed bullet with no closing italic. On the
    // next regen, matchBullet failed on the malformed line and a fresh
    // duplicate was appended — unbounded, one per run.
    it("doesn't corrupt or duplicate bullets whose description gets clipped mid-`[`", async () => {
      // The repro case from the conception incident: a description over
      // 200 chars whose tail array `["@condash"]` is split by clip(200)
      // — the clipped desc ends with `[` and no matching `]`, which used
      // to confuse the tag-block regex into eating the closing italic.
      // A status change between pass 1 and pass 2 forces a tag-block
      // rewrite (the only path that exercises replaceTagsInBullet on a
      // mutated raw), so the bug fires.
      const filler =
        'A description engineered so the 200-char clip ends inside a bracketed array, in just the right place ' +
        'to mirror the original conception case: worktrees setup <branch>, empty created[], notPresent: ';
      const longDesc = filler + '["@condash"] and the bare repo lookup misses.';
      const writeReadme = async (status: string): Promise<void> => {
        await writeFile(
          'projects/2026-05/2026-05-14-bracket-bug/README.md',
          [
            '---',
            'date: 2026-05-14',
            'kind: incident',
            `status: ${status}`,
            'apps:',
            '  - condash',
            '---',
            '',
            '# Bracket bug',
            '',
            '## Description',
            '',
            longDesc,
            '',
          ].join('\n'),
        );
      };

      // Pass 1 with status=now drafts a well-formed bullet.
      await writeReadme('now');
      await regenerateIndex(conceptionDir, projectsStrategy);
      const after1 = await readFile('projects/2026-05/index.md');
      const bracketLines1 = after1.match(/^- \[`2026-05-14-bracket-bug.*$/gm) ?? [];
      expect(bracketLines1).toHaveLength(1);
      expect(bracketLines1[0]).toMatch(/— \*[^\n]+\*\.?\s*`\[[^\]]+\]`/);

      // Flip status; pass 2 must re-render the bullet without corrupting
      // the description tail. With the buggy regex this drops the
      // closing italic and the tag block re-attaches mid-description.
      await writeReadme('done');
      await regenerateIndex(conceptionDir, projectsStrategy);
      const after2 = await readFile('projects/2026-05/index.md');
      const bracketLines2 = after2.match(/^- \[`2026-05-14-bracket-bug.*$/gm) ?? [];
      expect(bracketLines2).toHaveLength(1);
      // Closing italic must still be present, with the new tag block
      // immediately after it.
      expect(bracketLines2[0]).toMatch(/— \*[^\n]+\*\.?\s*`\[[^\]]+\]`/);
      expect(bracketLines2[0]).toContain('`[incident, done, condash]`');

      // Pass 3 must be a no-op.
      const report3 = await regenerateIndex(conceptionDir, projectsStrategy);
      const after3 = await readFile('projects/2026-05/index.md');
      expect(after3).toBe(after2);
      expect(report3.updated).toEqual([]);
    });

    it('collapses pre-existing duplicate bullets for the same folder on the next regen', async () => {
      // Simulates an index that already accumulated duplicates from the
      // old bug. After the fix, a single regen should keep one bullet per
      // folder (the engine de-dups by canonical name).
      await writeFile(
        'projects/2026-05/2026-05-14-bracket-bug/README.md',
        [
          '---',
          'date: 2026-05-14',
          'kind: incident',
          'status: done',
          'apps:',
          '  - condash',
          '---',
          '',
          '# Bracket bug',
          '',
          '## Description',
          '',
          'Worktrees setup <branch> path with notPresent: ["@condash"] tail.',
          '',
        ].join('\n'),
      );
      // Hand-write a corrupted index with three duplicate bullets (one
      // well-formed and two malformed — the malformed ones mirror the
      // shape the buggy replaceTagsInBullet used to produce: no closing
      // italic).
      await writeFile(
        'projects/2026-05/index.md',
        [
          '# 2026-05',
          '',
          'Items.',
          '',
          '## Items',
          '',
          '- [`2026-05-14-bracket-bug/`](2026-05-14-bracket-bug/README.md) — *Worktrees setup <branch> path with notPresent: ["@condash"] tail.* `[incident, done, condash]`',
          '- [`2026-05-14-bracket-bug/`](2026-05-14-bracket-bug/README.md) — *Worktrees setup <branch> path with notPresent: `[incident, done, condash]`',
          '- [`2026-05-14-bracket-bug/`](2026-05-14-bracket-bug/README.md) — *Worktrees setup <branch> path with notPresent: `[incident, done, condash]`',
          '',
        ].join('\n'),
      );

      await regenerateIndex(conceptionDir, projectsStrategy);
      const after = await readFile('projects/2026-05/index.md');
      const matches = after.match(/^- \[`2026-05-14-bracket-bug.*$/gm) ?? [];
      expect(matches.length).toBe(1);
    });
  });
});
