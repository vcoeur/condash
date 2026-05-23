import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readKimiSkillsTree, readSkillsTree, readSkillsTreeForTab } from './skills';

let tmp: string;

const USER_ENV_KEYS = [
  'CONDASH_USER_SKILLS_ROOT',
  'CONDASH_USER_CLAUDE_ROOT',
  'CONDASH_USER_KIMI_ROOT',
  'CONDASH_USER_OPENCODE_ROOT',
  'CONDASH_USER_AGENT_CONFIG_ROOT',
  'CONDASH_USER_CLAUDE_AGENT_OUTPUT',
  'CONDASH_USER_KIMI_AGENT_OUTPUT',
  'CONDASH_USER_OPENCODE_AGENT_OUTPUT',
] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'condash-skills-'));
  savedEnv = {};
  for (const key of USER_ENV_KEYS) savedEnv[key] = process.env[key];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const key of USER_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function setupSkills(): void {
  mkdirSync(join(tmp, '.claude'));
  mkdirSync(join(tmp, '.claude', 'skills'));
  mkdirSync(join(tmp, '.claude', 'skills', 'projects'));
  mkdirSync(join(tmp, '.claude', 'skills', 'projects', 'subdir'));
  writeFileSync(
    join(tmp, '.claude', 'skills', 'projects', 'SKILL.md'),
    '# Projects skill\n\nLead paragraph.\n',
  );
  writeFileSync(
    join(tmp, '.claude', 'skills', 'projects', 'create.md'),
    '# Create\n\nCreate notes.\n',
  );
  writeFileSync(join(tmp, '.claude', 'skills', 'projects', 'subdir', 'deep.md'), '# Deep helper\n');
  writeFileSync(join(tmp, '.claude', 'skills', 'projects', 'image.png'), 'binary');
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('readSkillsTree', () => {
  it('returns null when the directory is missing', async () => {
    const tree = await readSkillsTree(tmp, '.claude/skills');
    expect(tree).toBeNull();
  });

  it('only surfaces .md files and recurses', async () => {
    setupSkills();
    const tree = (await readSkillsTree(tmp, '.claude/skills'))!;
    const projects = tree.children?.[0];
    expect(projects?.name).toBe('projects');
    const fileNames = (projects?.children ?? []).map((c) => c.name).sort();
    // 'image.png' must not appear.
    expect(fileNames).toEqual(['SKILL.md', 'create.md', 'subdir']);
    const subdir = (projects?.children ?? []).find((c) => c.name === 'subdir');
    expect(subdir?.children?.[0]?.name).toBe('deep.md');
  });

  it('parses title + summary for SKILL.md', async () => {
    setupSkills();
    const tree = (await readSkillsTree(tmp, '.claude/skills'))!;
    const skill = tree.children?.[0]?.children?.find((c) => c.name === 'SKILL.md');
    expect(skill?.title).toBe('Projects skill');
    expect(skill?.summary).toContain('Lead paragraph');
  });

  it('does not stamp files when no manifest is present', async () => {
    setupSkills();
    const tree = (await readSkillsTree(tmp, '.claude/skills'))!;
    const skill = tree.children?.[0]?.children?.find((c) => c.name === 'SKILL.md');
    expect(skill?.shipped).toBeUndefined();
  });

  it('stamps tracked files and detects divergence', async () => {
    setupSkills();
    const onDiskBody = '# Projects skill\n\nLead paragraph.\n';
    const skillDiskSha = sha(onDiskBody);
    const manifest = {
      version: 1,
      skills: {
        projects: {
          files: {
            'SKILL.md': { sha256: skillDiskSha, shippedVersion: '2.10.15' },
            'create.md': { sha256: 'deadbeef', shippedVersion: '2.10.15' },
          },
        },
      },
    };
    writeFileSync(join(tmp, '.claude', 'skills', '.condash-skills.json'), JSON.stringify(manifest));

    const tree = (await readSkillsTree(tmp, '.claude/skills'))!;
    const projects = tree.children?.[0];
    const skill = projects?.children?.find((c) => c.name === 'SKILL.md');
    expect(skill?.shipped).toBeDefined();
    expect(skill?.shipped?.diverged).toBe(false);
    expect(skill?.shipped?.shippedVersion).toBe('2.10.15');

    const create = projects?.children?.find((c) => c.name === 'create.md');
    expect(create?.shipped?.diverged).toBe(true);
  });

  it('degrades silently with a malformed manifest', async () => {
    setupSkills();
    writeFileSync(join(tmp, '.claude', 'skills', '.condash-skills.json'), '{not-json');
    const tree = (await readSkillsTree(tmp, '.claude/skills'))!;
    const skill = tree.children?.[0]?.children?.find((c) => c.name === 'SKILL.md');
    expect(skill?.shipped).toBeUndefined();
  });

  it('injects synthetic CLAUDE.md entries when present at the conception root', async () => {
    setupSkills();
    writeFileSync(join(tmp, 'CLAUDE.md'), '# Project CLAUDE\n\nProject-level rules.\n');
    writeFileSync(join(tmp, '.claude', 'CLAUDE.md'), '# Inner CLAUDE\n\nClaude-dir rules.\n');
    const tree = (await readSkillsTree(tmp, '.claude/skills'))!;
    const claude = (tree.children ?? []).filter((c) => c.name === 'CLAUDE.md');
    // Both candidates surface, in stable order (root first, then `.claude/`).
    expect(claude.length).toBe(2);
    expect(claude[0]?.title).toBe('Project CLAUDE');
    expect(claude[0]?.path).toContain('CLAUDE.md');
    expect(claude[0]?.relPath.startsWith('__claude__/')).toBe(true);
    expect(claude[1]?.title).toBe('Inner CLAUDE');
  });

  it('skips CLAUDE.md when neither location exists', async () => {
    setupSkills();
    const tree = (await readSkillsTree(tmp, '.claude/skills'))!;
    const claude = (tree.children ?? []).filter((c) => c.name === 'CLAUDE.md');
    expect(claude.length).toBe(0);
  });
});

function setupKimiSkills(): void {
  mkdirSync(join(tmp, '.kimi'));
  mkdirSync(join(tmp, '.kimi', 'skills'));
  mkdirSync(join(tmp, '.kimi', 'skills', 'projects'));
  writeFileSync(
    join(tmp, '.kimi', 'skills', 'projects', 'SKILL.md'),
    '# Projects skill\n\nLead paragraph.\n',
  );
}

describe('readKimiSkillsTree', () => {
  it('returns null when the directory is missing', async () => {
    const tree = await readKimiSkillsTree(tmp);
    expect(tree).toBeNull();
  });

  it('injects synthetic AGENTS.md entries when present at the conception root', async () => {
    setupKimiSkills();
    writeFileSync(join(tmp, 'AGENTS.md'), '# Project AGENTS\n\nProject-level rules.\n');
    writeFileSync(join(tmp, '.kimi', 'AGENTS.md'), '# Inner AGENTS\n\nKimi-dir rules.\n');
    const tree = (await readKimiSkillsTree(tmp))!;
    const agents = (tree.children ?? []).filter((c) => c.name === 'AGENTS.md');
    // Both candidates surface, in stable order (root first, then `.kimi/`).
    expect(agents.length).toBe(2);
    expect(agents[0]?.title).toBe('Project AGENTS');
    expect(agents[0]?.path).toContain('AGENTS.md');
    expect(agents[0]?.relPath.startsWith('__kimi__/')).toBe(true);
    expect(agents[1]?.title).toBe('Inner AGENTS');
    expect(agents[1]?.relPath).toBe('__kimi__/.kimi/AGENTS.md');
  });

  it('skips AGENTS.md when neither location exists', async () => {
    setupKimiSkills();
    const tree = (await readKimiSkillsTree(tmp))!;
    const agents = (tree.children ?? []).filter((c) => c.name === 'AGENTS.md');
    expect(agents.length).toBe(0);
  });

  it('surfaces only the `.kimi/AGENTS.md` entry when the conception root lacks AGENTS.md', async () => {
    setupKimiSkills();
    writeFileSync(join(tmp, '.kimi', 'AGENTS.md'), '# Inner AGENTS\n\nKimi-dir rules.\n');
    const tree = (await readKimiSkillsTree(tmp))!;
    const agents = (tree.children ?? []).filter((c) => c.name === 'AGENTS.md');
    expect(agents.length).toBe(1);
    expect(agents[0]?.relPath).toBe('__kimi__/.kimi/AGENTS.md');
  });
});

describe('Generic agent-config sources (local scope)', () => {
  it('injects common.md + <model>.md sources with uppercase badges', async () => {
    mkdirSync(join(tmp, '.agents', 'agents'), { recursive: true });
    mkdirSync(join(tmp, '.agents', 'skills', 'commit'), { recursive: true });
    writeFileSync(join(tmp, '.agents', 'agents', 'common.md'), '# Common\n\nShared base.\n');
    writeFileSync(join(tmp, '.agents', 'agents', 'claude.md'), '# Claude overlay\n');
    writeFileSync(join(tmp, '.agents', 'agents', 'kimi.md'), '# Kimi overlay\n');
    writeFileSync(join(tmp, '.agents', 'skills', 'commit', 'spec.yaml'), 'description: commit\n');

    const tree = (await readSkillsTreeForTab('local', tmp, 'generic', ''))!;
    const sources = (tree.children ?? []).filter((c) => c.relPath.startsWith('__agents__/'));
    const byName = Object.fromEntries(sources.map((c) => [c.name, c]));
    // opencode.md is absent → not surfaced; the three present sources are.
    expect(Object.keys(byName).sort()).toEqual(['claude.md', 'common.md', 'kimi.md']);
    expect(byName['common.md']?.badge).toBe('COMMON');
    expect(byName['claude.md']?.badge).toBe('CLAUDE');
    expect(byName['common.md']?.title).toBe('Common');
    // The skillspec tree still follows the sources.
    expect((tree.children ?? []).some((c) => c.name === 'commit')).toBe(true);
  });
});

describe('global scope', () => {
  function setupGlobal(): void {
    // Generic source skills + agent-config sources.
    mkdirSync(join(tmp, 'g-skills', 'pr'), { recursive: true });
    writeFileSync(join(tmp, 'g-skills', 'pr', 'spec.yaml'), 'description: pr\n');
    mkdirSync(join(tmp, 'g-agents'), { recursive: true });
    writeFileSync(join(tmp, 'g-agents', 'common.md'), '# Global common\n');
    writeFileSync(join(tmp, 'g-agents', 'kimi.md'), '# Global kimi\n');
    // Per-model compiled skill trees + agent-config outputs.
    mkdirSync(join(tmp, 'c-skills', 'commit'), { recursive: true });
    writeFileSync(join(tmp, 'c-skills', 'commit', 'SKILL.md'), '# Commit\n\nCommit skill.\n');
    mkdirSync(join(tmp, 'k-skills'), { recursive: true });
    mkdirSync(join(tmp, 'o-skills'), { recursive: true });
    // Outputs keep their canonical basenames (CLAUDE.md / global-agent.yaml /
    // AGENTS.md) so the surfaced node `name` matches production.
    mkdirSync(join(tmp, 'claude-out'), { recursive: true });
    mkdirSync(join(tmp, 'kimi-out'), { recursive: true });
    mkdirSync(join(tmp, 'oc-out'), { recursive: true });
    writeFileSync(join(tmp, 'claude-out', 'CLAUDE.md'), '# Global CLAUDE\n\nGlobal rules.\n');
    writeFileSync(
      join(tmp, 'kimi-out', 'global-agent.yaml'),
      'agent:\n  system_prompt_args:\n    ROLE_ADDITIONAL: hi\n',
    );
    writeFileSync(join(tmp, 'oc-out', 'AGENTS.md'), '# Global OpenCode AGENTS\n');

    process.env.CONDASH_USER_SKILLS_ROOT = join(tmp, 'g-skills');
    process.env.CONDASH_USER_AGENT_CONFIG_ROOT = join(tmp, 'g-agents');
    process.env.CONDASH_USER_CLAUDE_ROOT = join(tmp, 'c-skills');
    process.env.CONDASH_USER_KIMI_ROOT = join(tmp, 'k-skills');
    process.env.CONDASH_USER_OPENCODE_ROOT = join(tmp, 'o-skills');
    process.env.CONDASH_USER_CLAUDE_AGENT_OUTPUT = join(tmp, 'claude-out', 'CLAUDE.md');
    process.env.CONDASH_USER_KIMI_AGENT_OUTPUT = join(tmp, 'kimi-out', 'global-agent.yaml');
    process.env.CONDASH_USER_OPENCODE_AGENT_OUTPUT = join(tmp, 'oc-out', 'AGENTS.md');
  }

  it('reads the generic global tree with agent-config sources', async () => {
    setupGlobal();
    const tree = (await readSkillsTreeForTab('global', tmp, 'generic', ''))!;
    const sources = (tree.children ?? []).filter((c) => c.relPath.startsWith('__agents__/'));
    expect(sources.map((c) => c.name).sort()).toEqual(['common.md', 'kimi.md']);
    expect(sources.find((c) => c.name === 'common.md')?.badge).toBe('COMMON');
    // The .yaml skillspec is surfaced (Generic accepts yaml).
    expect((tree.children ?? []).some((c) => c.name === 'pr')).toBe(true);
  });

  it('injects the compiled CLAUDE.md on the global Claude tab', async () => {
    setupGlobal();
    const tree = (await readSkillsTreeForTab('global', tmp, 'claude', ''))!;
    const claude = (tree.children ?? []).find((c) => c.relPath.startsWith('__claude__/'));
    expect(claude?.badge).toBe('CLAUDE');
    expect(claude?.title).toBe('Global CLAUDE');
    expect((tree.children ?? []).some((c) => c.name === 'commit')).toBe(true);
  });

  it('injects global-agent.yaml on the global Kimi tab with a KIMI badge', async () => {
    setupGlobal();
    const tree = (await readSkillsTreeForTab('global', tmp, 'kimi', ''))!;
    const kimi = (tree.children ?? []).find((c) => c.relPath.startsWith('__kimi__/'));
    expect(kimi?.badge).toBe('KIMI');
    expect(kimi?.name).toBe('global-agent.yaml');
  });

  it('injects AGENTS.md on the global OpenCode tab', async () => {
    setupGlobal();
    const tree = (await readSkillsTreeForTab('global', tmp, 'opencode', ''))!;
    const oc = (tree.children ?? []).find((c) => c.relPath.startsWith('__opencode__/'));
    expect(oc?.badge).toBe('AGENTS');
    expect(oc?.name).toBe('AGENTS.md');
  });

  it('surfaces a synthetic root when only the agent-config file exists (no skills dir)', async () => {
    setupGlobal();
    rmSync(join(tmp, 'c-skills'), { recursive: true, force: true });
    const tree = await readSkillsTreeForTab('global', tmp, 'claude', '');
    expect(tree).not.toBeNull();
    expect((tree?.children ?? []).some((c) => c.badge === 'CLAUDE')).toBe(true);
  });

  it('returns null when neither the skills dir nor the config file exists', async () => {
    setupGlobal();
    rmSync(join(tmp, 'o-skills'), { recursive: true, force: true });
    rmSync(join(tmp, 'oc-out', 'AGENTS.md'), { force: true });
    const tree = await readSkillsTreeForTab('global', tmp, 'opencode', '');
    expect(tree).toBeNull();
  });
});
