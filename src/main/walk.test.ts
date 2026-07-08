/**
 * Tests for findProjectReadmes: after the S1 parallelization (per-month and
 * per-item probes run under Promise.all instead of a serial await-in-loop), the
 * output must still be month-then-slug sorted, skip item dirs without a README,
 * and ignore dot-directories at both levels.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { findProjectReadmes } from './walk';

describe('findProjectReadmes', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'condash-walk-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function makeProject(month: string, slug: string, withReadme = true): Promise<void> {
    const projectDir = join(dir, 'projects', month, slug);
    await mkdir(projectDir, { recursive: true });
    if (withReadme) await writeFile(join(projectDir, 'README.md'), '# x\n', 'utf8');
  }

  it('returns READMEs in sorted month-then-slug order regardless of creation order', async () => {
    // Create out of order so the assertion proves the sort, not insertion order.
    await makeProject('2026-07', '2026-07-02-b');
    await makeProject('2026-07', '2026-07-01-a');
    await makeProject('2026-06', '2026-06-15-c');
    const readmes = await findProjectReadmes(dir);
    expect(readmes.map((p) => relative(dir, p))).toEqual([
      join('projects', '2026-06', '2026-06-15-c', 'README.md'),
      join('projects', '2026-07', '2026-07-01-a', 'README.md'),
      join('projects', '2026-07', '2026-07-02-b', 'README.md'),
    ]);
  });

  it('skips item dirs without a README', async () => {
    await makeProject('2026-07', 'has-readme', true);
    await makeProject('2026-07', 'no-readme', false);
    const readmes = await findProjectReadmes(dir);
    expect(readmes).toHaveLength(1);
    expect(readmes[0]).toContain('has-readme');
  });

  it('returns [] when there is no projects directory', async () => {
    expect(await findProjectReadmes(dir)).toEqual([]);
  });

  it('ignores dot-directories at both the month and item levels', async () => {
    await makeProject('2026-07', 'real');
    await mkdir(join(dir, 'projects', '.hidden-month', 'x'), { recursive: true });
    await writeFile(join(dir, 'projects', '.hidden-month', 'x', 'README.md'), '# x\n', 'utf8');
    await mkdir(join(dir, 'projects', '2026-07', '.hidden-item'), { recursive: true });
    await writeFile(join(dir, 'projects', '2026-07', '.hidden-item', 'README.md'), '# x\n', 'utf8');
    const readmes = await findProjectReadmes(dir);
    expect(readmes).toHaveLength(1);
    expect(readmes[0]).toContain('real');
  });
});
