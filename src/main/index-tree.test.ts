import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { knowledgeStrategy } from './index-knowledge';
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
