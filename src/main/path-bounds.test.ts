/**
 * Trust-boundary tests for the path-bounding primitives. These guard the
 * IPC choke point: every renderer-supplied path must resolve (realpath)
 * under an allowed root before any fs/shell work happens.
 *
 * Layout per test: a tmp tree with a `conception/` root, an `outside/`
 * sibling holding a "secret", plus optional `workspace/` and `worktrees/`
 * roots for the multi-root checks. Settings + effective config are mocked;
 * the user-scope roots are steered via their env overrides.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface TestGlobals {
  __testConception?: string | null;
  __testConfig?: Record<string, unknown>;
}
const testGlobals = globalThis as TestGlobals;

vi.mock('./settings', () => ({
  readSettings: vi.fn(async () => ({
    lastConceptionPath: testGlobals.__testConception ?? null,
    recentConceptionPaths: [],
  })),
}));

vi.mock('./effective-config', () => ({
  getEffectiveConceptionConfig: vi.fn(async () => testGlobals.__testConfig ?? {}),
}));

import {
  requirePathUnder,
  requirePathUnderWorkspace,
  requireReadableSkillPath,
} from './path-bounds';

let tmp: string;
let conception: string;
let outside: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'condash-path-bounds-'));
  conception = join(tmp, 'conception');
  outside = join(tmp, 'outside');
  mkdirSync(conception, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(conception, 'note.md'), 'inside\n');
  writeFileSync(join(outside, 'secret.txt'), 'secret\n');
  testGlobals.__testConception = conception;
  testGlobals.__testConfig = {};
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete testGlobals.__testConception;
  delete testGlobals.__testConfig;
  delete process.env.CONDASH_USER_SKILLS_ROOT;
  delete process.env.CONDASH_USER_AGENTS_MD;
});

describe('requirePathUnder', () => {
  it('accepts a real file under the root and returns its realpath', async () => {
    const real = await requirePathUnder(join(conception, 'note.md'), conception);
    expect(real).toBe(await fs.realpath(join(conception, 'note.md')));
  });

  it('rejects a non-existent path', async () => {
    await expect(requirePathUnder(join(conception, 'missing.md'), conception)).rejects.toThrow(
      /does not resolve/,
    );
  });

  it('rejects a symlink under the root that points outside it', async () => {
    symlinkSync(join(outside, 'secret.txt'), join(conception, 'link.md'));
    await expect(requirePathUnder(join(conception, 'link.md'), conception)).rejects.toThrow(
      /outside the conception tree/,
    );
  });

  it('rejects `..` traversal that escapes the root', async () => {
    await expect(
      requirePathUnder(join(conception, '..', 'outside', 'secret.txt'), conception),
    ).rejects.toThrow(/outside the conception tree/);
  });

  it('does not treat a sibling sharing the root as a prefix as inside', async () => {
    // `/x/conception-evil` must not pass a bound against `/x/conception`.
    const evil = `${conception}-evil`;
    mkdirSync(evil);
    writeFileSync(join(evil, 'f.md'), 'x\n');
    await expect(requirePathUnder(join(evil, 'f.md'), conception)).rejects.toThrow(
      /outside the conception tree/,
    );
  });
});

describe('requirePathUnderWorkspace (multi-root)', () => {
  it('accepts paths under each configured root and nothing else', async () => {
    const workspace = join(tmp, 'workspace');
    const worktrees = join(tmp, 'worktrees');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(worktrees, { recursive: true });
    writeFileSync(join(workspace, 'repo.txt'), 'x\n');
    writeFileSync(join(worktrees, 'wt.txt'), 'x\n');
    testGlobals.__testConfig = { workspace_path: workspace, worktrees_path: worktrees };

    await expect(requirePathUnderWorkspace(join(conception, 'note.md'))).resolves.toBe(
      await fs.realpath(join(conception, 'note.md')),
    );
    await expect(requirePathUnderWorkspace(join(workspace, 'repo.txt'))).resolves.toBeTruthy();
    await expect(requirePathUnderWorkspace(join(worktrees, 'wt.txt'))).resolves.toBeTruthy();
    // The outside sibling exists but is under no configured root.
    await expect(requirePathUnderWorkspace(join(outside, 'secret.txt'))).rejects.toThrow(
      /outside the workspace/,
    );
  });

  it('skips configured roots that do not exist instead of throwing', async () => {
    const worktrees = join(tmp, 'worktrees');
    mkdirSync(worktrees, { recursive: true });
    writeFileSync(join(worktrees, 'wt.txt'), 'x\n');
    testGlobals.__testConfig = {
      workspace_path: join(tmp, 'never-created'),
      worktrees_path: worktrees,
    };
    await expect(requirePathUnderWorkspace(join(worktrees, 'wt.txt'))).resolves.toBeTruthy();
  });

  it('throws when no conception path is set', async () => {
    testGlobals.__testConception = null;
    await expect(requirePathUnderWorkspace(join(outside, 'secret.txt'))).rejects.toThrow(
      /no conception path is set/,
    );
  });
});

describe('requireReadableSkillPath', () => {
  let skillsRoot: string;
  let agentsMd: string;

  beforeEach(() => {
    const agentsDir = join(tmp, 'agents');
    skillsRoot = join(agentsDir, 'skills');
    agentsMd = join(agentsDir, 'AGENTS.md');
    mkdirSync(skillsRoot, { recursive: true });
    writeFileSync(join(skillsRoot, 'SKILL.md'), 'skill\n');
    writeFileSync(agentsMd, 'agents\n');
    // A sibling dotfile next to AGENTS.md — readable through neither the
    // dir allowlist nor the exact-file allowlist.
    writeFileSync(join(agentsDir, '.secrets.env'), 'KEY=value\n');
    process.env.CONDASH_USER_SKILLS_ROOT = skillsRoot;
    process.env.CONDASH_USER_AGENTS_MD = agentsMd;
  });

  it('accepts files under the user-scope skills root', async () => {
    await expect(requireReadableSkillPath(join(skillsRoot, 'SKILL.md'))).resolves.toBe(
      await fs.realpath(join(skillsRoot, 'SKILL.md')),
    );
  });

  it('accepts the exact user-scope AGENTS.md', async () => {
    await expect(requireReadableSkillPath(agentsMd)).resolves.toBe(await fs.realpath(agentsMd));
  });

  it('accepts files under the active conception', async () => {
    await expect(requireReadableSkillPath(join(conception, 'note.md'))).resolves.toBeTruthy();
  });

  it('refuses sibling dotfiles next to the allowlisted file', async () => {
    await expect(requireReadableSkillPath(join(tmp, 'agents', '.secrets.env'))).rejects.toThrow(
      /not a readable skills location/,
    );
  });

  it('refuses non-existent paths', async () => {
    await expect(requireReadableSkillPath(join(skillsRoot, 'missing.md'))).rejects.toThrow(
      /does not resolve/,
    );
  });
});
