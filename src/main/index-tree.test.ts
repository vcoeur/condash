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

  describe('drafted file bullet re-derivation', () => {
    it('re-derives a drafted file bullet when the body changes (tags AND description)', async () => {
      await writeFile('knowledge/topics/index.md', '# Topics\n\nIntro.\n\n## Current files\n');
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nInitial description text.\n\n## First heading\n\nBody.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after1 = await readFile('knowledge/topics/index.md');
      expect(after1).toContain('Initial description text');
      expect(after1).toContain('first');
      expect(after1).toContain('<!-- draft -->');

      // Change the body: a new lead paragraph AND a new heading. The drafted
      // file bullet must be re-rendered in full — new description and new
      // tags — with the marker retained.
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nChanged description text.\n\n## Second heading\n\nBody.\n',
      );
      const report2 = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after2 = await readFile('knowledge/topics/index.md');

      expect(after2).toContain('Changed description text');
      expect(after2).not.toContain('Initial description text');
      expect(after2).toContain('second');
      expect(after2).not.toContain('first');
      expect(after2).toContain('<!-- draft -->');
      const row2 = report2.updated.find((u) => u.indexPath === 'knowledge/topics/index.md');
      expect(row2).toBeDefined();
      expect(row2!.tagsAdded.some((t) => t.entry === 'drafting.md')).toBe(true);
    });

    it('re-renders a drafted file bullet on a description-only body change', async () => {
      await writeFile('knowledge/topics/index.md', '# Topics\n\nIntro.\n\n## Current files\n');
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nOriginal lead paragraph.\n\n## Stable heading\n\nBody.\n',
      );
      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after1 = await readFile('knowledge/topics/index.md');
      expect(after1).toContain('Original lead paragraph');

      // Only the lead paragraph changes; the heading (and therefore the tag
      // set) stays identical. The full-render semantics must still reach disk.
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nRewritten lead paragraph.\n\n## Stable heading\n\nBody.\n',
      );
      const report2 = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after2 = await readFile('knowledge/topics/index.md');

      expect(after2).toContain('Rewritten lead paragraph');
      expect(after2).not.toContain('Original lead paragraph');
      const row2 = report2.updated.find((u) => u.indexPath === 'knowledge/topics/index.md');
      expect(row2).toBeDefined();
    });

    it('leaves a curated file bullet untouched even when the body changes', async () => {
      // Curated bullet (no marker) carrying junk tags that the filter now
      // rejects: the engine must NOT re-derive it — the marker is the whole
      // ownership signal.
      await writeFile(
        'knowledge/topics/index.md',
        '# Topics\n\nIntro.\n\n## Current files\n\n- [`drafting.md`](drafting.md) — *Curated description.* `[data-, 66ms]`\n',
      );
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nCompletely new body.\n\n## New heading\n\nBody.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const index = await readFile('knowledge/topics/index.md');
      expect(index).toContain(
        '- [`drafting.md`](drafting.md) — *Curated description.* `[data-, 66ms]`',
      );
      expect(index).not.toContain('<!-- draft -->');
    });

    it('produces no churn when an unchanged drafted file bullet is regenerated', async () => {
      await writeFile('knowledge/topics/index.md', '# Topics\n\nIntro.\n\n## Current files\n');
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nStable description text.\n\n## Stable heading\n\nBody.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after1 = await readFile('knowledge/topics/index.md');
      const report2 = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after2 = await readFile('knowledge/topics/index.md');

      expect(after2).toBe(after1);
      expect(report2.updated).toEqual([]);
    });

    it('leaves a curated row carrying a trailing annotation untouched', async () => {
      // Curated rows (no marker) are the supported home for human
      // annotations: a `<!-- TBC -->` on a curated row must survive a regen
      // with a changed body — comment and description intact.
      await writeFile(
        'knowledge/topics/index.md',
        '# Topics\n\nIntro.\n\n## Current files\n\n- [`drafting.md`](drafting.md) — *Curated description.* `[curated-tag]` <!-- TBC -->\n',
      );
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nCompletely new body.\n\n## New heading\n\nBody.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const index = await readFile('knowledge/topics/index.md');
      expect(index).toContain(
        '- [`drafting.md`](drafting.md) — *Curated description.* `[curated-tag]` <!-- TBC -->',
      );
      expect(index).not.toContain('<!-- draft -->');
    });

    it('drops a stray trailing comment when re-deriving a drafted row', async () => {
      // Drafted rows are auto-managed: a stray `<!-- TBC -->` before the
      // marker is dropped on re-derivation — the engine emits
      // `body + tag block + marker` and owns the whole line.
      await writeFile(
        'knowledge/topics/index.md',
        '# Topics\n\nIntro.\n\n## Current files\n\n- [`drafting.md`](drafting.md) — *Old description.* `[old-tag]` <!-- TBC --> <!-- draft -->\n',
      );
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nNew description text.\n\n## New heading\n\nBody.\n',
      );

      const report = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after1 = await readFile('knowledge/topics/index.md');
      expect(after1).toMatch(
        /- \[`drafting\.md`\]\(drafting\.md\) — \*New description text\.\* `\[[^\]]+\]` <!-- draft -->$/m,
      );
      expect(after1).not.toContain('<!-- TBC -->');
      expect((after1.match(/<!-- draft -->/g) ?? []).length).toBe(1);
      const row = report.updated.find((u) => u.indexPath === 'knowledge/topics/index.md');
      expect(row).toBeDefined();

      // Converges: re-rendering the dropped output changes nothing.
      const report2 = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after2 = await readFile('knowledge/topics/index.md');
      expect(after2).toBe(after1);
      expect(report2.updated).toEqual([]);
    });

    it('never touches interior HTML comments inside a curated description', async () => {
      // Round-3 regression: interior `<!-- ... -->` runs inside a description
      // are description text. The end-anchored parse strips cannot match
      // them, so the curated row must survive byte-identical — no loose
      // repair, no marker added, no rewrite.
      const curatedLine =
        '- [`drafting.md`](drafting.md) — *text <!-- A --> <!-- B --> more text.* `[curated-tag]`';
      await writeFile(
        'knowledge/topics/index.md',
        `# Topics\n\nIntro.\n\n## Current files\n\n${curatedLine}\n`,
      );
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nCompletely new body.\n\n## New heading\n\nBody.\n',
      );

      const report = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const index = await readFile('knowledge/topics/index.md');
      expect(index).toContain(curatedLine);
      expect(index).not.toContain('<!-- draft -->');
      const row = report.updated.find((u) => u.indexPath === 'knowledge/topics/index.md');
      expect(row).toBeUndefined();
    });

    it('leaves a curated row with an interior comment AND a trailing annotation untouched', async () => {
      // Round-4 blocker: the parse-side strip must match ONLY the trailing
      // `<!-- TBC -->` — never cross the interior `<!-- A -->`'s `-->` to
      // reach it (the tempered dot stops at the first `-->`). The interior
      // comment stays description text and the row survives byte-identical:
      // no loose repair, no marker added.
      const curatedLine =
        '- [`drafting.md`](drafting.md) — *text <!-- A --> more text.* `[tag]` <!-- TBC -->';
      await writeFile(
        'knowledge/topics/index.md',
        `# Topics\n\nIntro.\n\n## Current files\n\n${curatedLine}\n`,
      );
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nCompletely new body.\n\n## New heading\n\nBody.\n',
      );

      const report = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const index = await readFile('knowledge/topics/index.md');
      expect(index).toContain(curatedLine);
      expect(index).not.toContain('<!-- draft -->');
      const row = report.updated.find((u) => u.indexPath === 'knowledge/topics/index.md');
      expect(row).toBeUndefined();
    });

    it('rolls a re-derived file bullet tag up to the parent subdir bullet on the same pass', async () => {
      await writeFile('knowledge/index.md', '# Knowledge\n\nRoot.\n\n## Structure\n');
      await writeFile('knowledge/topics/index.md', '# Topics\n\nIntro.\n\n## Current files\n');
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nBody.\n\n## Alpha heading\n\nText.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after1 = await readFile('knowledge/index.md');
      expect(after1).toContain('alpha');

      // Change the file's heading: the corrected tag must reach the root's
      // topics/ bullet in the SAME pass (the file re-derivation mutates the
      // file bullet's tags before the parent aggregate is built).
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nBody.\n\n## Beta heading\n\nText.\n',
      );
      const report2 = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after2 = await readFile('knowledge/index.md');
      expect(after2).toContain('beta');
      expect(after2).not.toContain('alpha');
      const row2 = report2.updated.find((u) => u.indexPath === 'knowledge/index.md');
      expect(row2).toBeDefined();
    });

    it('repairs a loose (malformed) file bullet via the re-derivation path', async () => {
      await writeFile(
        'knowledge/topics/index.md',
        '# Topics\n\nIntro.\n\n## Current files\n\n- [`drafting.md`](drafting.md)\n',
      );
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nRepaired description.\n\n## Some heading\n\nBody.\n',
      );

      const report = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const index = await readFile('knowledge/topics/index.md');

      // The malformed line is rebuilt from a fresh draft with the marker.
      expect(index).toMatch(
        /- \[`drafting\.md`\]\(drafting\.md\) — \*Repaired description\.\* `\[[^\]]+\]` <!-- draft -->/,
      );
      expect(index).not.toContain('- [`drafting.md`](drafting.md)\n');
      const row = report.updated.find((u) => u.indexPath === 'knowledge/topics/index.md');
      expect(row).toBeDefined();
    });

    it('--rewrite-aggregated leaves a curated file bullet untouched', async () => {
      await writeFile(
        'knowledge/topics/index.md',
        '# Topics\n\nIntro.\n\n## Current files\n\n- [`drafting.md`](drafting.md) — *Curated description.* `[curated-tag]`\n',
      );
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nCompletely new body.\n\n## New heading\n\nBody.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy, { rewriteAggregated: true });
      const index = await readFile('knowledge/topics/index.md');
      expect(index).toContain(
        '- [`drafting.md`](drafting.md) — *Curated description.* `[curated-tag]`',
      );
      expect(index).not.toContain('<!-- draft -->');
    });

    it('keeps draft ownership across body changes (three-run lifecycle)', async () => {
      await writeFile('knowledge/topics/index.md', '# Topics\n\nIntro.\n\n## Current files\n');
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nRun one description.\n\n## First heading\n\nBody.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after1 = await readFile('knowledge/topics/index.md');
      expect(after1).toContain('Run one description');
      expect(after1).toMatch(/<!-- draft -->\s*$/m);

      // Run 2 with ANOTHER body change: the drafted row re-derives again
      // (the marker is at line end, so ownership is unambiguous).
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nRun two description.\n\n## Second heading\n\nBody.\n',
      );
      const report2 = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after2 = await readFile('knowledge/topics/index.md');
      expect(after2).toContain('Run two description');
      expect(after2).toContain('second');
      expect(after2).not.toContain('first');
      expect((after2.match(/<!-- draft -->/g) ?? []).length).toBe(1);
      const row2 = report2.updated.find((u) => u.indexPath === 'knowledge/topics/index.md');
      expect(row2).toBeDefined();

      // Run 3 with no change: byte-identical, no churn.
      const report3 = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after3 = await readFile('knowledge/topics/index.md');
      expect(after3).toBe(after2);
      expect(report3.updated).toEqual([]);
    });

    it('emits exactly one draft marker and stays stable on the canonical row', async () => {
      // The post-drop shape (`body + tag block + marker`): re-rendering it
      // must reproduce the identical line — no double marker, no churn.
      await writeFile(
        'knowledge/topics/index.md',
        '# Topics\n\nIntro.\n\n## Current files\n\n- [`drafting.md`](drafting.md) — *Stable description.* `[stable, tag]` <!-- draft -->\n',
      );
      await writeFile(
        'knowledge/topics/drafting.md',
        '# Drafting\n\nStable description.\n\n## Stable tag\n\nBody.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after1 = await readFile('knowledge/topics/index.md');
      expect((after1.match(/<!-- draft -->/g) ?? []).length).toBe(1);
      expect(after1).toMatch(/<!-- draft -->\s*$/m);

      const report2 = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after2 = await readFile('knowledge/topics/index.md');
      expect(after2).toBe(after1);
      expect(report2.updated).toEqual([]);
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

    it('drafted subdir row with a stray comment converges to canonical form', async () => {
      // Round-4 blocker: replaceTagsInBullet must drop the stray `<!-- TBC -->`
      // (marker first, then trailing comments one at a time) BEFORE replacing
      // the tag block, so the row converges to `body + new tag block + marker`
      // instead of embedding the comment mid-line forever.
      await writeFile(
        'knowledge/index.md',
        '# Knowledge\n\nRoot.\n\n## Structure\n\n- [`topics/`](topics/index.md) — *Intro.* `[alpha]` <!-- TBC --> <!-- draft -->\n',
      );
      await writeFile('knowledge/topics/index.md', '# Topics\n\nIntro.\n\n## Current files\n');
      await writeFile(
        'knowledge/topics/a-leaf.md',
        '# A leaf\n\nBody.\n\n## Beta heading\n\nText.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after1 = await readFile('knowledge/index.md');
      expect(after1).toMatch(
        /- \[`topics\/`\]\(topics\/index\.md\) — \*Intro\.\* `\[[^\]]+\]` <!-- draft -->$/m,
      );
      expect(after1).not.toContain('<!-- TBC -->');
      expect(after1).toContain('beta');
      expect(after1).not.toContain('alpha');
      expect((after1.match(/<!-- draft -->/g) ?? []).length).toBe(1);

      // Second regenerate: byte-identical, no churn.
      const report2 = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after2 = await readFile('knowledge/index.md');
      expect(after2).toBe(after1);
      expect(report2.updated).toEqual([]);
    });

    it('omits the tag block on a drafted subdir row whose aggregate is empty (write-side parity)', async () => {
      // Closing-pass finding: replaceTagsInBullet always emitted `` `[]` `` while
      // formatBullet omits the block for empty keywords — divergent canonical
      // forms and one-time churn. A date-named leaf aggregates to zero tags
      // (its filename fallback is filtered), so the subdir row must render
      // without any tag block and stay byte-stable.
      await writeFile(
        'knowledge/index.md',
        '# Knowledge\n\nRoot.\n\n## Structure\n\n- [`topics/`](topics/index.md) — *Intro.* `[old]` <!-- draft -->\n',
      );
      // The leaf bullet is pre-written so the engine never adds a bucket
      // heading (`## Current files`) to the subdir index: with no H2/H3 and no
      // code spans in the head, the empty-aggregate fallback
      // (`deriveSubdirKeywords`) must also yield nothing.
      await writeFile(
        'knowledge/topics/index.md',
        '# Topics\n\nIntro.\n\n- [`2026-04.md`](2026-04.md) — *Dated leaf.* <!-- draft -->\n',
      );
      await writeFile('knowledge/topics/2026-04.md', '# Dated leaf\n\nBody.\n');

      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after1 = await readFile('knowledge/index.md');
      expect(after1).toMatch(
        /- \[`topics\/`\]\(topics\/index\.md\) — \*Intro\.\* <!-- draft -->$/m,
      );
      expect(after1).not.toContain('`[]`');

      // Second regenerate: byte-identical, no churn.
      const report2 = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const after2 = await readFile('knowledge/index.md');
      expect(after2).toBe(after1);
      expect(report2.updated).toEqual([]);
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

  describe('body bullets under the H1 (no `## heading`)', () => {
    it('writes a new body-file bullet into the prologue, not just reporting it as added', async () => {
      // Hand-authored shape: the existing body bullet lives directly under the
      // H1 intro, with no `## Current files` heading. A regression guard for the
      // renderIndex prologue-skip bug where the new bullet was counted in
      // `added[]` but never written (orphan persisted, file rewritten identically).
      await writeFile(
        'knowledge/topics/agents/index.md',
        '# Agents\n\nConventions for agent configuration.\n\n' +
          '- [`agent-source-layout.md`](agent-source-layout.md) — *Decided source shape.* `[agents-md, scopes]`\n',
      );
      await writeFile(
        'knowledge/topics/agents/agent-source-layout.md',
        '# Agent source layout\n\nThe decided source shape for agent config.\n',
      );
      await writeFile(
        'knowledge/topics/agents/agedum-virtual-fs-launch.md',
        '# agedum virtual-FS launch\n\nHow agedum runs an agent CLI in a managed context.\n',
      );

      const report = await regenerateIndex(conceptionDir, knowledgeStrategy);

      const index = await readFile('knowledge/topics/agents/index.md');
      // The new bullet must actually be on disk...
      expect(index).toMatch(/- \[`agedum-virtual-fs-launch\.md`\]\(agedum-virtual-fs-launch\.md\)/);
      // ...the curated prologue bullet must survive verbatim...
      expect(index).toContain(
        '- [`agent-source-layout.md`](agent-source-layout.md) — *Decided source shape.* `[agents-md, scopes]`',
      );
      // ...the H1 intro is preserved...
      expect(index).toContain('# Agents');
      expect(index).toContain('Conventions for agent configuration.');
      // ...and the report's `added` matches what was written.
      const row = report.updated.find((u) => u.indexPath.endsWith('topics/agents/index.md'));
      expect(row?.added).toContain('agedum-virtual-fs-launch.md');
    });

    it('idempotent: a second run over a prologue-bullet index produces zero diff', async () => {
      await writeFile(
        'knowledge/topics/agents/index.md',
        '# Agents\n\nConventions for agent configuration.\n\n' +
          '- [`agent-source-layout.md`](agent-source-layout.md) — *Decided source shape.* `[agents-md, scopes]`\n',
      );
      await writeFile(
        'knowledge/topics/agents/agent-source-layout.md',
        '# Agent source layout\n\nThe decided source shape.\n',
      );
      await writeFile(
        'knowledge/topics/agents/agedum-virtual-fs-launch.md',
        '# agedum virtual-FS launch\n\nHow agedum runs an agent CLI.\n',
      );

      await regenerateIndex(conceptionDir, knowledgeStrategy);
      const first = await readFile('knowledge/topics/agents/index.md');
      const report2 = await regenerateIndex(conceptionDir, knowledgeStrategy);
      const second = await readFile('knowledge/topics/agents/index.md');
      expect(second).toBe(first);
      const row = report2.updated.find((u) => u.indexPath.endsWith('topics/agents/index.md'));
      expect(row).toBeUndefined();
    });
  });
});

describe('hand-written non-child bullets pass through verbatim', () => {
  it('preserves URL / cross-tree bullets byte-identically across a rewriting regen', async () => {
    const urlBullet = '- [Condash docs](https://condash.vcoeur.com) — public site.';
    const deepBullet = '- [Deep ref](../other/dir/file.md) — *cross-tree pointer.*';
    await writeFile(
      'knowledge/topics/index.md',
      [
        '# Topics',
        '',
        'Intro.',
        '',
        '## Current files',
        '',
        '- [`a-file.md`](a-file.md) — *Curated.* `[x]`',
        '',
        '## External links',
        '',
        urlBullet,
        deepBullet,
        '',
      ].join('\n'),
    );
    await writeFile('knowledge/topics/a-file.md', '# A\n\nBody A.\n');
    // A new on-disk child forces a real rewrite of the index.
    await writeFile('knowledge/topics/b-file.md', '# B\n\nBody B.\n');

    const report = await regenerateIndex(conceptionDir, knowledgeStrategy);
    const index = await readFile('knowledge/topics/index.md');

    // The hand-written bullets survive byte-identically...
    expect(index).toContain(urlBullet);
    expect(index).toContain(deepBullet);
    // ...are never reported dropped...
    const row = report.updated.find((u) => u.indexPath.endsWith('topics/index.md'));
    expect(row?.dropped ?? []).toEqual([]);
    // ...and the new child still got drafted.
    expect(index).toMatch(/- \[`b-file\.md`\]\(b-file\.md\)/);
    // The new bullet must not land in the hand-written links section.
    expect(index.indexOf('- [`b-file.md`]')).toBeLessThan(index.indexOf('## External links'));

    // Second run: full idempotence, byte-identical.
    const report2 = await regenerateIndex(conceptionDir, knowledgeStrategy);
    const index2 = await readFile('knowledge/topics/index.md');
    expect(index2).toBe(index);
    expect(report2.updated).toEqual([]);
  });
});

describe('stale dir-like bullet convergence', () => {
  it('drops a stale subdir bullet whose name lacks the trailing slash, and converges on run 2', async () => {
    // The bullet spells the dir `gone-dir` while the map keys the canonical
    // `gone-dir/` — the old delete-by-raw-name missed it, so the line was
    // never removed and every regen re-reported the same drop.
    await writeFile(
      'knowledge/index.md',
      [
        '# Knowledge',
        '',
        'Root.',
        '',
        '## Structure',
        '',
        '- [`topics/`](topics/index.md) — *Curated.* `[a]`',
        '- [`gone-dir`](gone-dir/index.md) — *Stale: the folder is gone.* `[b]`',
        '',
      ].join('\n'),
    );
    await writeFile('knowledge/topics/index.md', '# Topics\n\nIntro.\n\n## Current files\n');

    const report1 = await regenerateIndex(conceptionDir, knowledgeStrategy);
    const after1 = await readFile('knowledge/index.md');
    const row1 = report1.updated.find((u) => u.indexPath === 'knowledge/index.md');
    expect(row1?.dropped).toEqual(['gone-dir']);
    expect(after1).not.toContain('gone-dir');
    expect(after1).toContain('- [`topics/`](topics/index.md) — *Curated.* `[a]`');

    // Run 2 must be a no-op: nothing dropped, nothing rewritten.
    const report2 = await regenerateIndex(conceptionDir, knowledgeStrategy);
    const after2 = await readFile('knowledge/index.md');
    expect(after2).toBe(after1);
    expect(report2.updated).toEqual([]);
    expect(report2.unchanged).toContain('knowledge/index.md');
  });
});

describe('line-ending preservation', () => {
  it('keeps CRLF line endings when rewriting a CRLF-authored index', async () => {
    await writeFile(
      'knowledge/topics/index.md',
      ['# Topics', '', 'Intro.', '', '## Current files', ''].join('\r\n'),
    );
    await writeFile('knowledge/topics/a-file.md', '# A\n\nBody A.\n');

    await regenerateIndex(conceptionDir, knowledgeStrategy);
    const index = await readFile('knowledge/topics/index.md');

    expect(index).toMatch(/- \[`a-file\.md`\]\(a-file\.md\)/);
    expect(index).toContain('\r\n');
    // Every newline is CRLF — no lone LF introduced by the rewrite.
    expect(/[^\r]\n/.test(index)).toBe(false);
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
      // Tags must lead with kind, status, then app handles (the shared
      // `appHandle` normaliser keeps dots — `vcoeur.com`, not `vcoeur-com`).
      expect(monthIndex).toMatch(
        /- \[`2026-05-09-feature\/`\][^\n]+\*[^*]+\*\s+`\[project, now, condash, vcoeur\.com\]`/,
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
      // 200 chars whose tail array `["@condash"]` is split by the 200-char
      // cap — the clipped desc ends with `[` and no matching `]`, which used
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
