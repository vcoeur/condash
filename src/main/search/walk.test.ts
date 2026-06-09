import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectKnowledgeBodyFiles,
  collectKnowledgeFiles,
  collectKnowledgeIndexFiles,
  collectProjectFiles,
  SKIP_DIR_NAMES,
} from './walk';

describe('search walkers', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'condash-walk-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('collects knowledge under a dotted ancestor directory', async () => {
    // The ignore regex must apply to the path relative to the knowledge root;
    // matching the absolute path would zero out every file when the
    // conception lives under e.g. `~/.conceptions/x`.
    const knowledgeRoot = join(root, '.conceptions', 'x', 'knowledge');
    await mkdir(join(knowledgeRoot, 'topics'), { recursive: true });
    const body = join(knowledgeRoot, 'topics', 'a.md');
    const index = join(knowledgeRoot, 'index.md');
    await writeFile(body, '# A\n');
    await writeFile(index, '# Index\n');

    expect((await collectKnowledgeFiles(knowledgeRoot)).sort()).toEqual([index, body].sort());
    expect(await collectKnowledgeBodyFiles(knowledgeRoot)).toEqual([body]);
    expect(await collectKnowledgeIndexFiles(knowledgeRoot)).toEqual([index]);
  });

  it('still skips dot-prefixed segments below the knowledge root', async () => {
    const knowledgeRoot = join(root, 'knowledge');
    await mkdir(join(knowledgeRoot, '.hidden'), { recursive: true });
    await writeFile(join(knowledgeRoot, 'a.md'), '# A\n');
    await writeFile(join(knowledgeRoot, '.hidden', 'b.md'), '# B\n');
    expect(await collectKnowledgeFiles(knowledgeRoot)).toEqual([join(knowledgeRoot, 'a.md')]);
  });

  it('skips every SKIP_DIR_NAMES dir, including dist and target', async () => {
    // Parity guard with the watcher's ignore rules: files the watcher never
    // reports events for must not be indexed either.
    expect(SKIP_DIR_NAMES.has('dist')).toBe(true);
    expect(SKIP_DIR_NAMES.has('target')).toBe(true);

    const projectsRoot = join(root, 'projects');
    const item = join(projectsRoot, '2026-06', '2026-06-01-x');
    await mkdir(item, { recursive: true });
    await writeFile(join(item, 'README.md'), '# X\n');
    for (const skip of SKIP_DIR_NAMES) {
      await mkdir(join(item, skip), { recursive: true });
      await writeFile(join(item, skip, 'doc.md'), '# skipped\n');
    }

    const files = await collectProjectFiles(projectsRoot);
    expect(files.map((f) => f.path)).toEqual([join(item, 'README.md')]);
    expect(files[0].projectPath).toBe(item);
  });
});
