/**
 * Tests for the `stale-index` audit check — that a freshly regenerated tree is
 * clean, and that drift (a new unindexed body file, or a status-tag change)
 * surfaces an issue carrying the right tree's regen autofix action.
 */
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { knowledgeStrategy } from '../index-knowledge';
import { projectsStrategy } from '../index-projects';
import { regenerateIndex } from '../index-tree';
import { checkStaleIndex } from './stale-index';

let conceptionDir: string;

beforeEach(async () => {
  conceptionDir = await mkdtemp(join(tmpdir(), 'condash-stale-index-test-'));
});

afterEach(async () => {
  await rm(conceptionDir, { recursive: true, force: true });
});

async function writeFile(relPath: string, content: string): Promise<void> {
  const abs = join(conceptionDir, relPath);
  await fs.mkdir(join(abs, '..'), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
}

async function buildKnowledge(): Promise<void> {
  await writeFile(
    'knowledge/topics/index.md',
    '# Topics\n\nCross-cutting subjects.\n\n## Current files\n',
  );
  await writeFile(
    'knowledge/topics/sandbox-testing.md',
    '# Sandbox testing\n\nHow to drive vcoeur apps.\n\n## Recipe\n\nCall the binary.\n',
  );
}

async function buildProjectReadme(status: string): Promise<void> {
  await writeFile(
    'projects/2026-05/2026-05-09-feature/README.md',
    [
      '---',
      'date: 2026-05-09',
      'kind: project',
      `status: ${status}`,
      'apps:',
      '  - condash',
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

describe('checkStaleIndex', () => {
  it('returns no issues for a freshly regenerated tree', async () => {
    await buildKnowledge();
    await buildProjectReadme('now');
    await regenerateIndex(conceptionDir, knowledgeStrategy);
    await regenerateIndex(conceptionDir, projectsStrategy);

    expect(await checkStaleIndex(conceptionDir)).toEqual([]);
  });

  it('flags a knowledge index left stale by a new unindexed body file', async () => {
    await buildKnowledge();
    await regenerateIndex(conceptionDir, knowledgeStrategy);
    await writeFile('knowledge/topics/fresh-topic.md', '# Fresh topic\n\nBrand new material.\n');

    const issues = await checkStaleIndex(conceptionDir);
    const knowledge = issues.filter((i) => i.fix.action === 'run_knowledge_index');
    expect(knowledge.length).toBeGreaterThan(0);
    expect(knowledge[0].check).toBe('stale-index');
    expect(knowledge[0].severity).toBe('warn');
    expect(knowledge[0].fix.autoFix).toBe(true);
    expect(knowledge.some((i) => (i.file ?? '').includes('knowledge/topics/index.md'))).toBe(true);
  });

  it('flags a projects index left stale by a status-tag change', async () => {
    await buildProjectReadme('now');
    await regenerateIndex(conceptionDir, projectsStrategy);
    await buildProjectReadme('review');

    const issues = await checkStaleIndex(conceptionDir);
    const projects = issues.filter((i) => i.fix.action === 'run_projects_index');
    expect(projects.length).toBeGreaterThan(0);
    expect(projects[0].check).toBe('stale-index');
    expect(projects[0].fix.autoFix).toBe(true);
  });
});
