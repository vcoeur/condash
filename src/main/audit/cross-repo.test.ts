/**
 * Tests for the `cross-repo` audit check — sibling-app instruction files
 * (AGENTS.md and the legacy CLAUDE.md forms) whose relative references into
 * the conception tree no longer resolve.
 */
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkCrossRepo } from './cross-repo';

let baseDir: string;
let workspaceDir: string;
let conceptionDir: string;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'condash-cross-repo-test-'));
  workspaceDir = join(baseDir, 'ws');
  conceptionDir = join(workspaceDir, 'conception');
  await fs.mkdir(conceptionDir, { recursive: true });
  await fs.mkdir(join(conceptionDir, '.condash'), { recursive: true });
  await fs.writeFile(
    join(conceptionDir, '.condash', 'settings.json'),
    JSON.stringify({ workspace_path: workspaceDir }) + '\n',
    'utf8',
  );
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

async function writeSibling(relPath: string, content: string): Promise<void> {
  const abs = join(workspaceDir, relPath);
  await fs.mkdir(join(abs, '..'), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
}

describe('checkCrossRepo', () => {
  it('flags a dangling conception reference in a sibling AGENTS.md', async () => {
    await writeSibling('app-a/AGENTS.md', 'Docs live in [the tree](../conception/missing.md).\n');

    const issues = await checkCrossRepo(conceptionDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].check).toBe('cross-repo');
    expect(issues[0].severity).toBe('warn');
    expect(issues[0].file).toBe(join(workspaceDir, 'app-a', 'AGENTS.md'));
    expect(issues[0].line).toBe(1);
    expect(issues[0].fix.action).toBe('flag_for_user_edit');
    expect(issues[0].fix.autoFix).toBe(false);
    expect(issues[0].fix.ref).toBe('../conception/missing.md');
  });

  it('scans every instruction file a repo carries — AGENTS.md and CLAUDE.md both', async () => {
    await writeSibling('app-b/AGENTS.md', 'See [a](../conception/gone-a.md).\n');
    await writeSibling('app-b/CLAUDE.md', 'See [b](../conception/gone-b.md).\n');

    const issues = await checkCrossRepo(conceptionDir);
    expect(issues).toHaveLength(2);
    expect(issues.map((issue) => issue.file).sort()).toEqual(
      [join(workspaceDir, 'app-b', 'AGENTS.md'), join(workspaceDir, 'app-b', 'CLAUDE.md')].sort(),
    );
  });

  it('finds AGENTS.md one level down in monorepo layouts', async () => {
    await writeSibling('app-c/packages/AGENTS.md', 'See [x](../conception/deep.md).\n');

    const issues = await checkCrossRepo(conceptionDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].file).toBe(join(workspaceDir, 'app-c', 'packages', 'AGENTS.md'));
  });

  it('returns no issues when every reference resolves', async () => {
    await fs.writeFile(join(conceptionDir, 'live.md'), '# Live\n', 'utf8');
    await writeSibling('app-d/AGENTS.md', 'See [live](../conception/live.md).\n');
    await writeSibling('app-d/CLAUDE.md', 'Legacy copy, no refs.\n');

    expect(await checkCrossRepo(conceptionDir)).toEqual([]);
  });
});
